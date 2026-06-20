/** Personal Hub 数据类型（移植自 personal-hub src/types/index.ts） */

export interface User {
  id: string
  email: string
}

/** links 表 type 联合类型 */
export type LinkType = 'navigation' | 'bookmark' | 'todo' | 'note'

export interface Link {
  id: string
  user_id: string
  title: string
  url?: string
  description?: string
  type: LinkType
  tags?: string[]
  completed?: boolean
  priority?: 'low' | 'medium' | 'high'
  due_date?: string
  order_index?: number
  is_encrypted?: boolean
  icon?: string
  created_at: string
  updated_at: string
  // 笔记功能字段（来自 008_notes_feature.sql）
  view_count?: number
  keywords?: string[]
}

export type Priority = 'low' | 'medium' | 'high'

export type StatusFilter = 'all' | 'pending' | 'completed'

export type DueDateFilter = 'all' | 'today' | 'week' | 'month' | 'overdue'

export type SortField = 'created_at' | 'updated_at' | 'title' | 'priority' | 'due_date'

export type SortOrder = 'asc' | 'desc'

/** 创建/更新用的载荷（部分字段） */
export type LinkInput = Partial<Omit<Link, 'id' | 'user_id' | 'created_at' | 'updated_at'>>
