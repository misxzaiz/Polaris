/**
 * usage 事件双口径分流回归测试
 *
 * 数值取自真实 Claude CLI stream-json 样本（2026-07 中转端点实测）：
 * 两轮工具调用 run 的 message_delta 分别为 24920/35572，result 累计 60492
 * （sum(message_delta) == result 精确相等；35572 与 CLI /context 读数 35.6k 一致）。
 * 验证目标：水位三元组取单轮快照而非累计，防止 num_turns 倍虚高（60.5k vs 35.6k）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({ voiceNotificationService: {} }))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({ useCliInfoStore: { getState: () => ({}) } }))
vi.mock('@/plugin-system/chatCardRegistry', () => ({ chatCardRegistry: { get: () => undefined } }))

import { handleAIEvent } from './eventHandler'
import type { ConversationStore, UsageStats } from './types'
import type { UsageEvent } from '@/ai-runtime'

function makeStore(usageStats: UsageStats | null = null) {
  let state = { usageStats } as ConversationStore
  const set = (partial: Partial<ConversationStore>) => {
    state = { ...state, ...partial }
  }
  const get = () => state
  return { set, get, usage: () => state.usageStats }
}

function turnEvent(input: number, cacheRead = 0, output = 0): UsageEvent {
  return {
    type: 'usage',
    sessionId: 's1',
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: cacheRead,
    outputTokens: output,
    scope: 'turn',
  }
}

function cumulativeEvent(input: number, output: number, scope?: 'cumulative'): UsageEvent {
  return {
    type: 'usage',
    sessionId: 's1',
    inputTokens: input,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: output,
    contextWindow: 200000,
    modelUsage: { qusc: { inputTokens: input, outputTokens: output } },
    rawPayload: { subtype: 'success' },
    scope,
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

  it('cumulative 到达且本 run 有快照：水位保持快照值，仅更新成本/明细组并复位标记', () => {
    const store = makeStore()
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
    // 标记复位，供下一 run 重新判定
    expect(u.turnSnapshotSeen).toBe(false)
  })

  it('cumulative 到达且无快照（scope 缺省，Codex/SimpleAI 兼容）：累计值兜底水位', () => {
    const store = makeStore()
    handleAIEvent(cumulativeEvent(26430, 33), store.set, store.get)

    const u = store.usage()!
    expect(u.input).toBe(26430)
    expect(u.contextSource).toBe('cumulative')
    expect(u.turnSnapshotSeen).toBe(false)
  })

  it('复位后下一 run 无快照：cumulative 兜底重新接管水位（不停留在陈旧快照）', () => {
    const store = makeStore()
    // run 1：有快照
    handleAIEvent(turnEvent(35572), store.set, store.get)
    handleAIEvent(cumulativeEvent(60492, 795, 'cumulative'), store.set, store.get)
    // run 2：端点未提供快照，单轮 cumulative 即真实值
    handleAIEvent(cumulativeEvent(37174, 259, 'cumulative'), store.set, store.get)

    const u = store.usage()!
    expect(u.input).toBe(37174)
    expect(u.contextSource).toBe('cumulative')
    expect(u.totalOutput).toBe(795 + 259)
  })
})
