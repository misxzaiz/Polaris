/**
 * 会话消息同步模块
 *
 * 负责 SessionStore 和 EventChatStore 之间的消息同步
 *
 * 设计说明：
 * - EventChatStore 作为"活跃消息缓存"，UI 组件从这里读取消息
 * - SessionStore.sessionMessages 作为"持久化存储"，每个会话的消息独立保存
 * - 会话切换时通过此模块同步消息
 *
 * 同步流程：
 * 1. 切换会话前：保存当前 EventChatStore 消息到 SessionStore
 * 2. 切换会话后：加载目标会话消息到 EventChatStore
 */

import { useEventChatStore } from './eventChatStore'
import { useSessionStore } from './sessionStore'
import type { ChatMessage } from '../types'
import { createLogger } from '../utils/logger'

const log = createLogger('SessionSync')

/**
 * 保存当前会话的消息状态到 SessionStore
 *
 * @param sessionId 要保存的会话 ID
 */
export function saveCurrentMessagesToSession(sessionId: string): void {
  const eventChatState = useEventChatStore.getState()
  const sessionSyncActions = eventChatState.getSessionSyncActions()

  if (!sessionSyncActions) {
    log.warn('SessionSyncActions 未注入，无法保存消息')
    return
  }

  // 获取当前消息状态
  const { messages, archivedMessages, conversationId } = eventChatState

  // 保存到 SessionStore
  sessionSyncActions.setSessionMessages(sessionId, {
    messages,
    archivedMessages,
    conversationId,
  })

  log.debug('保存会话消息', {
    sessionId,
    messageCount: messages.length,
    archivedCount: archivedMessages.length,
    conversationId,
  })
}

/**
 * 加载目标会话的消息状态到 EventChatStore
 *
 * @param sessionId 要加载的会话 ID
 * @returns 是否成功加载
 */
export function loadSessionMessagesToEventChat(sessionId: string): boolean {
  const eventChatState = useEventChatStore.getState()
  const sessionSyncActions = eventChatState.getSessionSyncActions()

  if (!sessionSyncActions) {
    log.warn('SessionSyncActions 未注入，无法加载消息')
    return false
  }

  // 从 SessionStore 获取消息状态
  const sessionMessages = sessionSyncActions.getSessionMessages(sessionId)

  if (!sessionMessages) {
    // 没有保存的消息，初始化为空状态
    log.debug('会话无保存消息，初始化为空', { sessionId })

    // 清空 EventChatStore（保留事件监听器）
    clearEventChatState()

    // 更新会话状态为 idle
    sessionSyncActions.updateSessionStatus(sessionId, 'idle')

    return true
  }

  // 检查是否正在流式传输
  if (eventChatState.isStreaming) {
    log.warn('当前正在流式传输，无法切换会话')
    return false
  }

  // 清空当前状态（保留事件监听器）
  clearEventChatState()

  // 加载会话消息到 EventChatStore
  useEventChatStore.setState({
    messages: sessionMessages.messages as ChatMessage[],
    archivedMessages: (sessionMessages.archivedMessages || []) as ChatMessage[],
    conversationId: sessionMessages.conversationId || null,
    isStreaming: false,
    error: null,
    currentMessage: null,
    progressMessage: null,
  })

  log.debug('加载会话消息', {
    sessionId,
    messageCount: sessionMessages.messages.length,
    archivedCount: sessionMessages.archivedMessages?.length || 0,
    conversationId: sessionMessages.conversationId,
  })

  // 更新会话状态
  sessionSyncActions.updateSessionStatus(sessionId, 'idle')

  return true
}

/**
 * 切换会话（带消息同步）
 *
 * 流程：
 * 1. 保存当前会话消息
 * 2. 切换 SessionStore 的 activeSessionId
 * 3. 加载目标会话消息
 *
 * @param targetSessionId 目标会话 ID
 * @returns 是否成功切换
 */
export function switchSessionWithSync(targetSessionId: string): boolean {
  const { activeSessionId, sessions } = useSessionStore.getState()

  // 检查目标会话是否存在
  if (!sessions.has(targetSessionId)) {
    log.warn('目标会话不存在', { targetSessionId })
    return false
  }

  // 如果切换到同一个会话，不做任何操作
  if (activeSessionId === targetSessionId) {
    log.debug('切换到当前会话，无需操作', { targetSessionId })
    return true
  }

  // 检查是否正在流式传输
  const eventChatState = useEventChatStore.getState()
  if (eventChatState.isStreaming) {
    log.warn('当前正在流式传输，无法切换会话')
    // 可以考虑中断流式传输后切换，但这需要用户确认
    return false
  }

  // 1. 保存当前会话消息（如果有活跃会话）
  if (activeSessionId) {
    saveCurrentMessagesToSession(activeSessionId)
  }

  // 2. 切换 SessionStore 的 activeSessionId
  useSessionStore.getState().switchSession(targetSessionId)

  // 3. 加载目标会话消息
  const success = loadSessionMessagesToEventChat(targetSessionId)

  if (success) {
    log.info('会话切换成功', {
      from: activeSessionId,
      to: targetSessionId,
    })
  }

  return success
}

/**
 * 清空 EventChatStore 的消息状态（保留事件监听器）
 */
function clearEventChatState(): void {
  const eventChatState = useEventChatStore.getState()

  // 清理 Provider Session
  if (eventChatState.providerSessionCache?.session) {
    try {
      eventChatState.providerSessionCache.session.dispose()
    } catch (e) {
      log.warn('清理 Provider Session 失败', { error: String(e) })
    }
  }

  // 清理工具面板
  const toolPanelActions = eventChatState.getToolPanelActions()
  if (toolPanelActions) {
    toolPanelActions.clearTools()
  }

  // 重置状态（保留事件监听器状态）
  useEventChatStore.setState({
    messages: [],
    archivedMessages: [],
    conversationId: null,
    currentConversationSeed: null,
    isStreaming: false,
    error: null,
    progressMessage: null,
    currentMessage: null,
    toolBlockMap: new Map(),
    questionBlockMap: new Map(),
    planBlockMap: new Map(),
    activePlanId: null,
    agentRunBlockMap: new Map(),
    activeTaskId: null,
    toolGroupBlockMap: new Map(),
    pendingToolGroup: null,
    permissionRequestBlockMap: new Map(),
    activePermissionRequestId: null,
    providerSessionCache: null,
  })
}

/**
 * 初始化 SessionSyncActions 依赖注入
 *
 * 在应用启动时调用，将 SessionStore 的方法注入到 EventChatStore
 */
export function initializeSessionSync(): void {
  useEventChatStore.getState().setDependencies({
    ...useEventChatStore.getState()._dependencies,
    sessionSyncActions: {
      getActiveSessionId: () => useSessionStore.getState().activeSessionId,
      getSessionMessages: (sessionId: string) => {
        const state = useSessionStore.getState().getSessionMessages(sessionId)
        return state ? {
          messages: state.messages,
          archivedMessages: state.archivedMessages,
          conversationId: state.conversationId,
        } : undefined
      },
      setSessionMessages: (sessionId: string, state: { messages: unknown[]; archivedMessages?: unknown[]; conversationId?: string | null }) => {
        useSessionStore.getState().setSessionMessages(sessionId, state)
      },
      updateSessionStatus: (sessionId: string, status: 'idle' | 'running' | 'waiting' | 'error') => {
        useSessionStore.getState().updateSessionStatus(sessionId, status)
      },
    },
  })

  log.info('SessionSync 初始化完成')
}