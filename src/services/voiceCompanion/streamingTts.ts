/**
 * 语音伙伴 TTS 朗读控制器（预取流水线版）
 *
 * 在 ttsService 的 synthesize / playBlob 解耦能力之上，实现「按句切分 + 流水线播放」：
 *
 *   合成线: [合成1] [合成2] [合成3] ...        ← 始终领先播放线 PREFETCH_DEPTH 句
 *   播放线:        [播放1] [播放2] [播放3] ... ← 句间无缝衔接，无合成等待间隙
 *
 * - 播放第 N 句的同时并发预取合成第 N+1/N+2 句，消除旧版「播完一句等下一句合成」的静默间隙；
 * - Phase 2：enqueueDelta() + flush() 支持 AI 流式增量逐句朗读——首句一到句末标点
 *   即开始合成播放，无需等待整段回复完成；
 * - 未闭合的 ``` 代码围栏内容会被缓冲到围栏闭合后整体清洗，避免把代码念出来；
 * - stop() 原子打断：清队列 + abort 在途合成 + generation 失效旧结果；
 * - 每句播放带超时兜底，防止异常下队列卡死。
 */

import { ttsService } from '../ttsService';
import { cleanTextForSpeech } from '../ttsTextFilter';
import type { TTSVoice } from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('VoiceTts');

/** 预取深度：播放当前句时，保持最多 N 句在合成中/已合成 */
const PREFETCH_DEPTH = 2;

/** 单句合成等待上限（毫秒），超时则降级到串行 speak 兜底 */
const SYNTH_TIMEOUT_MS = 12000;

/** 按句末标点切分句子（保留可朗读的语义单元） */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 估算单句最长播放等待（合成缓冲 + 文本时长），用于超时兜底（毫秒） */
function estimateMaxDuration(text: string): number {
  return Math.min(15000, 3000 + text.length * 400);
}

/**
 * 从流式缓冲中提取「可以安全朗读」的前缀：
 * - 只在句末标点处切分（句子完整才朗读）；
 * - 若存在未闭合的 ``` 代码围栏，围栏起点之后的内容全部继续缓冲，
 *   等闭合后由 cleanTextForSpeech 整体移除，避免把半截代码当句子念出来。
 */
