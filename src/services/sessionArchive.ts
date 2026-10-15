/**
 * 后端消息库读取（S6：中断轮次的兜底副本）
 *
 * 归档（JSONL）由前端在轮末整体覆写——内容最完整（富块/附件/表单卡片），是历史列表
 * 与恢复的常规数据源。但**客户端中途关闭**时前端不在场，该轮只有后端累加器写下的
 * 派生副本（`session-v2/messages.db`）。此模块把这份副本读出来，供恢复时补全
 * 「归档里还没有的进行中轮次」。
 *
 * 只读，不改写任何状态；失败返回空数组（不影响恢复主流程）。
 */

import { invoke } from '@/services/transport'
import type { ChatMessage } from '@/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionBackendMessages')

/** 后端消息库条目（`message_read` 返回形状，见 Rust `MessageEntry`） */
interface BackendMessageEntry {
  id: string
  conversationId: string
  role: string
  timestamp: number
  content: ChatMessage
}

/**
 * 读取后端消息库中的会话消息（每 id 最新版，按时间升序）。
 *
 * 用途：客户端中途关闭时归档尚未包含本轮，消息库在流式期间就有内容
 * （含被中断的部分），恢复时可据此补全。
 */
export async function loadBackendMessages(conversationId: string): Promise<ChatMessage[]> {
  if (!conversationId) return []
  try {
    const entries = await invoke<BackendMessageEntry[]>('message_read', { conversationId })
    return (entries ?? [])
      .map((e) => e?.content)
      .filter((c): c is ChatMessage => !!c && typeof c === 'object' && 'type' in c)
  } catch (e) {
    log.warn('读取后端会话消息失败', { conversationId, error: String(e) })
    return []
  }
}
