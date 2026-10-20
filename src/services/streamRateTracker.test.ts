/**
 * streamRateTracker 单元测试
 *
 * 覆盖三个核心机制（对应 opencode-tps-meter / pi-token-speed 的实测结论）：
 * 1. 按生成区间加权 —— 首块不计入速率，窗口内按重叠比例分配。
 * 2. stall gap 前移 —— 同时间戳 flush 不得读成极高速率。
 * 3. 宁缺勿猜 —— 跨度 < MIN_RATE_SPAN_MS 返回 null 而非硬算。
 *
 * 另覆盖 provider 精确计数校正的上下界（[0.5, 2] 外不校正，避免编造吞吐）。
 */
import { describe, it, expect } from 'vitest'

import {
  TokenRateTracker,
  estimateTokens,
  MIN_RATE_SPAN_MS,
  DEFAULT_ROLLING_WINDOW_MS,
} from './streamRateTracker'

/** 固定时刻序列，避免测试受真实时钟影响 */
const T0 = 1_000_000

describe('estimateTokens', () => {
  it('空串与纯空白为 0，单字符下限为 1', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('   ')).toBe(0)
    expect(estimateTokens('\n\t ')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
  })

  it('中文按 ~1.5 token/字，ASCII 按 ~1/4 token/char', () => {
    expect(estimateTokens('中文两个字')).toBe(5 * 1.5) // 7.5
    expect(estimateTokens('abcdefgh')).toBe(2)
  })

  it('混合文本加权', () => {
    // 2 个汉字 + 4 个 ASCII = 3 + 1 = 4
    expect(estimateTokens('中文abcd')).toBe(2 * 1.5 + 4 / 4)
  })
})

describe('首块与最小跨度', () => {
  it('单块不计速率（生成区间未被观测）', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    t.recordDelta(T0 + 200, 'hello world')
    const s = t.snapshot(T0 + 200)
    expect(s.tps).toBeNull()
    expect(s.avgTps).toBeNull()
    expect(s.tokens).toBeGreaterThan(0)
    expect(s.ttftMs).toBe(200)
  })

  it('跨度低于 MIN_RATE_SPAN_MS 时不报数', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    t.recordDelta(T0 + 100, 'first chunk of text')
    t.recordDelta(T0 + 40, '') // 早于首块且空 → 忽略
    // 立即补一个间隔极短的第二块（< 50ms）
    t.recordDelta(T0 + 110, 'second chunk')
    expect(t.snapshot(T0 + 110).tps).toBeNull()
  })
})

describe('按生成区间加权', () => {
  it('稳定流式给出稳定 TPS', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    // 每 100ms 一块，每块 10 token → 期望 ~100 tok/s
    let at = T0
    for (let i = 0; i < 20; i++) {
      at += 100
      t.recordDelta(at, 'x'.repeat(0), 10)
    }
    const s = t.snapshot(at)
    expect(s.tps).not.toBeNull()
    // 允许 ±15% 误差（窗口边界与加权带来的偏差）
    expect(s.tps!).toBeGreaterThan(85)
    expect(s.tps!).toBeLessThan(115)
    expect(s.avgTps!).toBeGreaterThan(85)
    expect(s.avgTps!).toBeLessThan(115)
  })

  it('窗口内部分区间不整块计入', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    // 一个生成了 1000ms 的块，窗口只有 1000ms
    t.recordDelta(T0, 'seed', 1)
    t.recordDelta(T0 + 1000, 'big chunk', 100)
    const s = t.snapshot(T0 + 1000)
    // 块占满整个窗口 → 接近 100 tok/s
    expect(s.tps!).toBeGreaterThan(80)
    expect(s.tps!).toBeLessThan(120)
  })
})

describe('stall gap 前移', () => {
  it('同时间戳突发不读成极高速率', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    // 首块
    t.recordDelta(T0 + 10, 'seed', 1)
    // 停顿 3000ms 后突发一堆块（全部落在同一 5ms 内，视为同批 flush）
    const burst = T0 + 3010
    for (let i = 0; i < 10; i++) {
      t.recordDelta(burst + 1, 'x'.repeat(0), 20)
    }
    const s = t.snapshot(burst + 1)
    // 若无 gap 前移，会把 200 token 除到 ~0ms → 天数字段值。
    // 前移后跨度 ≈ 3s，期望远低于同批 flush 的虚高值。
    expect(s.tps).not.toBeNull()
    expect(s.tps!).toBeLessThan(200)
  })

  it('stall 前有历史输出时，前移后 TPS 为合理非零值', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    // 正常输出阶段：9 块 × 10 token，每 100ms 一块
    t.recordDelta(T0 + 10, 'seed', 1)
    for (let i = 0; i < 9; i++) {
      t.recordDelta(T0 + 100 + i * 100, 'x'.repeat(0), 10)
    }
    // 停顿 3000ms 后突发（同批 flush，合并为一条 entry）
    const burst = T0 + 4000
    for (let i = 0; i < 5; i++) {
      t.recordDelta(burst + 1, 'x'.repeat(0), 20)
    }
    const s = t.snapshot(burst + 1)
    // 前移后窗口 = [prev.at, burst]，跨度 3s，100 token / 3s ≈ 33 tok/s。
    // 关键断言：不为 0（窗口内有 burst entry 且 overlap > 0），且远低于突发虚高值。
    expect(s.tps).not.toBeNull()
    expect(s.tps!).toBeGreaterThan(0)
    expect(s.tps!).toBeLessThan(100)
  })
})

