/**
 * AI对话存储类型定义
 */

import type { EngineId } from '@/types'
import type { ContentBlock } from '@/types/chat'

// ============================================================================
// 对话主表类型
// ============================================================================

export interface ConversationRecord {
  id: string
  externalId: string | null
  engineId: EngineId
  title: string
  workspaceId: string | null
  status: 'idle' | 'running' | 'error'
  messageCount: number
  createdAt: string
  updatedAt: string
  lastMessageAt: string | null
}

// ============================================================================
// 对话明细表类型
// ============================================================================

export interface MessageRecord {
  id: string
  conversationId: string
  type: 'user' | 'assistant' | 'system'
  role: 'user' | 'assistant' | 'system'
  content: string
  blocks?: ContentBlock[]
  attachments?: Array<{
    id: string
    type: 'image' | 'file'
    fileName: string
    fileSize: number
    mimeType: string
  }>
  engineId?: EngineId
  createdAt: string
}

// ============================================================================
// 操作类型
// ============================================================================

export interface CreateConversationData {
  externalId?: string
  engineId: EngineId
  title?: string
  workspaceId?: string
}

export interface CreateMessageData {
  conversationId: string
  type: 'user' | 'assistant' | 'system'
  role: 'user' | 'assistant' | 'system'
  content: string
  blocks?: ContentBlock[]
  attachments?: Array<{
    id: string
    type: 'image' | 'file'
    fileName: string
    fileSize: number
    mimeType: string
  }>
  engineId?: EngineId
}

export interface ListOptions {
  page?: number
  pageSize?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export interface PaginatedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  hasMore: boolean
}
