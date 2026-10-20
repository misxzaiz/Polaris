/**
 * 流式 token 速率跟踪器
 *
 * 实时计算一次 AI 回复的生成速率（TPS）、首 token 延迟（TTFT）与全程平均。
 * 算法参考并吸收 `opencode-tps-meter`(ChiR24) 与 `pi-token-speed`(gsanhueza) 的实测结论。
 *
 * ## 为什么不能"到达时刻 / 字符数"直接除
 *
 * 实测 Claude Code transcript 离线计算得到 5,861 ~ 72,000 TPS 的假值。根因：
 * 响应侧会把输出批量 flush（宿主侧 ~100ms 一批），相邻 chunk 的到达间隔可能只有
 * 0.00~0.03s，而该 chunk 携带的 token 其实是在"上一个 chunk 到达之后"这段时间
 * 生成的。除以一个更短的区间就是编造吞吐。
 *
 * ## 三个核心机制
 *
 * 1. **按生成区间加权**：每个 chunk 记录为 `{ from: 上一 chunk 到达时刻, at: 本 chunk
 *    到达时刻, count }`。窗口内按 chunk 生成区间与窗口的**重叠比例**线性加权，
 *    而非整块计入。首块的特殊性在于它的生成区间（请求发出→prefill→首块到达）
 *    从未被观测，**只计入总量、不计入任何速率**。
 *
 * 2. **stall gap 前移**：若窗口内所有 chunk 到达时刻相同（provider 缓冲后突发），
 *    把窗口下界前移到窗口前一个 chunk 的到达时刻，把停滞期计入跨度。否则一次
 *    flush 会被读成一次极高速率。
 *
 * 3. **宁缺勿猜**：生成跨度 < {@link MIN_RATE_SPAN_MS} 时返回 null（不报数），
 *    而不是用一个不稳定除数硬算。首块到达后的 ~100ms 内不给瞬时读数。
 *
 * ## provider 精确计数校正
 *
 * 流末 `usage.outputTokens` 是权威值。仅当它与启发式总量比值落在
 * [{@link MIN_PROVIDER_RATIO}, {@link MAX_PROVIDER_RATIO}] 时才用于校正平均速率 ——
 * 超出该范围说明两者计数对象不同（隐藏的 thinking、宿主未流出的内容），
 * 按比例缩放会编造吞吐，此时保持流式值。
 */

export const DEFAULT_ROLLING_WINDOW_MS = 1000;
export const MIN_RATE_SPAN_MS = 50;
export const MAX_BUFFER_SIZE = 256;
export const MIN_PROVIDER_RATIO = 0.5;
export const MAX_PROVIDER_RATIO = 2;
/** 相邻 chunk 到达间隔小于此值视为同批 flush（宿主侧批量输出） */
export const FLUSH_GAP_MS = 5;
/** UI 更新节流间隔 */
export const EMIT_INTERVAL_MS = 100;

/** 一次 chunk 的生成区间 */
export interface RateEntry {
  /** 生成区间起点 = 上一 chunk 的到达时刻 */
  from: number;
  /** 到达时刻（epoch ms） */
  at: number;
  /** 本 chunk 的启发式 token 数 */
  count: number;
}

/** 跟踪器快照（不可变，供 UI 订阅） */
export interface StreamRateSnapshot {
  /** 即时速率（滚窗内加权），不可测时为 null */
  tps: number | null;
  /** 全程平均速率，不可测时为 null */
  avgTps: number | null;
  /** 首 token 延迟 ms（会话起点 → 首个内容块） */
  ttftMs: number | null;
  /** 生成耗时 ms（首个内容块 → 最近一个内容块/结束） */
  generationMs: number | null;
  /** 启发式 token 总量（含首块） */
  tokens: number;
  /** provider 精确输出 token（流末到达）；null 表示尚未收到 */
  providerTokens: number | null;
  /** 是否已完成（收到 session_end） */
  settled: boolean;
}

const EMPTY_SNAPSHOT: StreamRateSnapshot = {
  tps: null,
  avgTps: null,
  ttftMs: null,
  generationMs: null,
  tokens: 0,
  providerTokens: null,
  settled: false,
};

/** CJK 系字符：汉字（基本 + 扩展 A）、日韩假名、谚文、注音、CJK 标点与全角形式 */
const CJK_RE = /[㐀-䶿一-鿿぀-ヿ㄰-㆏가-힯豈-﫿︐-︟ﹰ-ﹹ＀-￯]/;