describe('provider 精确计数校正', () => {
  // 20 块 × 10 token：首块只计总量，其余 19 块计入 ratedTokens = 190
  function makeSteadyTracker() {
    const t = new TokenRateTracker()
    t.reset(T0)
    let at = T0
    for (let i = 0; i < 20; i++) {
      at += 100
      t.recordDelta(at, 'x'.repeat(0), 10)
    }
    return { t, ratedTokens: 190 }
  }

  it('比值在上界 2.0 时校正平均速率', () => {
    const { t, ratedTokens } = makeSteadyTracker()
    const before = t.getAverageTps()
    t.markProviderUsage(ratedTokens * 2) // ratio = 2.0
    const after = t.getAverageTps()
    expect(after!).toBeCloseTo(before! * 2, 5)
  })

  it('比值在下界 0.5 时校正平均速率', () => {
    const { t, ratedTokens } = makeSteadyTracker()
    const before = t.getAverageTps()
    t.markProviderUsage(ratedTokens * 0.5) // ratio = 0.5
    const after = t.getAverageTps()
    expect(after!).toBeCloseTo(before! * 0.5, 5)
  })

  it('比值超出上界时不校正（计数对象不同，如隐藏 thinking）', () => {
    const { t } = makeSteadyTracker()
    const before = t.getAverageTps()
    t.markProviderUsage(2000) // ratio ≈ 10.5
    expect(t.getAverageTps()).toBeCloseTo(before!, 5)
  })

  it('比值低于下界时不校正', () => {
    const { t } = makeSteadyTracker()
    const before = t.getAverageTps()
    t.markProviderUsage(50) // ratio ≈ 0.26
    expect(t.getAverageTps()).toBeCloseTo(before!, 5)
  })
})

describe('窗口清理', () => {
  it('窗口外的区间不参与计算', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    // 早先高速率（1000 tok/s）
    t.recordDelta(T0, 'seed', 1)
    for (let i = 0; i < 10; i++) t.recordDelta(T0 + 10 + i, 'x'.repeat(0), 100)
    // 间隔很久后低速率
    let at = T0 + 10_000
    for (let i = 0; i < 5; i++) {
      at += 500
      t.recordDelta(at, 'x'.repeat(0), 10)
    }
    const s = t.snapshot(at)
    // 滚窗 1s 内只有后期低速块 → TPS 应接近 20
    expect(s.tps!).toBeGreaterThan(10)
    expect(s.tps!).toBeLessThan(40)
  })

  it('DEFAULT_ROLLING_WINDOW_MS 为 1 秒，MIN_RATE_SPAN_MS 为 50ms', () => {
    expect(DEFAULT_ROLLING_WINDOW_MS).toBe(1000)
    expect(MIN_RATE_SPAN_MS).toBe(50)
  })
})

describe('reset 与终态', () => {
  it('reset 后状态清零', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    t.recordDelta(T0 + 50, 'first chunk text', 20)
    t.recordDelta(T0 + 150, 'second chunk text', 20)
    expect(t.isEmpty()).toBe(false)
    t.reset(T0 + 5000)
    expect(t.isEmpty()).toBe(true)
    const s = t.snapshot(T0 + 5000)
    expect(s.tokens).toBe(0)
    expect(s.providerTokens).toBeNull()
    expect(s.settled).toBe(false)
  })

  it('markEnd 后 settled 为 true 且 generationMs 定格', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    t.recordDelta(T0 + 100, 'a chunk', 10)
    t.recordDelta(T0 + 500, 'b chunk', 10)
    expect(t.isSettled()).toBe(false)
    t.markEnd(T0 + 900)
    expect(t.isSettled()).toBe(true)
    const s = t.snapshot(T0 + 900)
    expect(s.settled).toBe(true)
    expect(s.generationMs).toBe(800)
  })

  it('markProviderUsage 幂等（同值只通知一次）', () => {
    const t = new TokenRateTracker()
    t.reset(T0)
    t.recordDelta(T0 + 100, 'chunk', 10)
    t.recordDelta(T0 + 200, 'chunk', 10)
    expect(t.markProviderUsage(50)).toBe(true)
    expect(t.markProviderUsage(50)).toBe(false) // 同值不重复通知
  })
})
