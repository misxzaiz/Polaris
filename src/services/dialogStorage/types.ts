/**
 * AI 对话存储类型定义（JSONL 文件存储）
 *
 * 存储模型：一个会话 = 一个 .jsonl 文件，参考 Claude Code 的存储思路。
 * 文件结构：
 *   第 1 行：DialogMeta（会话主表信息：externalId、引擎、标题、工作区等）
 *   第 2+ 行：DialogMessageLine（对话明细：每行一条完整 ChatMessage + 顺序号 seq）
 *
 * 设计要点：
 * - 整存整取：每次保存全量覆写文件 → 幂等、不重复、天然保序
 * - 无损存储：直接序列化完整 ChatMessage（含 blocks/attachments）→ 恢复时无信息损失
 * - seq 顺序号：解析时按 seq 排序，即使文件行被意外重排也能恢复正确顺序
 */

import type { ChatMessage, EngineId } from '@/types'

/** 当前 JSONL 格式版本（用于未来兼容性迁移） */
export const DIALOG_FORMAT_VERSION = 1

// ============================================================================
// JSONL 行类型
// ============================================================================

/** 会话主表行（每个文件的第一行） */
export interface DialogMeta {
  /** 格式版本 */
  v: number
  /** 行类型判别 */
  type: 'meta'
  /** 外部会话 ID（= 前端 conversationId，文件名也用它） */
  externalId: string
  /** Polaris 稳定可视对话 ID；SimpleAI checkpoint 以此为键，runtime 重建时保持不变。 */
  stableConversationId?: string
  /** SimpleAI/CLI 会话绑定的模型 Profile，用于 runtime 重建后保持原供应商。 */
  modelProfileId?: string
  /** 会话绑定模型，用于 runtime 重建后保持原模型。 */
  model?: string
  /** AI 引擎 */
  engineId: EngineId
  /** 会话标题 */
  title: string
  /** 工作区 ID */
  workspaceId: string | null
  /** 工作区路径（用于按项目过滤 / 恢复时定位工作区） */
  workspacePath: string | null
  /** 创建时间 ISO */
  createdAt: string
  /** 更新时间 ISO */
  updatedAt: string
  /** 消息数量 */
  messageCount: number
  // === 分析列 ===
  /** 首条用户消息文本（用于摘要/搜索） */
  firstUserText?: string
  /** 标签（工具调用名称去重，用于分析/检索） */
  tags?: string[]
}

/** 对话明细行（每条消息一行） */
export interface DialogMessageLine {
  /** 行类型判别 */
  type: 'msg'
  /** 顺序号（从 0 开始，保证消息顺序） */
  seq: number
  /** 完整消息对象（无损存储） */
  message: ChatMessage
}

/** JSONL 文件中的任意一行 */
export type DialogLine = DialogMeta | DialogMessageLine

// ============================================================================
// 业务对象
// ============================================================================

/** 完整对话记录（meta + 有序消息列表） */
export interface DialogRecord {
  meta: DialogMeta
  messages: ChatMessage[]
}

/** 会话列表摘要（从 meta 行提取，不含完整消息） */
export type DialogSummary = DialogMeta

/** 保存会话的输入参数 */
export interface SaveDialogInput {
  externalId: string
  stableConversationId?: string
  modelProfileId?: string
  model?: string
  engineId: EngineId
  title: string
  workspaceId?: string | null
  workspacePath?: string | null
  messages: ChatMessage[]
}

/** 分页选项 */
export interface ListOptions {
  page?: number
  pageSize?: number
  sortOrder?: 'asc' | 'desc'
}

/** 分页结果 */
export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasMore: boolean
}
