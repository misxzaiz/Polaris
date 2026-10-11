/**
 * MessageRealtimeSubscription — S3 阶段 3：Web 端实时合并远端消息（渐进方案 A）
 *
 * 目标：桌面端发消息 → 后端广播 `chat-message-upserted` → Web 端 WS 订阅 →
 * 把消息 upsert 进对应会话 store，气泡实时出现（无需「恢复」）。
 *
 * 设计（对齐 `plans/s3-message-realtime-sync-phase1-3.md` 已拍板项）：
 * - **纯事件驱动**：不轮询。断线 gap 由 EventBroadcaster 重放缓冲（seq）兜底，
 *   本阶段消费最新广播即可（阶段 5 再补完整 gap repair）。
 * - **conversationId 路由**：用现成 `findStoreByConversationId` 找 Web 端对应 store。
 * - **去重**：store.messages 已有该 id → 跳过（防自广播回环 + 幂等）。
 * - **会话未打开**：无 store → 忽略（由会话索引投影 + 恢复兜底，本阶段不做后台填充）。
 * - **还原**：MessageEntry.content = 完整 ChatMessage JSON，`JSON.parse` 还原。
 */

import { listen } from '@/services/transport'
import { findStoreByConversationId } from '@/stores/conversationStore/sessionStoreManager'
import { createLogger } from '@/utils/logger'
import type { ChatMessage } from '@/types/chat'

const log = createLogger('MessageRealtime')

/** 广播事件名（对齐后端 broadcast_message_appended） */
const EVENT_MESSAGE_UPSERTED = 'chat-message-upserted'

/** 广播 payload（对齐后端 serde 序列化，camelCase） */
interface MessageUpsertedPayload {
  conversationId: string
  message: {
    id: string
    conversationId: string
    role: 'user' | 'assistant' | 'system'
    timestamp: number
    deviceId: string
    content: unknown
    version: number
  }
}

/** WS 退订函数（stop 时清理） */
let unsubscribe: (() => void) | null = null

/**
 * 启动消息实时订阅（Web 端消费）。
 * 幂等：可重复调用，已订阅则 no-op。
 */
export async function startMessageRealtimeSubscription(): Promise<void> {
  if (unsubscribe) return
  try {
    unsubscribe = await listen<MessageUpsertedPayload>(
      EVENT_MESSAGE_UPSERTED,
      handleMessageUpserted,
    )
    log.info('消息实时订阅已启动')
  } catch (e) {
    log.warn('启动消息实时订阅失败（桌面端无事件源时正常）', { error: String(e) })
  }
}

/** 停止订阅 */
export async function stopMessageRealtimeSubscription(): Promise<void> {
  if (!unsubscribe) return
  try {
    unsubscribe()
  } catch (e) {
    log.warn('停止消息实时订阅失败', { error: String(e) })
  }
  unsubscribe = null
}

/**
 * 处理一条广播送达的消息：路由到对应会话 store，合并进消息列表。
 */
function handleMessageUpserted(payload: MessageUpsertedPayload): void {
  if (!payload || !payload.conversationId || !payload.message) return

  const { conversationId, message } = payload
  const store = findStoreByConversationId(conversationId)
  if (!store) {
    // 会话未打开：忽略（会话索引投影引导用户打开 + 恢复兜底）。
    log.debug('收到远端消息但本端未打开该会话，跳过', { conversationId, messageId: message.id })
    return
  }

  // 还原 ChatMessage（MessageEntry.content = 完整 ChatMessage JSON）
  let chatMessage: ChatMessage
  try {
    chatMessage = JSON.parse(JSON.stringify(message.content)) as ChatMessage
  } catch (e) {
    log.warn('还原远端消息失败，跳过', { messageId: message.id, error: String(e) })
    return
  }
  if (!chatMessage || typeof chatMessage.id !== 'string' || typeof chatMessage.type !== 'string') {
    log.warn('远端消息 content 结构异常，跳过', { messageId: message.id })
    return
  }

  // 去重：本端已存在该消息 id → 跳过（防自广播回环 + 幂等）
  const exists = store.messages.some((m) => m.id === chatMessage.id)
  if (exists) return

  store.addMessage(chatMessage)
  log.info('远端消息已合并进会话', { conversationId, messageId: chatMessage.id, type: chatMessage.type })
}