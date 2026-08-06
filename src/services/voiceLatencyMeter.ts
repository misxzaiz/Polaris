/**
 * VoiceLatencyMeter - 语音对话端到端延迟埋点
 *
 * 采集一轮语音对话的七个关键时间点（performance.now，毫秒）：
 *
 *   t0 用户开口        ASR interim 首次非空 / final 首次到达
 *   t1 ASR final 到达   speechService onResult(isFinal=true)
 *   t2 发送             sendText 调用（停顿合并结束）
 *   t3 LLM 首 token     isStreaming 变 true
 *   t4 首句入队         首次 enqueueDelta（可朗读文本首入队）
 *   t5 首音播放         voiceTts.onStart（第一个 playBlob onplay）
 *   t6 整轮朗读完       voiceTts.onDone
 *
 * 核心指标：
 *   ASR延迟      = t1 - t0
 *   停顿合并延迟  = t2 - t1
 *   LLM首token  = t3 - t2
 *   TTS首句延迟  = t5 - t4
 *   端到端首响    = t5 - t0
 *   轮转周期      = t6 - t0
 *
 * 设计要点：
 *   - performance.now() 微秒级、无 IO，每轮 7 个点总开销 < 10μs，可忽略
 *   - 只在边沿事件埋点，不在流式 chunk 上高频埋点
 *   - 环形缓冲最近 100 轮，懒持久化到 localStorage（每 5 轮写一次）
 *   - 全程本地，零隐私、零网络
 *   - 默认关闭，由 VoiceCompanionConfig.enableLatencyMeter 开启
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('VoiceLatencyMeter');

/** 埋点键名 */
export type LatencyMark =
  | 't0_mouth_open'      // 用户开口
  | 't1_asr_final'       // ASR final 到达
  | 't2_send'            // 发送
  | 't3_first_token'     // LLM 首 token
  | 't4_first_enqueue'   // 首句入队
  | 't5_first_audio'     // 首音播放
  | 't6_play_done';      // 整轮朗读完

/** 单轮延迟记录 */
export interface LatencyRound {
  /** 轮次启动时间戳（Date.now，用于跨轮排序与展示） */
  startedAt: number;
  /** 七个埋点的时间（performance.now 相对值，毫秒）；缺失为 undefined */
  marks: Partial<Record<LatencyMark, number>>;
  /** 本轮是否被完整关闭（t6 到达或被打断标记 done） */
  closed: boolean;
}

/** 派生指标 */
export interface LatencyMetrics {
  asrDelay: number | null;        // t1 - t0
  mergeDelay: number | null;      // t2 - t1
  llmFirstToken: number | null;   // t3 - t2
  ttsFirstSentence: number | null;// t5 - t4
  endToEndFirstAudio: number | null; // t5 - t0
  turnAround: number | null;      // t6 - t0
}

/** 单轮完整记录（含派生指标） */
export interface LatencyRoundWithMetrics extends LatencyRound {
  metrics: LatencyMetrics;
}

/** 环形缓冲容量 */
const MAX_ROUNDS = 100;
/** 持久化间隔（每 N 轮写一次 localStorage） */
const PERSIST_EVERY = 5;
/** localStorage 键 */
const STORAGE_KEY = 'polaris.voiceLatency.history';

class VoiceLatencyMeter {
  /** 历史轮次（环形缓冲，新轮 push 到尾部，超过容量从头裁剪） */
  private history: LatencyRound[] = [];
  /** 当前进行中的轮次（null = 无活跃轮） */
  private current: LatencyRound | null = null;
  /** 自上次持久化以来的轮次计数 */
  private dirtyCount = 0;
  /** 是否已启用（由配置注入） */
  private enabled = false;
  /** performance.now 起点（首轮 t0 时的值，用于把相对时间对齐到本轮） */
  private epoch: number = 0;

  constructor() {
    this.loadFromStorage();
  }

