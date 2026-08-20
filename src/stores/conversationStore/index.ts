/**
 * ConversationStore 模块入口
 *
 * 提供会话级别的 Store 架构，支持：
 * - 每个会话独立的 Store 实例
 * - 多会话同时运行（后台运行）
 * - 事件按 sessionId 路由
 */

export { createConversationStore } from './createConversationStore'
export { handleAIEvent } from './eventHandler'
export {
  sessionStoreManager,
  createSessionManagerStore,
  useActiveConversationStore,
  useConversationStore,
  useSessionMetadataList,
  useActiveSessionId,
  useBackgroundSessions,
  useCompletedNotifications,
  useSessionManagerActions,
} from './sessionStoreManager'
export {
  useActiveSession,
  useActiveSessionChat,
  useActiveSessionMessages,
  useActiveSessionStreaming,
  useActiveSessionError,
  useActiveSessionActions,
  useActiveSessionBlockMaps,
  useHasPendingQuestion,
  useHasActivePlan,
  usePendingQuestions,
  // 指定会话的 hooks（用于多窗口场景）
  useSessionMessages,
  useSessionStreaming,
  useSessionError,
  useSessionHasPendingQuestion,
} from './useActiveSession'

export type {
  ConversationStore,
  ConversationState,
  ConversationActions,
  SessionStoreManager,
  SessionManagerState,
  SessionManagerActions,
  SessionMetadata,
  CreateSessionOptions,
} from './types'