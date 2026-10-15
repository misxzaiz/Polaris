/**
 * 恢复读取侧的「按消息 id 去重」工具。
 *
 * 背景：流式 checkpoint 会把"进行中的 assistant 消息"以同 id 增量追加到 JSONL
 * （同 id 多行 = 同一消息的不同快照，最后一行内容最新）；而后端 `dialog_read_page`
 * 是纯追加不做去重，前端读取时必须按 id 收敛：
 * - 保留「首次出现的位置 + 最后一次出现的内容」（与 jsonlCodec parseDialogLines 同规则）
 * - 全局全量读取（getConversation）已由 parseDialogLines 去重，无需再处理；
 *   本工具只用于**尾部优先分页（只 parse 一页）**与**恢复注入**路径。
 *
 * 归一化：流式 checkpoint 快照带 `isStreaming: true` 落盘；历史恢复后已无流式，
 * 若恢复时不处理，末条快照会被当成"进行中消息"，与后端引擎上下文不一致。
 * 恢复侧统一把它归一为**中断态完整消息**：isStreaming 置 false 并标记 interrupted，
 * 保留已输出的 blocks 供展示；同时对已经完整的消息补 timestamp（隔离已有 checkpoint
 * 写入的写侧缺省 timestamp 的历史遗留）。
 */
import type { ChatMessage } from '@/types'

export function dedupeMessagesById<T extends { id: string }>(messages: T[]): T[] {
  const byId = new Map<string, T>()
  for (const m of messages) {
    byId.set(m.id, m) // 后写的行代表更新状态
  }
  return [...byId.values()]
}

/**
 * 判定恢复出的消息是否"进行中"（流式被打断的残留快照）。
 * 磁盘上的进行中快照 isStreaming=true；历史恢复后已无流式 → 视作中断态。
 */
export function isStreamingSnapshot(m: { type: string; isStreaming?: boolean }): boolean {
  return m.type === 'assistant' && m.isStreaming === true
}

/**
 * 将一批"从磁盘恢复"的 assistant 消息归一为中断语义。
 *
 * 规则：
 * - 已完整（无 isStreaming / isStreaming 非 true）消息原样保留。
 * - isStreaming 快照（checkpoint 残留）→ 归一为完成态（isStreaming:false）+ interrupted:true，
 *   保留 blocks 全文，UI 可展示「回复中断（部分内容）」。
 *   （这些快照不会进引擎上下文：发送时 messages 只取最终完整消息，与既有恢复逻辑一致。）
 * - 为历史兼容补 timestamp（部分早期 checkpoint 行无 timestamp；按当前时间补，仅展示用）。
 */
export function normalizeRecoveredMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.type !== 'assistant') return m
    if (m.isStreaming !== true) return m
    const now = Date.now()
    const timestamp = m.timestamp || new Date(now).toISOString()
    return {
      ...m,
      timestamp,
      isStreaming: false,
      interrupted: true,
    }
  })
}