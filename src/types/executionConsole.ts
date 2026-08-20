/**
 * AI 执行控制台类型定义
 *
 * 控制台是纯只读观测层：
 * - chat / scheduler 的实时状态直接从源 store（sessionStoreManager / schedulerStore）派生
 * - 集成（QQ/飞书）执行状态由 executionConsoleStore 聚合后端事件得到
 */

import type { Platform } from './integration'

/** 执行来源 */
export type ExecutionOrigin = 'chat' | 'scheduler' | 'integration'

/** 集成 AI 执行状态 */
export type IntegrationRunStatus = 'running' | 'success' | 'failed'

/**
 * 集成 AI 执行（一次外部消息触发的 AI 处理）
 *
 * 由 integration:message → integration:ai:delta → integration:ai:complete/error
 * 事件序列驱动。conversationId 为唯一键（同会话串行处理）。
 */
export interface IntegrationRun {
  /** 平台会话 ID（QQ 群/飞书会话） */
  conversationId: string
  /** 来源平台 */
  platform: Platform
  /** 发送者名称 */
  senderName: string
  /** 触发消息文本（截断预览） */
  promptPreview: string
  /** 最近一次 AI 输出预览（截断） */
  lastOutputPreview: string
  /** 执行状态 */
  status: IntegrationRunStatus
  /** 开始时间戳（ms） */
  startedAt: number
  /** 最近活动时间戳（ms） */
  lastActivityAt: number
  /** 结束时间戳（ms，完成/失败后有值） */
  endedAt?: number
  /** 后端 AI sessionId（complete 事件携带） */
  sessionId?: string
  /** 错误信息（失败时） */
  error?: string
}

/** 执行历史条目（统一时间线） */
export interface ExecutionHistoryEntry {
  /** 唯一 ID */
  id: string
  /** 执行来源 */
  origin: ExecutionOrigin
  /** 来源平台（仅 integration） */
  platform?: Platform
  /** 标题（任务名/会话标题/发送者） */
  title: string
  /** 内容摘要（prompt 或输出预览） */
  summary: string
  /** 最终状态 */
  status: 'success' | 'failed'
  /** 开始时间戳（ms） */
  startedAt: number
  /** 结束时间戳（ms） */
  endedAt: number
  /** 错误信息（失败时） */
  error?: string
}

/** 文本预览最大长度 */
export const PREVIEW_MAX_LENGTH = 120

/** 历史条目上限 */
export const HISTORY_MAX_ENTRIES = 100

/** 截断文本为预览 */
export function toPreview(text: string, maxLength: number = PREVIEW_MAX_LENGTH): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength)}…`
}