  /** 启用 / 关闭采集（由 useVoiceCompanion 在配置变化时注入） */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      // 关闭时丢弃未完成轮次，避免脏数据
      this.current = null;
    }
    log.debug('埋点状态变更', { enabled });
  }

  /** 开始一轮（在 t0 埋点时自动启动；也可显式调用） */
  startRound(): void {
    if (!this.enabled) return;
    // 上一轮未关闭就开新轮 → 视为被打断，标记关闭保留数据
    if (this.current && !this.current.closed) {
      this.current.closed = true;
      this.pushHistory(this.current);
    }
    this.current = {
      startedAt: Date.now(),
      marks: {},
      closed: false,
    };
    this.epoch = performance.now();
  }

  /** 打一个埋点 */
  mark(key: LatencyMark): void {
    if (!this.enabled) return;
    if (!this.current) {
      // t0 到达但无活跃轮 → 自动开轮（容错）
      if (key === 't0_mouth_open') {
        this.startRound();
      } else {
        return;
      }
    }
    // 同一 key 只记首次（防 interim 多次触发 t0）
    if (this.current!.marks[key] === undefined) {
      this.current!.marks[key] = performance.now() - this.epoch;
    }
    // t6 到达 → 本轮完成，落盘
    if (key === 't6_play_done') {
      this.current!.closed = true;
      this.pushHistory(this.current!);
      this.current = null;
    }
  }

  /** 标记当前轮被打断（不落 t6，但保留已采数据） */
  abortCurrent(): void {
    if (!this.enabled || !this.current) return;
    this.current.closed = true;
    this.pushHistory(this.current);
    this.current = null;
  }

  /** 取最近 N 轮（含派生指标），默认全部 */
  getRecent(limit?: number): LatencyRoundWithMetrics[] {
    const arr = limit ? this.history.slice(-limit) : this.history;
    return arr.map((r) => ({ ...r, metrics: this.computeMetrics(r) }));
  }

  /** 取最近 completed 轮的 P50/P95（端到端首响 & 轮转周期） */
  getPercentiles(): {
    endToEndP50: number | null;
    endToEndP95: number | null;
    turnAroundP50: number | null;
    turnAroundP95: number | null;
    sampleCount: number;
  } {
    const completed = this.history.filter((r) => r.closed);
    const e2e = completed
      .map((r) => this.computeMetrics(r).endToEndFirstAudio)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    const turn = completed
      .map((r) => this.computeMetrics(r).turnAround)
      .filter((v): v is number => v != null)
      .sort((a, b) => a - b);
    return {
      endToEndP50: percentile(e2e, 0.5),
      endToEndP95: percentile(e2e, 0.95),
      turnAroundP50: percentile(turn, 0.5),
      turnAroundP95: percentile(turn, 0.95),
      sampleCount: e2e.length,
    };
  }

  /** 清空历史 */
  clear(): void {
    this.history = [];
    this.current = null;
    this.dirtyCount = 0;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }

  // ========================================
  // 内部
  // ========================================

  private pushHistory(round: LatencyRound): void {
    this.history.push(round);
    if (this.history.length > MAX_ROUNDS) {
      this.history.splice(0, this.history.length - MAX_ROUNDS);
    }
    this.dirtyCount++;
    if (this.dirtyCount >= PERSIST_EVERY) {
      this.persist();
    }
  }

  private computeMetrics(r: LatencyRound): LatencyMetrics {
    const m = r.marks;
    const diff = (a: LatencyMark, b: LatencyMark): number | null => {
      const va = m[a];
      const vb = m[b];
      return va != null && vb != null ? Math.round(va - vb) : null;
    };
    return {
      asrDelay: diff('t1_asr_final', 't0_mouth_open'),
      mergeDelay: diff('t2_send', 't1_asr_final'),
      llmFirstToken: diff('t3_first_token', 't2_send'),
      ttsFirstSentence: diff('t5_first_audio', 't4_first_enqueue'),
      endToEndFirstAudio: diff('t5_first_audio', 't0_mouth_open'),
      turnAround: diff('t6_play_done', 't0_mouth_open'),
    };
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.history));
      this.dirtyCount = 0;
    } catch (e) {
      // localStorage 满（音频 base64 占用大）→ 静默放弃持久化，内存缓冲仍可用
      log.debug('延迟历史持久化失败（可能 localStorage 满）', { error: String(e) });
      this.dirtyCount = 0;
    }
  }

  private loadFromStorage(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.history = parsed.slice(-MAX_ROUNDS);
        }
      }
    } catch (e) {
      log.debug('延迟历史加载失败', { error: String(e) });
    }
  }
}

/** 计算分位数（线性插值），空数组返回 null */
function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return Math.round(sortedAsc[0]);
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return Math.round(sortedAsc[lo]);
  const v = sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
  return Math.round(v);
}

/** 单例 */
export const voiceLatencyMeter = new VoiceLatencyMeter();
