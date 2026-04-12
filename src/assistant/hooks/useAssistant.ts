import { useCallback } from 'react'
import { useAssistantStore } from '../store/assistantStore'
import { getAssistantEngine } from '../core/AssistantEngine'
import type { CompletionNotification } from '../types'

/**
 * 助手交互 Hook
 */
export function useAssistant() {
  const store = useAssistantStore()

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || store.isLoading) return

    store.setLoading(true)
    store.setError(null)

    try {
      const engine = getAssistantEngine()
      for await (const _ of engine.processMessage(content)) {
        // 处理事件
      }
    } catch (error) {
      store.setError((error as Error).message)
    } finally {
      store.setLoading(false)
    }
  }, [store])

  const abort = useCallback(async () => {
    await store.abortAllSessions()
    store.setLoading(false)
  }, [store])

  /**
   * 处理完成通知
   */
  const handleNotification = useCallback(async (
    notification: CompletionNotification,
    handleType: 'immediate' | 'delayed' | 'ignored'
  ) => {
    store.markNotificationHandled(notification.id, handleType)

    // 立即处理：将结果反馈给 AI
    if (handleType === 'immediate' && notification.fullResult) {
      store.setLoading(true)
      try {
        const engine = getAssistantEngine()
        // 通过 AI 处理结果
        for await (const _ of engine.processMessage(
          `后台任务已完成。\n\n执行的提示词：${notification.prompt}\n\n执行结果：\n${notification.fullResult}\n\n请根据以上结果继续处理。`
        )) {
          // 处理事件
        }
      } catch (error) {
        store.setError((error as Error).message)
      } finally {
        store.setLoading(false)
      }
    }
  }, [store])

  return {
    // 状态
    messages: store.messages,
    isLoading: store.isLoading,
    error: store.error,
    sessions: store.getAllClaudeCodeSessions(),
    runningSessions: store.getRunningSessions(),
    notifications: store.completionNotifications,
    pendingNotifications: store.getPendingNotifications(),
    hasUnreadNotifications: store.hasUnreadNotifications,

    // 操作
    sendMessage,
    abort,
    clearMessages: store.clearMessages,
    handleNotification,

    // UI
    executionPanelExpanded: store.executionPanelExpanded,
    toggleExecutionPanel: store.toggleExecutionPanel,
  }
}
