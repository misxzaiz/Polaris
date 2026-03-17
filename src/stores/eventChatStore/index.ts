/**
 * EventChatStore - 事件驱动的聊天状态管理
 *
 * 基于 Zustand slice 模式组织代码，将大型 store 拆分为多个职责单一的 slice。
 *
 * 架构说明：
 * 1. Tauri 'chat-event' → EventRouter → AIEvent（后端已转换）
 * 2. EventBus.emit() → DeveloperPanel（调试面板）
 * 3. handleAIEvent() → 本地状态更新
 *
 * Slice 结构：
 * - messageSlice: 消息 CRUD 和流式消息构建
 * - sessionSlice: 会话状态（ID、流式状态、错误）
 * - historySlice: 存储持久化和历史管理
 * - eventHandlerSlice: 事件监听和消息发送
 */

import { create } from 'zustand'
import type { EventChatState } from './types'
import { createMessageSlice } from './messageSlice'
import { createSessionSlice } from './sessionSlice'
import { createHistorySlice } from './historySlice'
import { createEventHandlerSlice } from './eventHandlerSlice'

/**
 * 事件驱动的 Chat Store
 *
 * 组合所有 slice 创建统一的 store
 */
export const useEventChatStore = create<EventChatState>()((...a) => ({
  ...createMessageSlice(...a),
  ...createSessionSlice(...a),
  ...createHistorySlice(...a),
  ...createEventHandlerSlice(...a),
}))

// 导出类型
export type {
  EventChatState,
  MessageState,
  SessionState,
  EventHandlerState,
  HistoryState,
  CurrentAssistantMessage,
  UnifiedHistoryItem,
  ProviderSessionCache,
} from './types'

// 导出常量
export {
  MAX_MESSAGES,
  MESSAGE_ARCHIVE_THRESHOLD,
  BATCH_LOAD_COUNT,
  STORAGE_KEY,
  STORAGE_VERSION,
  SESSION_HISTORY_KEY,
  MAX_SESSION_HISTORY,
} from './types'
