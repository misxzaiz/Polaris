import { create } from 'zustand'
import type {
  AssistantMessage,
  ClaudeCodeSessionState,
  InvokeClaudeCodeParams,
  ClaudeCodeExecutionEvent,
  CompletionNotification,
} from '../types'
import { getClaudeCodeSessionManager } from '../core/ClaudeCodeSessionManager'

/**
 * 助手 Store 状态
 */
export interface AssistantState {
  // 消息状态
  messages: AssistantMessage[]
  isLoading: boolean
  /** 当前正在流式输出的消息 ID */
  streamingMessageId: string | null

  // Claude Code 会话管理
  claudeCodeSessions: Map<string, ClaudeCodeSessionState>
  activeClaudeCodeSessionId: string | null

  // UI 状态
  executionPanelExpanded: boolean
  executionPanelSessionId: string | null

  // 错误状态
  error: string | null

  // 完成通知队列
  completionNotifications: CompletionNotification[]
  /** 是否有未处理的通知 */
  hasUnreadNotifications: boolean
}

/**
 * 助手 Store 操作
 */
export interface AssistantActions {
  // 消息操作
  addMessage: (message: AssistantMessage) => void
  updateLastAssistantMessage: (content: string) => void
  appendToLastAssistantMessage: (content: string) => void
  clearMessages: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
  setStreamingMessageId: (id: string | null) => void

  // Claude Code 会话管理
  createClaudeCodeSession: (type: 'primary' | 'analysis' | 'background', label?: string) => string
  getClaudeCodeSession: (sessionId: string) => ClaudeCodeSessionState | undefined
  getAllClaudeCodeSessions: () => ClaudeCodeSessionState[]
  getRunningSessions: () => ClaudeCodeSessionState[]
  updateSessionStatus: (sessionId: string, status: ClaudeCodeSessionState['status']) => void
  addSessionEvent: (sessionId: string, event: ClaudeCodeExecutionEvent) => void

  // Claude Code 执行控制
  executeInSession: (sessionId: string, params: InvokeClaudeCodeParams) => Promise<void>
  abortSession: (sessionId: string) => Promise<void>
  abortAllSessions: () => Promise<void>

  // UI 控制
  toggleExecutionPanel: () => void
  setExecutionPanelSession: (sessionId: string | null) => void

  // 完成通知管理
  addCompletionNotification: (notification: CompletionNotification) => void
  getPendingNotifications: () => CompletionNotification[]
  markNotificationHandled: (id: string, handleType: 'immediate' | 'delayed' | 'ignored') => void
  clearNotifications: () => void

  // 初始化
  initialize: () => void
}

export type AssistantStore = AssistantState & AssistantActions

/**
 * 创建助手 Store
 */
export const useAssistantStore = create<AssistantStore>((set, get) => ({
  // 初始状态
  messages: [],
  isLoading: false,
  streamingMessageId: null,
  claudeCodeSessions: new Map(),
  activeClaudeCodeSessionId: null,
  executionPanelExpanded: false,
  executionPanelSessionId: null,
  error: null,
  completionNotifications: [],
  hasUnreadNotifications: false,

  // 消息操作
  addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }))
  },

  updateLastAssistantMessage: (content) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content,
        }
      }
      return { messages }
    })
  },

  appendToLastAssistantMessage: (delta) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content: messages[lastIdx].content + delta,
        }
      }
      return { messages }
    })
  },

  clearMessages: () => {
    set({ messages: [] })
  },

  setLoading: (loading) => {
    set({ isLoading: loading })
  },

  setError: (error) => {
    set({ error })
  },

  setStreamingMessageId: (id) => {
    set({ streamingMessageId: id })
  },

  // Claude Code 会话管理
  createClaudeCodeSession: (type, label) => {
    const manager = getClaudeCodeSessionManager()
    const sessionId = manager.createSession(type, label)

    // 同步状态到 store
    const sessionState = manager.getSession(sessionId)!
    set((state) => {
      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, sessionState)
      return {
        claudeCodeSessions: newSessions,
        activeClaudeCodeSessionId: sessionId,
        executionPanelSessionId: sessionId,
      }
    })

    return sessionId
  },

  getClaudeCodeSession: (sessionId) => {
    return get().claudeCodeSessions.get(sessionId)
  },

  getAllClaudeCodeSessions: () => {
    return Array.from(get().claudeCodeSessions.values())
  },

  getRunningSessions: () => {
    return Array.from(get().claudeCodeSessions.values()).filter(
      (s) => s.status === 'running'
    )
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => {
      const session = state.claudeCodeSessions.get(sessionId)
      if (!session) return state

      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, {
        ...session,
        status,
        lastActiveAt: Date.now(),
      })

      return { claudeCodeSessions: newSessions }
    })
  },

  addSessionEvent: (sessionId, event) => {
    set((state) => {
      const session = state.claudeCodeSessions.get(sessionId)
      if (!session) return state

      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, {
        ...session,
        events: [...session.events, event],
        lastActiveAt: Date.now(),
      })

      return { claudeCodeSessions: newSessions }
    })
  },

  // Claude Code 执行控制
  executeInSession: async (sessionId, params) => {
    const manager = getClaudeCodeSessionManager()

    // 更新状态为运行中
    get().updateSessionStatus(sessionId, 'running')

    try {
      await manager.executeInSession(sessionId, params.prompt)
    } catch (error) {
      get().updateSessionStatus(sessionId, 'error')
      throw error
    }
  },

  abortSession: async (sessionId) => {
    const manager = getClaudeCodeSessionManager()
    await manager.abortSession(sessionId)
    get().updateSessionStatus(sessionId, 'idle')
  },

  abortAllSessions: async () => {
    const runningSessions = get().getRunningSessions()
    await Promise.all(runningSessions.map((s) => get().abortSession(s.id)))
  },

  // UI 控制
  toggleExecutionPanel: () => {
    set((state) => ({
      executionPanelExpanded: !state.executionPanelExpanded,
    }))
  },

  setExecutionPanelSession: (sessionId) => {
    set({
      executionPanelSessionId: sessionId,
      executionPanelExpanded: sessionId !== null,
    })
  },

  // 完成通知管理
  addCompletionNotification: (notification) => {
    set((state) => ({
      completionNotifications: [...state.completionNotifications, notification],
      hasUnreadNotifications: true,
    }))
  },

  getPendingNotifications: () => {
    return get().completionNotifications.filter((n) => !n.handled)
  },

  markNotificationHandled: (id, handleType) => {
    set((state) => {
      const notifications = state.completionNotifications.map((n) =>
        n.id === id ? { ...n, handled: true, handleType } : n
      )
      const hasUnread = notifications.some((n) => !n.handled)
      return { completionNotifications: notifications, hasUnreadNotifications: hasUnread }
    })
  },

  clearNotifications: () => {
    set({ completionNotifications: [], hasUnreadNotifications: false })
  },

  // 初始化
  initialize: () => {
    // 创建 primary 会话
    const hasPrimary = get().claudeCodeSessions.has('primary')
    if (!hasPrimary) {
      get().createClaudeCodeSession('primary', '主会话')
    }
  },
}))

/**
 * 初始化助手 Store
 */
export function initializeAssistantStore(): void {
  useAssistantStore.getState().initialize()
}
