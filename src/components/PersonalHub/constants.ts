/**
 * Personal Hub 共享常量与工具函数
 */
import type { LinkType, Priority } from '@/services/personalHub/types'
import { PRIORITY_OPTIONS as PRIORITY_OPTS } from '@/hooks/personalHub/useLinkFilter'

export const TYPE_LABELS: Record<LinkType, string> = {
  navigation: '导航',
  bookmark: '书签',
  todo: '待办',
  note: '笔记',
}

/** 表单可选类型（不含 note，note 由独立笔记体系处理） */
export const TYPE_OPTIONS_FOR_FORM: { value: LinkType; label: string }[] = [
  { value: 'navigation', label: '导航' },
  { value: 'bookmark', label: '书签' },
  { value: 'todo', label: '待办' },
]

/** ActivityBar tab 筛选项（含 all） */
export const TYPE_FILTER_TABS: { value: LinkType | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'navigation', label: '导航' },
  { value: 'bookmark', label: '书签' },
  { value: 'todo', label: '待办' },
]

export const PRIORITY_OPTIONS = PRIORITY_OPTS

export const PRIORITY_LABEL: Record<Priority, string> = {
  high: '高',
  medium: '中',
  low: '低',
}

export const PRIORITY_COLOR: Record<Priority, string> = {
  high: '#ef4444',
  medium: '#f59e0b',
  low: '#10b981',
}

/**
 * 相对日期格式化：今天/明天/昨天/N天前/N天后/逾期，否则本地日期。
 */
export function formatRelativeDate(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(d)
  target.setHours(0, 0, 0, 0)
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86400000)
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '明天'
  if (diffDays === -1) return '昨天'
  if (diffDays < 0) return `逾期 ${Math.abs(diffDays)} 天`
  if (diffDays <= 7) return `${diffDays} 天后`
  return d.toLocaleDateString('zh-CN')
}

/** 完整日期时间 */
export function formatDateTime(iso?: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN')
}

/** 判断是否已过截止日期（未完成） */
export function isOverdue(iso?: string, completed?: boolean): boolean {
  if (!iso || completed) return false
  return new Date(iso).getTime() < Date.now()
}
