/**
 * 语音伙伴 TTS 朗读控制器
 *
 * `ttsService` 为「单次播放」设计（每次 speak 会打断上一次），无法直接排队朗读多句。
 * 本控制器在其之上实现「按句切分 + 串行合成播放」的队列：
 *   - 长回复也能在第一句很快开口，后续边播边合成，平滑不卡顿；
 *   - 每句等 ttsService 的 onEnd 再播下一句，并带超时兜底防止异常卡死；
 *   - 通话期间独占 ttsService 回调（此时不会有其他 TTS 来源）。
 *
 * Phase 1：`speak(fullText)` 一次性切句入队。
 * Phase 2 预留：`enqueueDelta()` + `flush()` 支持 AI 流式增量逐句朗读。
 */

import { ttsService } from '../ttsService';
import { cleanTextForSpeech } from '../ttsTextFilter';
import type { TTSVoice } from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('VoiceTts');

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

class VoiceTtsController {
  private queue: string[] = [];
  private draining = false;
  private stopped = false;
  private voice?: TTSVoice;
  private rate?: string;

  /** 开始朗读（队列从空到有）时触发 */
  onStart?: () => void;
  /** 队列全部播放完毕（非打断）时触发 */
  onDone?: () => void;

  /** 是否正在朗读 */
  get isActive(): boolean {
    return this.draining;
  }

  /**
   * 朗读一段完整文本：清洗 → 切句 → 串行播放
   */
  async speak(text: string, options?: { voice?: TTSVoice; rate?: string }): Promise<void> {
    const clean = cleanTextForSpeech(text);
    if (!clean) {
      log.debug('清洗后文本为空，跳过朗读');
      return;
    }

    this.voice = options?.voice;
    this.rate = options?.rate;

    const sentences = splitSentences(clean);
    const wasEmpty = this.queue.length === 0 && !this.draining;
    this.queue.push(...sentences);

    if (wasEmpty) {
      this.onStart?.();
      await this.drain();
    }
  }

  /** 停止朗读并清空队列 */
  stop(): void {
    this.stopped = true;
    this.queue = [];
    ttsService.stop();
  }

  /** 串行播放队列 */
  private async drain(): Promise<void> {
    this.draining = true;
    this.stopped = false;

    try {
      while (this.queue.length > 0 && !this.stopped) {
        const sentence = this.queue.shift();
        if (!sentence) continue;
        await this.speakOne(sentence);
      }
    } finally {
      this.draining = false;
      if (!this.stopped) {
        this.onDone?.();
      }
    }
  }

  /** 播放单句，等待其播放结束（onEnd / onError / 超时 任一触发即视为完成） */
  private speakOne(text: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      // 超时兜底：防止「无音频数据」等异常下 onEnd 不触发导致队列卡死
      const timer = setTimeout(finish, estimateMaxDuration(text));

      ttsService.setCallbacks({
        onEnd: finish,
        onError: finish,
      });

      ttsService
        .speak(text, { voice: this.voice, rate: this.rate, force: true })
        .catch((err) => {
          log.debug('单句朗读失败', { error: String(err) });
          finish();
        });
    });
  }
}

/** 单例 */
export const voiceTts = new VoiceTtsController();
