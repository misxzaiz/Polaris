/**
 * sessionMapping — S5：sessionId ↔ conversationId 三轨映射（共享 SQLite 定位）
 *
 * 封装后端 `session_mapping` 表（session_state.rs）的三条命令：
 * - `session_mapping_resolve`：前端 sessionId → 完整映射（含 conversationId）
 * - `session_mapping_find_by_conversation`：conversationId → 映射（反查）
 * - `session_mapping_upsert`：写入/更新映射
 *
 * 用途：
 * - 写：首轮 conversationId 确定后（sendMessage start 返回）调 upsert，
 *   把「前端会话 id ↔ 引擎会话 id」固化到共享 SQLite；
 * - 读：恢复远端会话时 resolve，用 conversationId 定位共享消息库。
 */

import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('SessionMapping')

/** 映射条目（对齐后端 SessionMapping，camelCase） */
export interface SessionMapping {
  sessionId: string
  conversationId: string
  externalId?: string
  workspaceKey: string
  archived: boolean
  createdAt: number
}

/** 按前端 sessionId 解析映射（不存在返回 null） */
export async function resolveSessionMapping(
  sessionId: string,
): Promise<SessionMapping | null> {
  try {
    return await invoke<SessionMapping | null>('session_mapping_resolve', { sessionId })
  } catch (e) {
    log.warn('解析会话映射失败', { sessionId, error: String(e) })
    return null
  }
}

/** 按 conversationId 反查映射（不存在返回 null） */
export async function findMappingByConversation(
  conversationId: string,
): Promise<SessionMapping | null> {
  try {
    return await invoke<SessionMapping | null>('session_mapping_find_by_conversation', {
      conversationId,
    })
  } catch (e) {
    log.warn('按会话反查映射失败', { conversationId, error: String(e) })
    return null
  }
}

/** 写入/更新映射（fire-and-forget 友好：失败仅 log） */
export async function upsertSessionMapping(
  sessionId: string,
  conversationId: string,
  workspaceKey: string,
  externalId?: string,
): Promise<void> {
  try {
    await invoke<SessionMapping>('session_mapping_upsert', {
      sessionId,
      conversationId,
      externalId,
      workspaceKey,
    })
  } catch (e) {
    log.warn('写入会话映射失败', { sessionId, conversationId, error: String(e) })
  }
}
