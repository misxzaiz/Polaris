/**
 * AI对话存储服务
 */

import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import { initDatabase } from './db'
import type {
  ConversationRecord,
  MessageRecord,
  CreateConversationData,
  CreateMessageData,
  ListOptions,
  PaginatedResult,
} from './types'

const log = createLogger('DialogStorageService')

const DEFAULT_PAGE_SIZE = 20

class DialogStorageServiceImpl {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  async init(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        this.db = await initDatabase()
        log.info('DialogStorage 服务初始化完成')
      } catch (error) {
        log.error('DialogStorage 服务初始化失败', error instanceof Error ? error : new Error(String(error)))
        this.initPromise = null
        throw error
      }
    })()

    return this.initPromise
  }

  // ============================================================================
  // 对话操作
  // ============================================================================

  async createConversation(data: CreateConversationData): Promise<string> {
    await this.init()
    
    const id = generateUUID()
    const now = new Date().toISOString()
    
    const record: ConversationRecord = {
      id,
      externalId: data.externalId || null,
      engineId: data.engineId,
      title: data.title || '新会话',
      workspaceId: data.workspaceId || null,
      status: 'idle',
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: null,
    }
    
    await this.put('conversations', record)
    log.info('创建对话', { id, engineId: data.engineId })
    return id
  }

  async updateConversation(id: string, data: Partial<ConversationRecord>): Promise<void> {
    await this.init()
    
    const existing = await this.getConversation(id)
    if (!existing) {
      log.warn('对话不存在', { id })
      return
    }
    
    const updated: ConversationRecord = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    }
    
    await this.put('conversations', updated)
  }

  async getConversation(id: string): Promise<ConversationRecord | null> {
    await this.init()
    return this.get('conversations', id)
  }

  async listConversations(options?: ListOptions): Promise<PaginatedResult<ConversationRecord>> {
    await this.init()
    
    const page = options?.page || 1
    const pageSize = options?.pageSize || DEFAULT_PAGE_SIZE
    const sortBy = options?.sortBy || 'updatedAt'
    const sortOrder = options?.sortOrder || 'desc'
    
    const all = await this.getAll('conversations')
    
    all.sort((a, b) => {
      const aVal = (a as Record<string, unknown>)[sortBy] as string
      const bVal = (b as Record<string, unknown>)[sortBy] as string
      const comparison = new Date(aVal).getTime() - new Date(bVal).getTime()
      return sortOrder === 'desc' ? -comparison : comparison
    })
    
    const total = all.length
    const totalPages = Math.ceil(total / pageSize)
    const start = (page - 1) * pageSize
    const items = all.slice(start, start + pageSize)
    
    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    }
  }

  async deleteConversation(id: string): Promise<void> {
    await this.init()
    
    await this.delete('conversations', id)
    
    const messages = await this.listMessages(id)
    for (const msg of messages.items) {
      await this.delete('messages', msg.id)
    }
    
    log.info('删除对话', { id })
  }

  // ============================================================================
  // 消息操作
  // ============================================================================

  async addMessage(data: CreateMessageData): Promise<string> {
    await this.init()
    
    const id = generateUUID()
    const now = new Date().toISOString()
    
    const record: MessageRecord = {
      id,
      conversationId: data.conversationId,
      type: data.type,
      role: data.role,
      content: data.content,
      blocks: data.blocks,
      attachments: data.attachments,
      engineId: data.engineId,
      createdAt: now,
    }
    
    await this.put('messages', record)
    
    await this.updateConversation(data.conversationId, {
      messageCount: (await this.getMessageCount(data.conversationId)) + 1,
      lastMessageAt: now,
    })
    
    return id
  }

  async getMessage(id: string): Promise<MessageRecord | null> {
    await this.init()
    return this.get('messages', id)
  }

  async listMessages(
    conversationId: string,
    options?: ListOptions
  ): Promise<PaginatedResult<MessageRecord>> {
    await this.init()
    
    const page = options?.page || 1
    const pageSize = options?.pageSize || DEFAULT_PAGE_SIZE
    const sortOrder = options?.sortOrder || 'asc'
    
    const all = await this.getAllByIndex<MessageRecord>('messages', 'by-conversation', conversationId)
    
    all.sort((a, b) => {
      const comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      return sortOrder === 'desc' ? -comparison : comparison
    })
    
    const total = all.length
    const totalPages = Math.ceil(total / pageSize)
    const start = (page - 1) * pageSize
    const items = all.slice(start, start + pageSize)
    
    return {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasMore: page < totalPages,
    }
  }

  async deleteMessage(id: string): Promise<void> {
    await this.init()
    await this.delete('messages', id)
  }

  // ============================================================================
  // 私有方法
  // ============================================================================

  private async put<T>(storeName: string, data: T): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.put(data)
      
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  private async get<T>(storeName: string, key: string): Promise<T | null> {
    if (!this.db) throw new Error('Database not initialized')
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.get(key)
      
      request.onsuccess = () => resolve(request.result || null)
      request.onerror = () => reject(request.error)
    })
  }

  private async getAll<T>(storeName: string): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized')
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const request = store.getAll()
      
      request.onsuccess = () => resolve((request.result || []) as T[])
      request.onerror = () => reject(request.error)
    })
  }

  private async getAllByIndex<T>(
    storeName: string,
    indexName: string,
    key: string
  ): Promise<T[]> {
    if (!this.db) throw new Error('Database not initialized')
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readonly')
      const store = transaction.objectStore(storeName)
      const index = store.index(indexName)
      const request = index.getAll(key)
      
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error)
    })
  }

  private async delete(storeName: string, key: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized')
    
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const request = store.delete(key)
      
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  private async getMessageCount(conversationId: string): Promise<number> {
    const result = await this.listMessages(conversationId)
    return result.total
  }
}

export const dialogStorageService = new DialogStorageServiceImpl()
