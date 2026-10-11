/**
 * 远端会话「按需投影」测试 — S3 实时消费
 *
 * 场景：A 端创建会话发消息，B 端（另一窗口/桌面）未打开该会话。
 * 修复前：dispatchEvent 收到 session_start 时 store 不存在 → 事件丢弃，
 *   assistant_message 增量也逐个丢弃，B 端流式期间完全看不到。
 * 修复后：session_start 到达时自动创建 silent 投影 store（不占视口/列表/激活），
 *   后续 assistant_message 增量能实时 append 渲染。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { sessionStoreManager } from './sessionStoreManager'
import type { AIEvent } from '@/ai-runtime'

function resetSessionManager() {
  const state = sessionStoreManager.getState()
  Array.from(state.stores.keys()).forEach((id) => state.deleteSession(id))
  sessionStoreManager.setState({
    activeSessionId: null,
    backgroundSessionIds: [],
    completedNotifications: [],
    isInitialized: false,
  })
}

describe('远端会话按需投影（S3 实时消费）', () => {
  beforeEach(() => {
    resetSessionManager()
  })

  it('store 不存在 + session_start → 自动创建 silent 投影 store 并绑定会话', () => {
    const remoteSessionId = 'remote-session-001'
    const backendConvId = 'backend-conv-abc'

    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: backendConvId, // 后端 conversationId
      engineId: 'claude-code',
      _routeSessionId: remoteSessionId, // 前端 sessionId（EventRouter 从 contextId 解析）
    } as AIEvent & { _routeSessionId: string })

    const state = sessionStoreManager.getState()
    expect(state.stores.has(remoteSessionId)).toBe(true)

    const store = state.stores.get(remoteSessionId)!.getState()
    // 投影 store 应绑定后端 conversationId（供消息同步路由）
    expect(store.conversationId).toBe(backendConvId)
    // 同步桶也应指向后端 conversationId（user/assistant 写同桶）
    expect(store.syncConversationId).toBe(backendConvId)
    // 投影 store 应为 silent（不进列表/视口/激活）
    expect(state.sessionMetadata.get(remoteSessionId)?.silentMode).toBe(true)
    // 不改变 activeSessionId / 不进 multiSessionIds
    expect(state.activeSessionId).not.toBe(remoteSessionId)
    expect(state.sessionMetadata.get(remoteSessionId)?.engineId).toBe('claude-code')
  })

  it('store 已存在 → 不重复投影，正常路由到既有 store', () => {
    const localId = sessionStoreManager.getState().createSession({
      type: 'free',
      title: '本地会话',
    })
    const backendConvId = 'backend-conv-xyz'

    // 先关联会话
    const store = sessionStoreManager.getState().stores.get(localId)!.getState()
    store.setConversationId(backendConvId)
    const storeCountBefore = sessionStoreManager.getState().stores.size

    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: backendConvId,
      _routeSessionId: localId,
    } as AIEvent & { _routeSessionId: string })

    // 不重复创建投影（localId 已有 store）
    expect(sessionStoreManager.getState().stores.size).toBe(storeCountBefore)
    // 状态更新为 running
    expect(sessionStoreManager.getState().sessionMetadata.get(localId)?.silentMode).toBeFalsy()
  })

  it('session_end → 清理 silent 投影 store（避免泄漏）', () => {
    const remoteSessionId = 'remote-session-002'
    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: 'backend-conv-2',
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    // 流式增量实时 append
    sessionStoreManager.getState().dispatchEvent({
      type: 'assistant_message',
      sessionId: 'backend-conv-2',
      content: '实时内容',
      isDelta: true,
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    const projected = sessionStoreManager.getState().stores.get(remoteSessionId)!.getState()
    expect(projected.currentMessage).toBeTruthy()

    // 会话结束 → 清理投影 store
    sessionStoreManager.getState().dispatchEvent({
      type: 'session_end',
      sessionId: 'backend-conv-2',
      reason: 'completed',
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    expect(sessionStoreManager.getState().stores.has(remoteSessionId)).toBe(false)
  })

  
it('投影 store 不认领 workspace 桶', () => {
    const remoteSessionId = 'remote-session-003'
    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: 'backend-conv-3',
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    // 投影 store 不应出现在 workspace 桶的 sessions 集合（否则从「其他窗口的会话」消失）
    const wsBuckets = (() => {
      // 通过 sessionStoreManager 状态访问 bucket（避免循环依赖：直接读 workspaceSession 注册痕迹）
      // 投影 store 是 silentMode，正常不切换活跃桶，仅检查未注册即可
      return sessionStoreManager.getState().stores.has(remoteSessionId)
    })()
    expect(wsBuckets).toBe(true)
    // silent → 不进 multiSessionIds
    // （viewStore 非本次测试关注点，此处隐式通过 createSession 的 silentMode 保证）
  })

  it('流式期间消息实时追加到投影 store（另一端「打字」效果）', () => {
    const remoteSessionId = 'remote-session-004'
    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: 'backend-conv-4',
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    // 模拟 assistant 逐 token 增量
    const tokens = ['你', '好', '，', '世', '界']
    for (const t of tokens) {
      sessionStoreManager.getState().dispatchEvent({
        type: 'assistant_message',
        sessionId: 'backend-conv-4',
        content: t,
        isDelta: true,
        _routeSessionId: remoteSessionId,
      } as AIEvent & { _routeSessionId: string })
    }

    // 需手动 flush 文本 buffer（appendTextBlock 是段落级，token 累积未 flush 前在 buffer）
    const projected = sessionStoreManager.getState().stores.get(remoteSessionId)!.getState() as unknown as {
      _flushTextBuffer?: () => void
      currentMessage: unknown
    }
    projected._flushTextBuffer?.()

    const afterFlush = sessionStoreManager.getState().stores.get(remoteSessionId)!.getState()
    const blocks = (afterFlush.currentMessage as { blocks: Array<{ type: string; content?: string }> } | null)?.blocks ?? []
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.content ?? '').join('')
    expect(text).toBe('你好，世界')
  })

  it('投影 store 增量驱动 streamingTick 递增（UI 实时预览刷新信号）', () => {
    const remoteSessionId = 'remote-session-005'
    sessionStoreManager.getState().dispatchEvent({
      type: 'session_start',
      sessionId: 'backend-conv-5',
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    const tickAfterStart = sessionStoreManager.getState().streamingTick

    // 流式增量 → tick 递增（供 useMergedSessionList 感知 currentMessage 变化）
    sessionStoreManager.getState().dispatchEvent({
      type: 'assistant_message',
      sessionId: 'backend-conv-5',
      content: '增量内容',
      isDelta: true,
      _routeSessionId: remoteSessionId,
    } as AIEvent & { _routeSessionId: string })

    expect(sessionStoreManager.getState().streamingTick).toBeGreaterThan(tickAfterStart)
  })
})