/**
 * 启发式估算一段文本的 token 数。
 *
 * CJK 字与 ASCII 的 token 密度差异很大（CJK 约 1.5 token/字，ASCII 约 0.25 token/char），
 * 统一按 chars/4 会让中文严重低估、英文略偏高。流末会以 provider 精确值校正，
 * 这里的值只用于流式期间的近似读数。
 *
 * 纯空白返回 0 —— 空白不产生有意义的输出 token，计入会让总量虚增。
 */
export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  let cjk = 0;
  for (const ch of text) {
    if (CJK_RE.test(ch)) cjk++;
  }
  return Math.max(1, cjk * 1.5 + (text.length - cjk) / 4);
}

/**
 * 计算生成区间与窗口 [start, now] 的重叠长度。
 */
function overlapLength(entry: RateEntry, start: number, now: number): number {
  return Math.min(entry.at, now) - Math.max(entry.from, start);
}

/**
 * 计算窗口内的加权 token 数：按生成区间与窗口的重叠比例分配，
 * 避免把整块 token 记到窗口内的某个瞬间。
 */
function weightedTokens(entries: RateEntry[], start: number, now: number): number {
  let tokens = 0;
  for (const e of entries) {
    if (e.at <= start || e.from >= now) continue;
    const len = e.at - e.from;
    const overlap = overlapLength(e, start, now);
    if (overlap <= 0) continue;
    // 同批 flush（len≈0）时退化为整块计入
    tokens += len > 0 ? (e.count * overlap) / len : e.count;
  }
  return tokens;
}

export class TokenRateTracker {
  private periodStart: number | null = null;
  private origin: number | null = null;
  private lastChunkAt: number | null = null;
  private entries: RateEntry[] = [];
  private ratedTokens = 0;
  private totalTokens = 0;
  private providerTokens: number | null = null;
  private endedAt: number | null = null;
  private lastEmitAt = 0;

  /**
   * 重置为一轮新起点。`startAt` 作为计时基准（session_start / cli_init 到达时刻），
   * 若缺省则回退到首块到达时刻。
   */
  reset(startAt?: number): void {
    this.periodStart = startAt ?? null;
    this.origin = null;
    this.lastChunkAt = null;
    this.entries = [];
    this.ratedTokens = 0;
    this.totalTokens = 0;
    this.providerTokens = null;
    this.endedAt = null;
    this.lastEmitAt = 0;
  }

  /**
   * 记录一个内容增量。返回 true 表示需要通知 UI（按 {@link EMIT_INTERVAL_MS} 节流）。
   * `text` 经 {@link estimateTokens} 估算 token 数；也可传 `count` 直接给定。
   */
  recordDelta(at: number | undefined, text: string, count?: number): boolean {
    if (!at) return false;
    const tokens = count ?? estimateTokens(text);
    if (tokens <= 0) return false;

    this.totalTokens += tokens;

    // 首块：生成区间未被观测（请求发出→prefill→首块到达），只计数不计速
    if (this.lastChunkAt == null) {
      this.origin = at;
      this.lastChunkAt = at;
      return true;
    }

    const from = this.lastChunkAt;
    if (from < at - FLUSH_GAP_MS) {
      this.entries.push({ from, at, count: tokens });
      this.ratedTokens += tokens;
      this.prune();
    } else {
      // 同批 flush（间隔 < FLUSH_GAP_MS）：并入上一条，不产生新区间
      const last = this.entries[this.entries.length - 1];
      if (last) {
        last.at = at;
        last.count += tokens;
      } else {
        this.entries.push({ from: this.origin ?? at, at, count: tokens });
        this.ratedTokens += tokens;
      }
    }
    this.lastChunkAt = at;
    return this.shouldEmit(at);
  }

  /**
   * 记录 provider 的精确输出 token（流末到达）。返回 true 表示需要通知 UI。
   * 不推进 {@link lastEmitAt} —— 该字段只用于增量节流，混用会让流末校正后的
   * 快照之后的增量事件被错误地抑制。
   */
  markProviderUsage(outputTokens: number | undefined): boolean {
    if (!outputTokens || outputTokens <= 0) return false;
    const prev = this.providerTokens;
    this.providerTokens = Math.max(prev ?? 0, outputTokens);
    // 只有精确值真正变化才需要刷新（turn 快照每轮到达，值相同则跳过）
    return prev !== this.providerTokens;
  }

  /** 标记一轮结束（session_end 到达时刻） */
  markEnd(at: number | undefined): void {
    if (at) this.endedAt = at;
  }

  isSettled(): boolean {
    return this.endedAt != null;
  }

