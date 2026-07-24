/**
 * usage 事件双口径分流回归测试
 *
 * 数值取自真实 Claude CLI stream-json 样本（2026-07 中转端点实测）：
 * - 两轮工具调用 run 的 message_delta 分别为 24920/35572，result 累计 60492
 *   （sum(message_delta) == result 精确相等；35572 与 CLI /context 读数 35.6k 一致）。
 * - 后台子代理（Task）run 实测（2.1.205）：单 run 输出两条 result
 *   （task-notification 续跑），末轮 message_delta 31451，两条 result 的 modelUsage
 *   均为进程累计 112047（含子代理消耗），total_cost_usd 分别 0.333613/0.577063。
 * 验证目标：
 * 1. 水位三元组取单轮快照而非累计，防止 num_turns 倍虚高（60.5k vs 35.6k）。
 * 2. 单 run 多条 result 不得覆盖水位（112k vs 31.5k 的 3.6 倍虚高），
 *    sessionTotals 幂等替换不重复计数。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({ voiceNotificationService: {} }))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({ chatCardRegistry: { get: () => undefined } }))

import { handleAIEvent } from './eventHandler'
import type { ConversationStore, UsageStats } from './types'
import type { UsageEvent, CliInitEvent } from '@/ai-runtime'

function makeStore(usageStats: UsageStats | null = null) {
  let state = { usageStats } as ConversationStore
  const set = (partial: Partial<ConversationStore>) => {
    state = { ...state, ...partial }
  }
  const get = () => state
  return { set, get, usage: () => state.usageStats }
}

/** run 启动信号：每次 CLI 进程启动都会下发 system/init（复位双口径状态机） */
function cliInitEvent(): CliInitEvent {
  return { type: 'cli_init', sessionId: 's1' }
}

function turnEvent(input: number, cacheRead = 0, output = 0, actualModel?: string): UsageEvent {
  return {
    type: 'usage',
    sessionId: 's1',
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    scope: 'turn',
    actualModel,
  }
}

function cumulativeEvent(
  input: number,
  output: number,
  scope?: 'cumulative',
  opts?: { totalCostUsd?: number; modelCost?: number; actualModel?: string },
): UsageEvent {
  return {
    type: 'usage',
    sessionId: 's1',
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: output,
    contextWindow: 200000,
    modelUsage: { qusc: { inputTokens: input, outputTokens: output, costUsd: opts?.modelCost } },
    rawPayload: { subtype: 'success' },
    scope,
    totalCostUsd: opts?.totalCostUsd,
    actualModel: opts?.actualModel,
  }
}

