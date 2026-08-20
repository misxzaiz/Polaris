/**
 * 需求面板共享样式常量
 *
 * Card 和 Dialog 复用的状态/优先级颜色映射
 */

import type { RequirementStatus, RequirementPriority } from '@/types/requirement'

/** 状态颜色配置（含 dot 用于卡片状态点） */
export const STATUS_STYLES: Record<RequirementStatus, { text: string; bg: string; dot: string }> = {
  draft: { text: 'text-status-neutral', bg: 'bg-status-neutral/10', dot: 'bg-status-neutral' },
  pending: { text: 'text-status-warning', bg: 'bg-status-warning/10', dot: 'bg-status-warning' },
  approved: { text: 'text-status-success', bg: 'bg-status-success/10', dot: 'bg-status-success' },
  rejected: { text: 'text-status-danger', bg: 'bg-status-danger/10', dot: 'bg-status-danger' },
  executing: { text: 'text-status-info', bg: 'bg-status-info/10', dot: 'bg-status-info' },
  completed: { text: 'text-status-done', bg: 'bg-status-done/10', dot: 'bg-status-done' },
  failed: { text: 'text-status-failed', bg: 'bg-status-failed/10', dot: 'bg-status-failed' },
}

/** 优先级文字颜色 */
export const PRIORITY_TEXT: Record<RequirementPriority, string> = {
  low: 'text-priority-low',
  normal: 'text-priority-normal',
  high: 'text-priority-high',
  urgent: 'text-priority-urgent',
}

/** 优先级背景颜色 */
export const PRIORITY_BG: Record<RequirementPriority, string> = {
  low: 'bg-priority-low/10',
  normal: 'bg-priority-normal/10',
  high: 'bg-priority-high/10',
  urgent: 'bg-priority-urgent/10',
}

/** 优先级排序权重（高权重优先） */
export const PRIORITY_WEIGHT: Record<RequirementPriority, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
}

/** 时间格式预设 */
export const TIME_FORMAT_SHORT: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

export const TIME_FORMAT_FULL: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}

/** 格式化时间戳为本地化字符串 */
export function formatTime(ts: number, locale: string, options?: Intl.DateTimeFormatOptions): string {
  return new Date(ts).toLocaleString(locale, options ?? TIME_FORMAT_SHORT)
}
