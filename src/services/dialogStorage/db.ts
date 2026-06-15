/**
 * IndexedDB 数据库初始化
 */

import { createLogger } from '@/utils/logger'

const log = createLogger('DialogStorage')

const DB_NAME = 'polaris-dialog-storage'
const DB_VERSION = 1

export function initDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    
    request.onerror = () => {
      const error = request.error || new Error('IndexedDB open failed')
      log.error('IndexedDB 打开失败', error)
      reject(error)
    }
    
    request.onsuccess = () => {
      log.info('IndexedDB 打开成功')
      resolve(request.result)
    }
    
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      
      // 创建对话主表
      if (!db.objectStoreNames.contains('conversations')) {
        const conversationStore = db.createObjectStore('conversations', { keyPath: 'id' })
        conversationStore.createIndex('by-engine', 'engineId')
        conversationStore.createIndex('by-workspace', 'workspaceId')
        conversationStore.createIndex('by-created', 'createdAt')
        conversationStore.createIndex('by-updated', 'updatedAt')
        log.info('创建 conversations 表')
      }
      
      // 创建消息明细表
      if (!db.objectStoreNames.contains('messages')) {
        const messageStore = db.createObjectStore('messages', { keyPath: 'id' })
        messageStore.createIndex('by-conversation', 'conversationId')
        messageStore.createIndex('by-type', 'type')
        messageStore.createIndex('by-created', 'createdAt')
        messageStore.createIndex('by-conversation-created', ['conversationId', 'createdAt'])
        log.info('创建 messages 表')
      }
    }
  })
}
