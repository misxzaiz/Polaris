/**
 * settleSessionElapsedMs 专项测试
 *
 * 语义：把当前活动轮（runStartAtMs 起）的墙钟流逝结算进 sessionElapsedMs，
 * 供 interrupt 兜底等「session_end 不到达」的强制收尾路径调用。
 * - runStartAtMs 为 null（从未 start / 已结算过）时是幂等空操作。
 * - runStartAtMs 非空：累加 Date.now() - runStartAtMs 并清空 runStartAtMs。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({
  voiceNotificationService: { notifyError: () => {} },
}))
vi.mock('./sessionStoreManager', () => ({ sessionStoreManager: {} }))
vi.mock('@/stores/workspaceStore', () => ({ useWorkspaceStore: { getState: () => ({}) } }))
vi.mock('@/stores/cliInfoStore', () => ({
  useCliInfoStore: { getState: () => ({ updateFromInit: () => {} }) },
}))
vi.mock('@/plugin-system/chatCardRegistry', () => ({
  chatCardRegistry: {
    register: () => {},
    registerBuiltin: () => {},
    registerBuiltinExact: () => {},
    unregisterAll: () => {},
    match: () => undefined,
    get: () => undefined,
    resolve: () => undefined,
  },
}))
vi.mock('@/services/aiChatDispatch', () => ({
  aiChatDispatch: vi.fn(),
  aiChatDispatchStream: vi.fn(),
}))
vi.mock('@/services/eventBus', () => ({ eventBus: { emit: vi.fn() } }))
vi.mock('../toastStore', () => ({
  useToastStore: { getState: () => ({ error: vi.fn() }) },
}))

function createDeps(): StoreDeps {
  return {
    getConfig: () => ({ defaultEngine: 'custom-engine' }),
    getWorkspace: () => null,
    getContextWorkspaceIds: () => [],
    getAllWorkspaces: () => [],
    getEventRouter: () => ({}) as StoreDeps['getEventRouter'] extends () => infer T ? T : never,
    contextId: 'test-context',
  }
}

describe('settleSessionElapsedMs', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runStartAtMs 为 null 时幂等空操作，不虚增累计', () => {
    const store = createConversationStore('session-1', createDeps())
    store.setState({ runStartAtMs: null, sessionElapsedMs: 0 } as never)
    store.getState().settleSessionElapsedMs()
    expect(store.getState().sessionElapsedMs).toBe(0)
    expect(store.getState().runStartAtMs).toBeNull()
  })

  it('有活动轮时累加 Date.now()-runStartAtMs 并清空起点', () => {
    const store = createConversationStore('session-1', createDeps())
    store.setState({ runStartAtMs: 1_000_000 - 2500, sessionElapsedMs: 1000 } as never)
    store.getState().settleSessionElapsedMs()
    expect(store.getState().sessionElapsedMs).toBe(1000 + 2500)
    expect(store.getState().runStartAtMs).toBeNull()
    // 最近完成一轮时长同步写入：settle 兜底路径也保留给折叠态显示
    expect(store.getState().lastTurnMs).toBe(2500)
  })

  it('跨两段结算累加（先 settle 再开新一轮 settle）', () => {
    const store = createConversationStore('session-1', createDeps())
    // 第一段：1000 → 2000，settle 后累计 1000
    store.setState({ runStartAtMs: 1_000_000, sessionElapsedMs: 0 } as never)
    vi.setSystemTime(1_000_000 + 1000)
    store.getState().settleSessionElapsedMs()
    expect(store.getState().sessionElapsedMs).toBe(1000)
    // 第二段：3000 → 3500，settle 后累计 1000 + 500
    vi.setSystemTime(1_000_000 + 3000)
    store.setState({ runStartAtMs: 1_000_000 + 3000 } as never)
    vi.setSystemTime(1_000_000 + 3500)
    store.getState().settleSessionElapsedMs()
    expect(store.getState().sessionElapsedMs).toBe(1000 + 500)
    expect(store.getState().runStartAtMs).toBeNull()
  })

  it('时钟回拨（runStartAtMs 在未来）时不产生负累计', () => {
    const store = createConversationStore('session-1', createDeps())
    // 时钟被回拨：起点在未来
    store.setState({ runStartAtMs: 1_000_000 + 500, sessionElapsedMs: 0 } as never)
    store.getState().settleSessionElapsedMs()
    expect(store.getState().sessionElapsedMs).toBe(0)
    expect(store.getState().runStartAtMs).toBeNull()
  })
})