describe('usage 事件双口径分流', () => {
  it('turn 快照只刷新水位三元组，不触碰成本/明细组', () => {
    const store = makeStore({
      input: 1,
      cacheCreation: 0,
      cacheRead: 0,
      output: 99,
      totalOutput: 99,
      contextWindow: 200000,
      modelUsage: { old: { inputTokens: 1, outputTokens: 1 } },
    } as UsageStats)
    handleAIEvent(turnEvent(24920, 1024, 90), store.set, store.get)

    const u = store.usage()!
    expect(u.input).toBe(24920)
    expect(u.cacheRead).toBe(1024)
    expect(u.contextSource).toBe('turn')
    expect(u.turnSnapshotSeen).toBe(true)
    // 成本/明细组保持不变；contextWindow 保留已知值（turn 事件不携带）
    expect(u.output).toBe(99)
    expect(u.totalOutput).toBe(99)
    expect(u.modelUsage).toEqual({ old: { inputTokens: 1, outputTokens: 1 } })
    expect(u.contextWindow).toBe(200000)
  })

  it('同 run 内后到的 turn 快照覆盖先到的（水位随流式爬升）', () => {
    const store = makeStore()
    handleAIEvent(turnEvent(24920), store.set, store.get)
    handleAIEvent(turnEvent(35572), store.set, store.get)
    expect(store.usage()!.input).toBe(35572)
  })

  it('cumulative 到达且本 run 有快照：水位保持快照值，仅更新成本/明细组（标记不复位）', () => {
    const store = makeStore()
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(turnEvent(24920), store.set, store.get)
    handleAIEvent(turnEvent(35572), store.set, store.get)
    handleAIEvent(cumulativeEvent(60492, 795, 'cumulative'), store.set, store.get)

    const u = store.usage()!
    // 水位 = 最近一轮快照 35572（≈ /context 35.6k），而非累计 60492
    expect(u.input).toBe(35572)
    expect(u.contextSource).toBe('turn')
    // 成本/明细组来自 cumulative
    expect(u.output).toBe(795)
    expect(u.totalOutput).toBe(795)
    expect(u.modelUsage?.qusc.inputTokens).toBe(60492)
    expect(u.rawPayload).toBeDefined()
    // 标记不在此复位（防单 run 多 result 覆盖水位），由下一 run 的 cli_init 复位
    expect(u.turnSnapshotSeen).toBe(true)
  })

  it('单 run 多条 result（后台子代理 task-notification 续跑）：水位保持快照，总量不重复计数', () => {
    // 实测样本：末轮 delta 31451；两条 result 的 modelUsage 均为进程累计 112047，
    // total_cost_usd 分别 0.333613（首段）/ 0.577063（含续跑段，权威终值）
    const store = makeStore()
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(turnEvent(23515), store.set, store.get)
    handleAIEvent(turnEvent(27836), store.set, store.get)
    handleAIEvent(turnEvent(31451), store.set, store.get)
    handleAIEvent(cumulativeEvent(112047, 668, 'cumulative', { totalCostUsd: 0.333613 }), store.set, store.get)
    handleAIEvent(cumulativeEvent(112047, 668, 'cumulative', { totalCostUsd: 0.577063 }), store.set, store.get)

    const u = store.usage()!
    // 第二条 result 不得用进程累计 112047 覆盖水位（3.6 倍虚高回归点）
    expect(u.input).toBe(31451)
    expect(u.contextSource).toBe('turn')
    // 会话总量幂等替换：112047 只计一次，成本取末条 result 终值，run 计 1 次
    const t = u.sessionTotals!
    expect(t.input).toBe(112047)
    expect(t.output).toBe(668)
    expect(t.costUsd).toBeCloseTo(0.577063, 10)
    expect(t.runs).toBe(1)
    expect(u.totalOutput).toBe(668)
  })

  it('cumulative 到达且无快照（scope 缺省，Codex/SimpleAI 兼容）：累计值兜底水位', () => {
    const store = makeStore()
    handleAIEvent(cumulativeEvent(26430, 33), store.set, store.get)

    const u = store.usage()!
    expect(u.input).toBe(26430)
    expect(u.contextSource).toBe('cumulative')
    expect(u.turnSnapshotSeen).toBe(false)
  })

  it('cli_init 复位后下一 run 无快照：cumulative 兜底重新接管水位（不停留在陈旧快照）', () => {
    const store = makeStore()
    // run 1：有快照
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(turnEvent(35572), store.set, store.get)
    handleAIEvent(cumulativeEvent(60492, 795, 'cumulative'), store.set, store.get)
    // run 2：端点未提供快照，单轮 cumulative 即真实值
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(cumulativeEvent(37174, 259, 'cumulative'), store.set, store.get)

    const u = store.usage()!
    expect(u.input).toBe(37174)
    expect(u.contextSource).toBe('cumulative')
    expect(u.totalOutput).toBe(795 + 259)
  })

  it('turn 快照逐轮记录实际模型并去重累积（中转站动态路由）', () => {
    const store = makeStore()
    handleAIEvent(turnEvent(24920, 0, 0, 'glm-5.2'), store.set, store.get)
    handleAIEvent(turnEvent(35572, 0, 0, 'deepseek-v4-flash'), store.set, store.get)
    handleAIEvent(turnEvent(37000, 0, 0, 'deepseek-v4-flash'), store.set, store.get)

    const u = store.usage()!
    expect(u.actualModel).toBe('deepseek-v4-flash')
    expect(u.actualModels).toEqual(['glm-5.2', 'deepseek-v4-flash'])
  })

  it('cumulative 跨消息（cli_init 分隔的两个 run）累加会话总量（totalCostUsd 权威口径）', () => {
    // 数值取自同进程双消息实测：run1 {24248, 8, $0.12144}、run2 {30560, 36, $0.1537}
    const store = makeStore()
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(cumulativeEvent(24248, 8, 'cumulative', { totalCostUsd: 0.12144 }), store.set, store.get)
    handleAIEvent(cliInitEvent(), store.set, store.get)
    handleAIEvent(cumulativeEvent(30560, 36, 'cumulative', { totalCostUsd: 0.1537 }), store.set, store.get)

    const t = store.usage()!.sessionTotals!
    expect(t.input).toBe(24248 + 30560)
    expect(t.output).toBe(8 + 36)
    expect(t.costUsd).toBeCloseTo(0.12144 + 0.1537, 10)
    expect(t.runs).toBe(2)
  })

  it('scope 缺省引擎（无 cli_init 边界）：逐事件累加旧语义不受幂等替换影响', () => {
    const store = makeStore()
    handleAIEvent(cumulativeEvent(24248, 8, undefined, { totalCostUsd: 0.12144 }), store.set, store.get)
    handleAIEvent(cumulativeEvent(30560, 36, undefined, { totalCostUsd: 0.1537 }), store.set, store.get)

    const t = store.usage()!.sessionTotals!
    expect(t.input).toBe(24248 + 30560)
    expect(t.output).toBe(8 + 36)
    expect(t.runs).toBe(2)
    expect(store.usage()!.totalOutput).toBe(8 + 36)
  })

  it('totalCostUsd 缺失时退化到 modelUsage costUsd 求和', () => {
    const store = makeStore()
    handleAIEvent(cumulativeEvent(21872, 73, 'cumulative', { modelCost: 0.111185 }), store.set, store.get)
    expect(store.usage()!.sessionTotals!.costUsd).toBeCloseTo(0.111185, 10)
  })
})
