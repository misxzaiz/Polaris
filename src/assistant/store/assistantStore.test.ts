import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAssistantStore, initializeAssistantStore } from './assistantStore'
import type { AssistantMessage, CompletionNotification } from '../types'

// Mock ClaudeCodeSessionManager
vi.mock('../core/ClaudeCodeSessionManager', () => ({
  getClaudeCodeSessionManager: () => ({
    createSession: (type: string, label?: string) => {
      const id = type === 'primary' ? 'primary' : `${type}-${Date.now()}`
      return id
    },
    getSession: (id: string) => ({
      id,
      type: id === 'primary' ? 'primary' : 'analysis',
      status: 'idle',
      label: id === 'primary' ? '主会话' : '分析任务',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      events: [],
    }),
    executeInSession: vi.fn(),
    abortSession: vi.fn(),
  }),
}))

describe('assistantStore', () => {
  beforeEach(() => {
    // 重置 store
    useAssistantStore.setState({
      messages: [],
      isLoading: false,
      claudeCodeSessions: new Map(),
      activeClaudeCodeSessionId: null,
      executionPanelExpanded: false,
      executionPanelSessionId: null,
      error: null,
      completionNotifications: [],
      hasUnreadNotifications: false,
    })
  })

  it('should add message', () => {
    const message: AssistantMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    }
    useAssistantStore.getState().addMessage(message)
    expect(useAssistantStore.getState().messages).toHaveLength(1)
    expect(useAssistantStore.getState().messages[0].content).toBe('Hello')
  })

  it('should clear messages', () => {
    useAssistantStore.getState().addMessage({
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    })
    useAssistantStore.getState().clearMessages()
    expect(useAssistantStore.getState().messages).toHaveLength(0)
  })

  it('should set loading state', () => {
    useAssistantStore.getState().setLoading(true)
    expect(useAssistantStore.getState().isLoading).toBe(true)
  })

  it('should set error', () => {
    useAssistantStore.getState().setError('Test error')
    expect(useAssistantStore.getState().error).toBe('Test error')
  })

  it('should create primary session on initialize', () => {
    initializeAssistantStore()
    const sessions = useAssistantStore.getState().getAllClaudeCodeSessions()
    expect(sessions.length).toBeGreaterThan(0)
  })

  it('should toggle execution panel', () => {
    expect(useAssistantStore.getState().executionPanelExpanded).toBe(false)
    useAssistantStore.getState().toggleExecutionPanel()
    expect(useAssistantStore.getState().executionPanelExpanded).toBe(true)
  })
})

describe('assistantStore - notifications', () => {
  beforeEach(() => {
    useAssistantStore.setState({
      messages: [],
      isLoading: false,
      claudeCodeSessions: new Map(),
      activeClaudeCodeSessionId: null,
      executionPanelExpanded: false,
      executionPanelSessionId: null,
      error: null,
      completionNotifications: [],
      hasUnreadNotifications: false,
    })
  })

  it('should add completion notification', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
    }
    useAssistantStore.getState().addCompletionNotification(notification)
    expect(useAssistantStore.getState().completionNotifications).toHaveLength(1)
    expect(useAssistantStore.getState().hasUnreadNotifications).toBe(true)
  })

  it('should get pending notifications', () => {
    const notification1: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt 1',
      resultSummary: 'Test summary 1',
      createdAt: Date.now(),
      handled: false,
    }
    const notification2: CompletionNotification = {
      id: 'notif-2',
      sessionId: 'session-2',
      toolCallId: 'tool-2',
      prompt: 'Test prompt 2',
      resultSummary: 'Test summary 2',
      createdAt: Date.now(),
      handled: true,
    }
    useAssistantStore.getState().addCompletionNotification(notification1)
    useAssistantStore.getState().addCompletionNotification(notification2)
    const pending = useAssistantStore.getState().getPendingNotifications()
    expect(pending).toHaveLength(1)
    expect(pending[0].id).toBe('notif-1')
  })

  it('should mark notification as handled', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
    }
    useAssistantStore.getState().addCompletionNotification(notification)
    useAssistantStore.getState().markNotificationHandled('notif-1', 'immediate')
    const notif = useAssistantStore.getState().completionNotifications.find(n => n.id === 'notif-1')
    expect(notif?.handled).toBe(true)
    expect(notif?.handleType).toBe('immediate')
    expect(useAssistantStore.getState().hasUnreadNotifications).toBe(false)
  })

  it('should update notification error and increment retry count', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
      retryCount: 0,
    }
    useAssistantStore.getState().addCompletionNotification(notification)
    useAssistantStore.getState().updateNotificationError('notif-1', 'Test error')
    const notif = useAssistantStore.getState().completionNotifications.find(n => n.id === 'notif-1')
    expect(notif?.lastError).toBe('Test error')
    expect(notif?.retryCount).toBe(1)
  })

  it('should clear all notifications', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
    }
    useAssistantStore.getState().addCompletionNotification(notification)
    useAssistantStore.getState().clearNotifications()
    expect(useAssistantStore.getState().completionNotifications).toHaveLength(0)
    expect(useAssistantStore.getState().hasUnreadNotifications).toBe(false)
  })

  it('should mark notification as auto reported', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
    }
    useAssistantStore.getState().addCompletionNotification(notification)
    useAssistantStore.getState().markNotificationAutoReported('notif-1')
    const notif = useAssistantStore.getState().completionNotifications.find(n => n.id === 'notif-1')
    expect(notif?.autoReported).toBe(true)
  })

  it('should support autoReported field in notification', () => {
    const notification: CompletionNotification = {
      id: 'notif-1',
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      prompt: 'Test prompt',
      resultSummary: 'Test summary',
      createdAt: Date.now(),
      handled: false,
      autoReported: false,
    }
    expect(notification.autoReported).toBe(false)

    useAssistantStore.getState().addCompletionNotification(notification)
    useAssistantStore.getState().markNotificationAutoReported('notif-1')
    const notif = useAssistantStore.getState().completionNotifications.find(n => n.id === 'notif-1')
    expect(notif?.autoReported).toBe(true)
  })
})
