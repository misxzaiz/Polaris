/**
 * InMemoryMessageLog — 层 1 验证用的最小实现
 *
 * 纯内存实现，不依赖后端/SQLite/文件系统。
 * 用于验证 append-only 模型的并发安全性和接口正确性。
 */

import type { MessageEntry, MessageLogStorage, MessageContent, ReadOptions } from './types'

export class InMemoryMessageLog implements MessageLogStorage {
  /** messageId → 按版本升序排列的条目列表 */
  private entries = new Map<string, MessageEntry[]>()
  /** conversationId → 所有消息（跨版本去重后的最新版本，按 timestamp 排序） */
  private byConversation = new Map<string, MessageEntry[]>()

  async append(entry: MessageEntry): Promise<boolean> {
    const existing = this.entries.get(entry.id)
    if (existing && existing.length > 0) {
      // 幂等：相同 id + 相同 version 已存在则跳过
      const dup = existing.some(e => e.version === entry.version)
      if (dup) return false
      // 新版本：追加到版本链
      existing.push(entry)
      existing.sort((a, b) => a.version - b.version)
    } else {
      this.entries.set(entry.id, [entry])
    }

    // 更新会话索引（只保留最新版本）
    const list = this.byConversation.get(entry.conversationId) ?? []
    const idx = list.findIndex(e => e.id === entry.id)
    if (idx >= 0) {
      list[idx] = entry
    } else {
      list.push(entry)
    }
    list.sort((a, b) => a.timestamp - b.timestamp)
    this.byConversation.set(entry.conversationId, list)

    return true
  }

  async revise(id: string, newContent: MessageContent): Promise<number> {
    const versions = this.entries.get(id)
    if (!versions || versions.length === 0) {
      throw new Error(`Message not found: ${id}`)
    }
    const latest = versions[versions.length - 1]
    const newVersion = latest.version + 1
    const revised: MessageEntry = {
      ...latest,
      content: newContent,
      version: newVersion,
      parentVersion: latest.version,
    }
    await this.append(revised)
    return newVersion
  }

  async read(conversationId: string, opts?: ReadOptions): Promise<MessageEntry[]> {
    const list = this.byConversation.get(conversationId) ?? []
    let filtered = list
    if (opts?.afterTimestamp != null) {
      filtered = filtered.filter(e => e.timestamp > opts.afterTimestamp!)
    }
    if (opts?.limit != null) {
      filtered = filtered.slice(0, opts.limit)
    }
    return [...filtered]
  }

  async readHistory(id: string): Promise<MessageEntry[]> {
    const versions = this.entries.get(id) ?? []
    return [...versions]
  }

  async getLatest(id: string): Promise<MessageEntry | null> {
    const versions = this.entries.get(id)
    if (!versions || versions.length === 0) return null
    return versions[versions.length - 1]
  }

  async deleteByConversation(conversationId: string): Promise<void> {
    const list = this.byConversation.get(conversationId) ?? []
    for (const entry of list) {
      this.entries.delete(entry.id)
    }
    this.byConversation.delete(conversationId)
  }

  /** 测试辅助：当前存储的消息数量（按唯一 messageId 计数） */
  get size(): number {
    return this.entries.size
  }

  /** 测试辅助：某会话的消息数量 */
  conversationSize(conversationId: string): number {
    return this.byConversation.get(conversationId)?.length ?? 0
  }
}