  /** 返回不可变快照；无内容时返回 {@link EMPTY_SNAPSHOT}
   *  守卫同时要求 origin 与 totalTokens 为空 —— 二者由 recordDelta 同时置位，
   *  reset 后若未收到任何增量必然都为空，因此不会误算出 0ms 的 TTFT。 */
  snapshot(now?: number): StreamRateSnapshot {
    if (this.origin == null && this.totalTokens === 0) return EMPTY_SNAPSHOT;

    const spanEnd = this.endedAt ?? this.lastChunkAt ?? this.origin;

    return {
      tps: this.instantTps(now),
      avgTps: this.averageTps(),
      ttftMs:
        this.periodStart != null && this.origin != null && this.origin >= this.periodStart
          ? this.origin - this.periodStart
          : null,
      generationMs:
        this.origin != null && spanEnd != null && spanEnd > this.origin
          ? spanEnd - this.origin
          : null,
      tokens: this.totalTokens,
      providerTokens: this.providerTokens,
      settled: this.endedAt != null,
    };
  }

  /** 是否还有有效数据（供清空判断） */
  isEmpty(): boolean {
    return this.origin == null && this.totalTokens === 0;
  }

  /** 全程平均速率（含 provider 精确值校正），不可测时为 null。供测试与外部校验读取。 */
  getAverageTps(): number | null {
    return this.averageTps()
  }

  /** 即时速率（滚窗加权），不可测时为 null。供测试与外部校验读取。 */
  getInstantTps(now?: number): number | null {
    return this.instantTps(now)
  }

  private instantTps(now?: number): number | null {
    if (this.origin == null || this.entries.length === 0) return null;
    const t = now ?? this.lastChunkAt ?? this.origin;
    if (t <= this.origin) return null;

    let windowStart = Math.max(t - DEFAULT_ROLLING_WINDOW_MS, this.origin);

    // stall 检测：窗口内所有 chunk 到达时刻相同 = provider 缓冲后突发。
    // 把窗口下界前移到窗口前一个 chunk，把停滞期计入跨度。
    const inWindow = this.entries.filter((e) => e.at > windowStart && e.from < t);
    if (inWindow.length > 0) {
      const firstAt = inWindow[0].at;
      const allSame = inWindow.every((e) => e.at === firstAt);
      if (allSame) {
        let prev: RateEntry | undefined;
        for (const e of this.entries) {
          if (e.at <= windowStart) prev = e;
          else break;
        }
        if (prev) windowStart = prev.at;
      }
    }

    const spanMs = t - windowStart;
    if (spanMs < MIN_RATE_SPAN_MS) return null;

    const tokens = weightedTokens(this.entries, windowStart, t);
    if (tokens <= 0) return 0;
    return tokens / (spanMs / 1000);
  }

  private averageTps(): number | null {
    if (this.origin == null || this.lastChunkAt == null) return null;
    const spanMs = this.lastChunkAt - this.origin;
    if (spanMs < MIN_RATE_SPAN_MS) return null;

    let avg = this.ratedTokens / (spanMs / 1000);
    if (avg <= 0) return 0;

    // provider 精确计数校正：仅当两者计数对象一致时替换
    if (this.providerTokens != null && this.ratedTokens > 0) {
      const ratio = this.providerTokens / this.ratedTokens;
      if (ratio >= MIN_PROVIDER_RATIO && ratio <= MAX_PROVIDER_RATIO) {
        avg = avg * ratio;
      }
    }
    return avg;
  }

  private shouldEmit(at: number): boolean {
    const first = this.lastEmitAt === 0;
    const ok = first || at - this.lastEmitAt >= EMIT_INTERVAL_MS;
    if (ok) this.lastEmitAt = at;
    return ok;
  }

  /**
   * 超过 {@link MAX_BUFFER_SIZE} 时合并最老两个区间，而非丢弃 ——
   * 丢弃会让窗口下界静默少算 token，合并只使区间边界变粗。
   */
  private prune(): void {
    while (this.entries.length > MAX_BUFFER_SIZE) {
      const [a, b] = this.entries;
      if (!a || !b) break;
      this.entries.splice(0, 2, { from: Math.min(a.from, b.from), at: b.at, count: a.count + b.count });
    }
  }
}

/** 每个会话的跟踪器实例（不进入 store 状态，避免高频 set 拷贝） */
const trackers = new Map<string, TokenRateTracker>();

export function getTracker(sessionId: string): TokenRateTracker {
  let t = trackers.get(sessionId);
  if (!t) {
    t = new TokenRateTracker();
    trackers.set(sessionId, t);
  }
  return t;
}

export function resetTracker(sessionId: string, startAt?: number): void {
  getTracker(sessionId).reset(startAt);
}

export function dropTracker(sessionId: string): void {
  trackers.delete(sessionId);
}
