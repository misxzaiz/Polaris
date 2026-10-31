/**
 * 会话累计运行时长（sessionElapsedMs / runStartAtMs）eventHandler 专项测试
 *
 * 语义：AI 运行墙钟，session_start 记起点、session_end 结算累加。
 * - 静默会话（silentMode，标题生成/压缩交接）不计数。
 * - receivedAtMs 缺省回退 Date.now()；end 早于 start 防御归零。
 * - runStartAtMs 为 null（从未 start / 静默）时不虚增累计。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({
  voiceNotificationService: { notifyError: () => {} },
}))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({ chatCardRegistry: { get: () => undefined } }))

import { handleAIEvent } from './eventHandler'
import type { ConversationStore } from './types'
import type { AIEvent } from '@/ai-runtime'

/**
 * sessionStoreManager 可控 mock：默认非静默，可切换 silentMode。
 * session_start 分支读取 sessionMetadata.silentMode 决定是否计时。
 */
let mockSilent = false
vi.mock('./sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: () => ({
      sessionMetadata: new Map<string, { silentMode?: boolean }>([
        ['s1', { silentMode: mockSilent }],
      ]),
    }),
  },
}))

function makeStore(overrides: Partial<ConversationStore> = {}) {
  let state = {
    sessionId: 's1',
    conversationId: 'conv-1',
    isStreaming: false,
    error: null,
    progressMessage: null,
    currentMessage: null,
    messages: [],
    sessionElapsedMs: 0,
    runStartAtMs: null,
    lastTurnMs: 0,
    ...overrides,
  } as unknown as ConversationStore
  const store = state as unknown as ConversationStore & {
    finishMessage: () => void
    getPersistableMessages: () => unknown[]
    saveDialog: () => void
  }
  store.finishMessage = () => {}
  store.getPersistableMessages = () => []
  const set = (partial: Partial<ConversationStore>) => {
    state = { ...state, ...partial }
    Object.assign(store, state)
  }
  const get = () => state
  return { set, get, store }
}

const T0 = 1_000_000

describe('会话累计时长（sessionElapsedMs / runStartAtMs）', () => {
  beforeEach(() => {
    mockSilent = false
  })

  it('会话结束后 lastTurnMs 保留最近一轮时长（折叠态继续显示刚才那轮）', () => {
    const { set, get } = makeStore()
    // 第 1 轮：1000ms
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: T0 } as AIEvent, set as never, get as never)
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 1000 } as AIEvent, set as never, get as never)
    expect(get().lastTurnMs).toBe(1000)
    // 第 2 轮：2000ms（覆盖最近一轮）
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: T0 + 5000 } as AIEvent, set as never, get as never)
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 7000 } as AIEvent, set as never, get as never)
    expect(get().lastTurnMs).toBe(2000)
    // runStartAtMs 已清空（会话结束、未开新一轮）——折叠态 currentTurnMs 退避 lastTurnMs
    expect(get().runStartAtMs).toBeNull()
  })

  it('session_start 记录起点，session_end 结算并累加', () => {
    const { set, get } = makeStore()
    const start: AIEvent = { type: 'session_start', sessionId: 's1', receivedAtMs: T0 }
    handleAIEvent(start, set as never, get as never)
    expect(get().runStartAtMs).toBe(T0)
    expect(get().isStreaming).toBe(true)

    // 结束：2500ms 墙钟计入累计
    const end: AIEvent = { type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 2500 }
    handleAIEvent(end, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(2500)
    expect(get().runStartAtMs).toBeNull()
    // 最近完成一轮时长同步记录：会话结束后折叠态据此显示「刚才那轮」
    expect(get().lastTurnMs).toBe(2500)
  })

  it('跨多轮累计相加，每轮独立结算', () => {
    const { set, get } = makeStore()
    // 第 1 轮
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: T0 } as AIEvent, set as never, get as never)
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 1000 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(1000)
    // 第 2 轮
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: T0 + 5000 } as AIEvent, set as never, get as never)
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 6500 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(2500)
    expect(get().runStartAtMs).toBeNull()
  })

  it('runStartAtMs 为 null（从未 start）时 session_end 不虚增累计', () => {
    const { set, get } = makeStore()
    // 直接收到 session_end（无前置 session_start，旧引擎 or 丢弃）
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 999 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(0)
  })

  it('静默会话（silentMode）不计入累计', () => {
    mockSilent = true
    const { set, get } = makeStore()
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: T0 } as AIEvent, set as never, get as never)
    // 静默：runStartAtMs 置 null
    expect(get().runStartAtMs).toBeNull()
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 2000 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(0)
  })

  it('receivedAtMs 缺省回退 Date.now()，end 早于 start 防御归零', () => {
    const { set, get } = makeStore()
    const start = Date.now()
    handleAIEvent({ type: 'session_start', sessionId: 's1', receivedAtMs: start } as AIEvent, set as never, get as never)
    // 乱序终态：end 早于 start → delta 归零但至少清空 runStart
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: start - 500 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(0)
    expect(get().runStartAtMs).toBeNull()
  })

  it('续聊轮无 session_start：sendMessage 乐观置 runStartAtMs，session_end 直接结算', () => {
    // 回归：SimpleAI 等引擎续聊不发 session_start。首轮都有 session_start 补发，
    // 续聊轮起点由 sendMessage 乐观置位（runStartAtMs 已有值），随后的 session_end
    // 必须按该起点结算——否则后续轮次永久不计时。
    const { set, get } = makeStore({
      // 模拟 sendMessage 乐观置位后的 store 状态（新轮起点）
      runStartAtMs: T0,
    })
    // 无 session_start：直接收到 session_end（receivedAtMs 为用户发消息后经历的时间）
    handleAIEvent({ type: 'session_end', sessionId: 's1', reason: 'completed', receivedAtMs: T0 + 1800 } as AIEvent, set as never, get as never)
    expect(get().sessionElapsedMs).toBe(1800)
    expect(get().runStartAtMs).toBeNull()
  })
})