function extractReadyText(buffer: string): { ready: string; rest: string } {
  // 安全区：未闭合围栏起点之前的部分
  let safeEnd = buffer.length;
  const fences = [...buffer.matchAll(/```/g)];
  if (fences.length % 2 === 1) {
    safeEnd = fences[fences.length - 1].index ?? 0;
  }

  // 安全区内找最后一个句末标点（贪婪匹配到最后一个）
  const safe = buffer.slice(0, safeEnd);
  const m = safe.match(/[\s\S]*[。！？!?；;\n]/);
  if (!m) {
    return { ready: '', rest: buffer };
  }
  const cut = m[0].length;
  return { ready: buffer.slice(0, cut), rest: buffer.slice(cut) };
}

/** 队列项：句子文本 + 预取中的合成结果 */
interface QueueItem {
  text: string;
  audio?: Promise<Blob | null>;
}

class VoiceTtsController {
  private queue: QueueItem[] = [];
  /** Phase 2：流式增量缓冲（原始 markdown，按句提取） */
  private pendingDelta = '';
  /** Phase 2：增量流是否仍在进行（true 时队列暂空不算播完，不触发 onDone） */
  private streamOpen = false;
  private draining = false;
  /** onStart 已触发且尚未触发 onDone/stop（保证 onStart/onDone 成对） */
  private started = false;
  /** 打断代际：stop() 自增，使在途合成/播放结果失效 */
  private generation = 0;
  private abortController: AbortController | null = null;
  private voice?: TTSVoice;
  private rate?: string;

  /** 开始朗读（从静止到发声）时触发 */
  onStart?: () => void;
  /** 队列全部播放完毕且增量流已结束（非打断）时触发 */
  onDone?: () => void;

  /** 是否正在朗读 */
  get isActive(): boolean {
    return this.draining || this.queue.length > 0;
  }

  /**
   * 朗读一段完整文本：清洗 → 切句 → 流水线播放
   * Promise 在本次入队的内容全部播放完毕后 resolve（保持旧版语义）
   */
  async speak(text: string, options?: { voice?: TTSVoice; rate?: string }): Promise<void> {
    const clean = cleanTextForSpeech(text);
    if (!clean) {
      log.debug('清洗后文本为空，跳过朗读');
      return;
    }
    this.setOptions(options);
    await this.enqueue(splitSentences(clean));
  }

  /**
   * Phase 2：流式增量入队
   *
   * AI 回复流式生成期间持续调用；缓冲增量文本，一旦凑出完整句子
   * （且不在未闭合代码围栏内）立即清洗入队开始合成播放。
   * 流结束后必须调用 flush()。
   */
  enqueueDelta(delta: string, options?: { voice?: TTSVoice; rate?: string }): void {
    if (!delta) return;
    this.setOptions(options);
    this.streamOpen = true;
    this.pendingDelta += delta;

    const { ready, rest } = extractReadyText(this.pendingDelta);
    this.pendingDelta = rest;
    if (ready) {
      const clean = cleanTextForSpeech(ready);
      if (clean) {
        void this.enqueue(splitSentences(clean));
      }
    }
  }

  /**
   * Phase 2：增量流结束
   *
   * 朗读缓冲中剩余的不完整句子；若全部内容已播完则立即触发 onDone。
   */
  flush(): void {
    this.streamOpen = false;
    const restRaw = this.pendingDelta;
    this.pendingDelta = '';

    const clean = cleanTextForSpeech(restRaw);
    if (clean) {
      void this.enqueue(splitSentences(clean));
    } else if (!this.draining && this.queue.length === 0) {
      // 队列已在 flush 前播空 → 此刻才算真正"播完"
      this.fireDone();
    }
  }

  /** 停止朗读：清空队列 + 中止在途合成 + 失效旧代际结果 */
  stop(): void {
    this.generation++;
    this.queue = [];
    this.pendingDelta = '';
    this.streamOpen = false;
    this.started = false;
    this.abortController?.abort();
    this.abortController = null;
    ttsService.stop();
  }

  // ========================================
  // 内部实现
  // ========================================

  private setOptions(options?: { voice?: TTSVoice; rate?: string }): void {
    if (options) {
      this.voice = options.voice;
      this.rate = options.rate;
    }
  }

  /** 入队并确保 drain 在跑；成为 drain 持有者时负责收尾判定 */
  private async enqueue(sentences: string[]): Promise<void> {
    if (sentences.length === 0) return;
    this.queue.push(...sentences.map((text) => ({ text }) as QueueItem));

    if (!this.started) {
      this.started = true;
      this.onStart?.();
    }
    this.ensurePrefetch();

    if (this.draining) return; // 已有 drain 持有者，它会继续消费新入队的句子

    this.draining = true;
    try {
      await this.drainLoop();
    } finally {
      this.draining = false;
      // 队列播空且增量流已结束 → 完成（被 stop 时 started 已复位，fireDone 为 no-op）
      if (this.queue.length === 0 && !this.streamOpen) {
        this.fireDone();
      }
    }
  }

  /** 保持队头最多 PREFETCH_DEPTH 句处于"合成中/已合成"状态 */
  private ensurePrefetch(): void {
    if (!this.abortController) {
      this.abortController = new AbortController();
    }
    const signal = this.abortController.signal;

    let count = 0;
    for (const item of this.queue) {
      if (count >= PREFETCH_DEPTH) break;
      if (!item.audio) {
        item.audio = ttsService
          .synthesize(item.text, { voice: this.voice, rate: this.rate, signal })
          .catch((err) => {
            log.debug('预取合成失败', { text: item.text.slice(0, 20), error: String(err) });
            return null;
          });
      }
      count++;
    }
  }

  /** 流水线主循环：等队头合成完成 → 播放，同时预取后续句 */
  private async drainLoop(): Promise<void> {
    while (this.queue.length > 0) {
      this.ensurePrefetch();
      const item = this.queue.shift();
      if (!item) continue;

      const gen = this.generation;
      // 等待队头合成（带超时兜底，超时按失败处理走串行降级）
      const blob = await this.withTimeout(item.audio ?? Promise.resolve(null), SYNTH_TIMEOUT_MS);
      if (gen !== this.generation) continue; // 被 stop 打断：丢弃旧代际结果，继续消费新队列（若有）

      // 当前句即将播放 → 立刻预取后续句（核心：播放与合成重叠）
      this.ensurePrefetch();

      if (blob) {
        await this.playWithTimeout(item.text, blob);
      } else {
        // 合成失败/超时 → 串行 speak 兜底（内含非安全上下文的浏览器 TTS 降级）
        await this.speakFallback(item.text);
      }
    }
  }

  /** 播放单句（playBlob 在结束/出错/被打断时 resolve；超时兜底防卡死） */
  private playWithTimeout(text: string, blob: Blob): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, estimateMaxDuration(text));
      ttsService.playBlob(blob).then(finish, finish);
    });
  }

  /** 串行朗读兜底（合成失败时），同样带超时保护 */
  private speakFallback(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, estimateMaxDuration(text));
      ttsService
        .speak(text, { voice: this.voice, rate: this.rate, force: true })
        .then(finish, (err) => {
          log.debug('单句朗读失败', { error: String(err) });
          finish();
        });
    });
  }

  /** Promise 超时包装：超时返回 null（不取消原 Promise，其结果被代际检查丢弃） */
  private withTimeout(p: Promise<Blob | null>, ms: number): Promise<Blob | null> {
    return new Promise<Blob | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        () => {
          clearTimeout(timer);
          resolve(null);
        },
      );
    });
  }

  /** 触发 onDone（与 onStart 成对；stop 后 started=false 时为 no-op） */
  private fireDone(): void {
    if (!this.started) return;
    this.started = false;
    this.onDone?.();
  }
}

/** 单例 */
export const voiceTts = new VoiceTtsController();
