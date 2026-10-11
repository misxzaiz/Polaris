/**
 * messageSync — S3 阶段 1 + Phase4：桌面端消息 → 后端共享 SQLite（渐进方案 A）
 *
 * 目标：让桌面端发送的消息（user + assistant）写入后端 `<DataRoot>/session-v2/messages.db`，
 * 供 Web 端经共享 EventBroadcaster 实时拉取（阶段 2/3 接线后）；Phase 4 扩展到
 * 流式期间「边打边」实时更新（assistant 增量 revise 广播）。
 *
 * 设计（对齐 `plans/s3-message-realtime-sync-phase1-3.md` + `...-phase4-streaming.md`）：
 * - **全量写，不增量**：每次「消息完成」后，把该会话当前全部 messages 写 SQLite。
 *   幂等由后端 `INSERT OR IGNORE`(id+version) 兜底，重复写安全。
 * - **非侵入**：不重写 `createConversationStore`（2500+ 行）。由 sendMessage/finishMessage
 *   成功路径调用本模块的 `syncSessionToShared`，fire-and-forget。
 * - **conversationId 为 null 时不写**（首轮：发消息时后端会话尚未分配）：
 *   调用方应在 conversationId 确定后（首轮 request 返回 / 后续轮次）再同步。
 *   这天然实现「首轮回填」——首轮 user+assistant 一起补写，流水完整。
 * - **流式增量（Phase 4）**：`syncStreamingMessage` 在流式期间被 store 防抖调用，
 *   首帧 `append`(version 1) 后续 `revise`(新 version)，让另一端实时看到打字。
 * - **防重复**：模块级 `Map<sessionId, Set<messageId>>` 记录已写消息 id，
 *   既防同轮重复写，又避免流式期间反复写同一消息。
 *
 * 转换：`MessageEntry.content` = 完整 ChatMessage JSON 序列化（设计既定位），
 * 不做逐字段翻译；Web 端还原时 `JSON.parse`。
 */

import { V2MessageLog } from './core/v2-message-log'
import type { MessageEntry, MessageRole } from './core/types'
import { getDeviceId } from '@/utils/deviceId'
import { createLogger } from '@/utils/logger'
import type { ChatMessage } from '@/types/chat'

const log = createLogger('MessageSync')

/** 后端 SQLite 消息日志（阶段 1：V2MessageLog 封装全部 message_* 命令） */
const sharedMessageLog = new V2MessageLog()

/** 已同步水位：sessionId → 已写消息 id 集合（防重复写，fire-and-forget 的幂等兜底） */
const syncedMessageIds = new Map<string, Set<string>>()

/**
 * 单条 ChatMessage → MessageEntry。
 *
 * - `content` = 完整消息 JSON 序列化（含 type/blocks/attachments 等，Web 端可完整还原）。
 * - `role`：user/assistant 直接映射；tool/tool_group/system 归入 'system'（后端只接受三类）。
 * - `deviceId`：本端标识。
 * - `version` 恒为 1（本阶段不做修订链，每次整写为初始版本；修订走阶段 5）。
 */
function toMessageEntry(
  msg: ChatMessage,
  conversationId: string,
  timestampMs: number,
): MessageEntry {
  const role: MessageRole =
    msg.type === 'user' ? 'user' : msg.type === 'assistant' ? 'assistant' : 'system'
  return {
    id: msg.id,
    conversationId,
    role,
    timestamp: timestampMs,
    deviceId: getDeviceId(),
    content: JSON.parse(JSON.stringify(msg)),
    version: 1,
  }
}

/**
 * 把某会话的完整消息数组同步到后端 SQLite（fire-and-forget）。
 *
 * @param sessionId 前端会话 id（用于防重复水位 key）
 * @param conversationId 后端引擎会话 id（== MessageEntry.conversationId；**非空时才有意义**）
 * @param messages 该会话当前完整消息数组（已完成的；不含流式中 currentMessage）
 *
 * 返回写入是否全部成功；失败不抛错（fire-and-forget 语义，由调用方决定是否 log）。
 */
