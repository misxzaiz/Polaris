/**
 * V2MessageLog — 阶段 1b：后端 SQLite 消息日志（append-only）
 *
 * 实现 `MessageLogStorage`，所有读写走后端命令（`message_append` /
 * `message_revise` / `message_read` / `message_read_history` /
 * `message_get_latest` / `message_delete_by_conversation`）。
 *
 * 与 InMemoryMessageLog 语义完全一致（幂等 append、修订链、timestamp 升序），
 * 区别仅在持久化层：后端 SQLite（`<DataRoot>/session-v2/messages.db`），
 * 跨设备共享，旧 JSONL（dialogs/*.jsonl）零改动。
 *
 * 通过统一 transport `invoke` 调用：Tauri 模式 IPC、HTTP 模式 Web API 桥
 * （ipc.rs 已注册同名命令路由）。
 */

import { invoke } from '@/services/transport'
import type { MessageEntry, MessageLogStorage, MessageContent, ReadOptions } from './types'

/** 后端命令名（与 src-tauri commands/session_messages.rs + web/api/ipc.rs 对齐） */
const CMD = {
  append: 'message_append',
  revise: 'message_revise',
  read: 'message_read',
  readHistory: 'message_read_history',
  getLatest: 'message_get_latest',
  deleteByConversation: 'message_delete_by_conversation',
} as const

/**
 * 后端 SQLite 消息日志实现
 *
 * 设计：
 * - 无本地缓存（每次操作直接走后端）——本实现用于"后端权威"路径验证；
 *   性能优化（本地缓存 + 订阅推送）留到 V2SessionKernel 阶段。
 * - 幂等语义由后端 INSERT OR IGNORE 保证（同 id+version 重复追加跳过）。
 */
export class V2MessageLog implements MessageLogStorage {
  async append(entry: MessageEntry): Promise<boolean> {
    return invoke<boolean>(CMD.append, { ...entry })
  }

  async revise(id: string, newContent: MessageContent): Promise<number> {
    return invoke<number>(CMD.revise, { id, content: newContent })
  }

  async read(conversationId: string, opts?: ReadOptions): Promise<MessageEntry[]> {
    const args: Record<string, unknown> = { conversationId }
    if (opts?.afterTimestamp != null) args.afterTimestamp = opts.afterTimestamp
    if (opts?.limit != null) args.limit = opts.limit
    return invoke<MessageEntry[]>(CMD.read, args)
  }

  async readHistory(id: string): Promise<MessageEntry[]> {
    return invoke<MessageEntry[]>(CMD.readHistory, { id })
  }

  async getLatest(id: string): Promise<MessageEntry | null> {
    return invoke<MessageEntry | null>(CMD.getLatest, { id })
  }

  async deleteByConversation(conversationId: string): Promise<void> {
    await invoke<void>(CMD.deleteByConversation, { conversationId })
  }
}
