/**
 * 终态事件轮次代际过滤测试（plans/simpleai-interrupt-continue-race-fix.md spec F1）
 *
 * 场景：中断兜底超时后新一轮已开跑（activeTurnId 已推进到新轮），旧轮才真正
 * 退出并发 SessionEnd——若不过滤，eventHandler 的 session_end 分支会把新一轮
 * currentMessage 提前固化并置 isStreaming=false（「发出去没反应/消息分裂」）。
 *
 * 覆盖：
 * 1. observeTurnEvent 语义：非终态推进 activeTurnId；终态与当前轮一致放行、
 *    落后拒绝；activeTurnId 为 null（未观测）时终态放行保持旧语义。
 * 2. 危险性自证：旧轮 session_end 直投 handleAIEvent 会误杀新轮流式态。
 * 3. 过滤生效：manager 判定（observeTurnEvent=false）后不投递 handleAIEvent，
 *    新轮流式态保持。
 */
import { describe, expect, it, vi } from 'vitest'
import { createConversationStore } from './createConversationStore'
import type { StoreDeps } from './types'
import type { AIEvent } from '../../ai-runtime'

vi.mock('@/services/dialogStorage', () => ({ dialogStorageService: {} }))
vi.mock('@/services/voiceNotificationService', () => ({
  voiceNotificationService: { notifyError: () => {} },
}))
vi.mock('./sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: () => ({ sessionMetadata: new Map() }),
    setState: vi.fn(),
  },
}))
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

/** 模拟 sessionStoreManager.dispatchEvent 的轮次闸门：observeTurnEvent 放行才投递 */
function dispatchWithTurnGate(
  store: ReturnType<typeof createConversationStore>,
  event: AIEvent,
  turnId?: string,
): boolean {
  if (turnId && !store.getState().observeTurnEvent(turnId, event.type)) {
    return false // 旧轮迟到终态：manager 丢弃，不调 handleAIEvent
  }
  store.getState().handleAIEvent(event)
  return true
}

describe('observeTurnEvent 语义', () => {
  it('非终态事件推进 activeTurnId 并放行', () => {
    const store = createConversationStore('s1', createDeps())
    expect(store.getState().activeTurnId).toBeNull()
    expect(store.getState().observeTurnEvent('turn-1', 'token')).toBe(true)
    expect(store.getState().activeTurnId).toBe('turn-1')
    expect(store.getState().observeTurnEvent('turn-1', 'tool_call_start')).toBe(true)
    expect(store.getState().activeTurnId).toBe('turn-1')
  })

  it('终态事件与当前轮一致 → 放行；落后于当前轮 → 拒绝', () => {
    const store = createConversationStore('s1', createDeps())
    store.getState().observeTurnEvent('turn-1', 'token')
    // 当前轮自己的终态
    expect(store.getState().observeTurnEvent('turn-1', 'session_end')).toBe(true)
    expect(store.getState().observeTurnEvent('turn-1', 'error')).toBe(true)
    // 新轮事件已到，旧轮终态迟到
    store.getState().observeTurnEvent('turn-2', 'user_message')
    expect(store.getState().activeTurnId).toBe('turn-2')
    expect(store.getState().observeTurnEvent('turn-1', 'session_end')).toBe(false)
    expect(store.getState().observeTurnEvent('turn-1', 'error')).toBe(false)
    // 新轮自己的终态正常放行
    expect(store.getState().observeTurnEvent('turn-2', 'session_end')).toBe(true)
  })

  it('activeTurnId 为 null（尚未观测到轮次）时终态放行，保持旧事件源语义', () => {
    const store = createConversationStore('s1', createDeps())
    expect(store.getState().observeTurnEvent('turn-9', 'session_end')).toBe(true)
  })

  it('新轮首事件到达时重挂流式态（超时兜底路径的迟到终态自愈）', () => {
    const store = createConversationStore('s1', createDeps())
    store.getState().observeTurnEvent('turn-1', 'token')
    // 兜底路径：旧轮 session_end 先于新轮事件到达（activeTurnId 仍指旧轮 → 未被
    // 过滤）把 isStreaming 置 false
    store.setState({ isStreaming: false })
    // 新轮首事件到达：activeTurnId 推进 + isStreaming 重挂
    store.getState().observeTurnEvent('turn-2', 'user_message')
    expect(store.getState().activeTurnId).toBe('turn-2')
    expect(store.getState().isStreaming).toBe(true)
    // 同轮后续事件不重复触发 set（isStreaming 已为 true）
    expect(store.getState().observeTurnEvent('turn-2', 'token')).toBe(true)
    expect(store.getState().isStreaming).toBe(true)
  })

  it('无 _turnId 的事件不经闸门（scheduler/dispatch 直投路径不受影响）', () => {
    const store = createConversationStore('s1', createDeps())
    store.getState().observeTurnEvent('turn-1', 'token')
    // manager 逻辑：turnId 缺失时不调 observeTurnEvent、直接投递
    store.getState().handleAIEvent({
      type: 'session_end',
      sessionId: 'conv-1',
      reason: 'completed',
    } as AIEvent)
    expect(store.getState().isStreaming).toBe(false)
  })
})

describe('旧轮迟到 session_end 的过滤（集成）', () => {
  it('未过滤时旧轮 session_end 会误杀新轮流式态（危险性自证）', () => {
    const store = createConversationStore('s1', createDeps())
    // 新一轮流式中：currentMessage 在构建
    store.setState({ isStreaming: true, currentMessage: null })
    store.getState().handleAIEvent({ type: 'token', sessionId: 'conv-1', value: '新轮内容' } as AIEvent)
    expect(store.getState().currentMessage).not.toBeNull()
    // 旧轮迟到的 session_end 直投（无闸门）→ 新轮被误杀
    store.getState().handleAIEvent({
      type: 'session_end',
      sessionId: 'conv-1',
      reason: 'aborted',
    } as AIEvent)
    expect(store.getState().isStreaming).toBe(false)
    expect(store.getState().currentMessage).toBeNull()
  })

  it('闸门过滤后旧轮 session_end 被丢弃，新轮流式态保持', () => {
    const store = createConversationStore('s1', createDeps())
    store.setState({ isStreaming: true, currentMessage: null })
    // 新轮首事件到达（manager 侧先过闸门再投递）
    expect(dispatchWithTurnGate(store, { type: 'user_message', sessionId: 'conv-1' } as AIEvent, 'turn-2')).toBe(true)
    dispatchWithTurnGate(store, { type: 'token', sessionId: 'conv-1', value: '新轮内容' } as AIEvent, 'turn-2')
    expect(store.getState().currentMessage).not.toBeNull()

    // 旧轮（turn-1）迟到的 session_end：闸门拒绝 → 不投递 handleAIEvent
    const handleSpy = vi.spyOn(store.getState(), 'handleAIEvent')
    const delivered = dispatchWithTurnGate(
      store,
      { type: 'session_end', sessionId: 'conv-1', reason: 'aborted' } as AIEvent,
      'turn-1',
    )
    expect(delivered).toBe(false)
    expect(handleSpy).not.toHaveBeenCalled()
    // 新轮流式态未被误杀
    expect(store.getState().isStreaming).toBe(true)
    expect(store.getState().currentMessage).not.toBeNull()

    // 随后新轮自己的 session_end 正常收尾
    dispatchWithTurnGate(
      store,
      { type: 'session_end', sessionId: 'conv-1', reason: 'completed' } as AIEvent,
      'turn-2',
    )
    expect(store.getState().isStreaming).toBe(false)
  })
})