export async function syncSessionToShared(
  sessionId: string,
  conversationId: string | null,
  messages: readonly ChatMessage[],
): Promise<boolean> {
  if (!conversationId) {
    // 首轮：conversationId 尚未分配。调用方应在 request 返回后（含首轮 user+assistant）
    // 重新调用本函数。这里直接跳过，不产生占位垃圾。
    return false
  }

  let wrote = new Set(syncedMessageIds.get(sessionId) ?? new Set<string>())
  const toAppend: MessageEntry[] = []

  for (const msg of messages) {
    if (wrote.has(msg.id)) continue // 已同步过（幂等水位）
    toAppend.push(
      toMessageEntry(msg, conversationId, new Date(msg.timestamp).getTime()),
    )
  }

  if (toAppend.length === 0) return true

  const settled = await Promise.allSettled(
    toAppend.map((entry) => sharedMessageLog.append(entry)),
  )
  // 幂等语义：append 返回 true=新写、false=已存在（INSERT OR IGNORE 跳过）。
  // 两者都视为「消息已在后端」，算成功；仅 rejected（命令错误）才算失败。
  const okIds: string[] = []
  let failed = 0
  settled.forEach((res, i) => {
    if (res.status === 'fulfilled') {
      okIds.push(toAppend[i].id) // true 与 false 都视为已写
      return
    }
    failed += 1
    log.warn('消息 append 失败', { messageId: toAppend[i].id, error: String(res.reason) })
  })
  for (const id of okIds) wrote.add(id)
  syncedMessageIds.set(sessionId, wrote)

  if (failed > 0) {
    log.warn('部分消息同步后端失败', {
      sessionId,
      conversationId,
      total: toAppend.length,
      ok: okIds.length,
      failed,
    })
  }
  return failed === 0
}

/**
 * 会话删除时清理同步水位（可选；避免 Map 无限增长）。
 */
export function clearSyncedWatermark(sessionId: string): void {
  syncedMessageIds.delete(sessionId)
}

/**
 * S3 Phase 4：流式增量同步单条消息（assistant 边打边写共享库 + 实时广播）。
 *
 * 在 store 流式 flush（appendTextBlock 段落级或防抖）后调用：
 * - 该消息 id **未写入**水位 → `append`（version 1，创建 v1 并广播）；
 * - 已写入 → `revise`（新 version，后端广播最新版 entry）。
 *
 * 通过 `syncedMessageIds` 与 `syncSessionToShared` 共享同一水位，
 * 防止流式期间和 finishMessage 整轮回填对同一消息重复 append。
 *
 * @param updateId 后端会话 id（**非空**；null 时跳过，流式开始前 conversationId 未定义）
 * @param sessionId 前端会话 id（水位 key）
 * @param msg 流式中当前 assistant 消息（含最新 blocks + isStreaming）
 *
 * fire-and-forget：所有错误内部 log，不向外抛。调用方每防抖 tick 一次即可。
 */
export async function syncStreamingMessage(
  sessionId: string,
  conversationId: string | null,
  msg: ChatMessage,
): Promise<void> {
  if (!conversationId) return
  // 只同步 assistant 流式消息（会话过程中 user 消息由 syncSessionToShared 负责）
  if (msg.type !== 'assistant') return

  try {
    const wrote = syncedMessageIds.get(sessionId) ?? new Set<string>()
    const timestampMs = msg.timestamp
      ? new Date(msg.timestamp).getTime()
      : Date.now()

    if (!wrote.has(msg.id)) {
      // 首次：append v1
      const entry = toMessageEntry(msg, conversationId, timestampMs)
      await sharedMessageLog.append(entry)
      wrote.add(msg.id)
      syncedMessageIds.set(sessionId, wrote)
      log.debug('流式消息首帧已写', { sessionId, conversationId, messageId: msg.id })
    } else {
      // 后续：revise 新版本（后端保留版本链，read 返回最新）
      await sharedMessageLog.revise(msg.id, JSON.parse(JSON.stringify(msg)))
      log.debug('流式消息已修订', { sessionId, conversationId, messageId: msg.id })
    }
  } catch (e) {
    // fire-and-forget：容忍竞态（append 尚未完成 / 后端瞬时错误），下个防抖 tick 重试。
    log.warn('流式同步失败（容忍，下个 tick 重试）', { messageId: msg.id, error: String(e) })
  }
}
