/**
 * EventChatStore 重导出
 *
 * 保持向后兼容性，从新的 slice 结构导出
 *
 * @deprecated 请直接从 './eventChatStore/index' 导入
 */

export {
  useEventChatStore,
  type EventChatState,
  type MessageState,
  type SessionState,
  type EventHandlerState,
  type HistoryState,
  type CurrentAssistantMessage,
  type UnifiedHistoryItem,
  type ProviderSessionCache,
  MAX_MESSAGES,
  MESSAGE_ARCHIVE_THRESHOLD,
  BATCH_LOAD_COUNT,
  STORAGE_KEY,
  STORAGE_VERSION,
  SESSION_HISTORY_KEY,
  MAX_SESSION_HISTORY,
} from './eventChatStore/index'