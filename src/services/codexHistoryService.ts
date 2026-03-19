/**
 * Codex 历史服务
 *
 * 负责与后端交互，获取 Codex 会话历史
 */

import { invoke } from '@tauri-apps/api/core'
import type { Message, ToolCall } from '../types'
import { createLogger } from '../utils/logger'

const log = createLogger('CodexHistoryService')

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Codex 会话元数据
 */
export interface CodexSessionMeta {
  sessionId: string
  title: string
  messageCount: number
  fileSize: number
  createdAt: string
  updatedAt: string
  filePath: string
}

/**
 * Codex 历史消息
 */
export interface CodexHistoryMessage {
  uuid: string
  parentUuid?: string
  timestamp: string
  type: 'user' | 'assistant'
  content: string
  model?: string
  stopReason?: string
  toolCalls: CodexToolCall[]
}

/**
 * Codex 工具调用
 */
export interface CodexToolCall {
  id: string
  name: string
  input: unknown
}

// ============================================================================
// 服务类
// ============================================================================

/**
 * Codex 历史服务类
 */
export class CodexHistoryService {
  /**
   * 列出项目的所有 Codex 会话
   */
  async listSessions(workDir?: string): Promise<CodexSessionMeta[]> {
    try {
      const sessions = await invoke<CodexSessionMeta[]>('list_codex_sessions', {
        workDir,
      })
      return sessions ?? []
    } catch (e) {
      console.error('[CodexHistoryService] 列出会话失败:', e)
      return []
    }
  }

  /**
   * 获取会话历史消息
   */
  async getSessionHistory(filePath: string): Promise<CodexHistoryMessage[]> {
    try {
      const messages = await invoke<CodexHistoryMessage[]>('get_codex_session_history', {
        filePath,
      })
      return messages ?? []
    } catch (e) {
      log.error('获取会话历史失败:', e instanceof Error ? e : new Error(String(e)))
      return []
    }
  }

  /**
   * 将 Codex 消息转换为通用 Message 格式
   */
  convertMessagesToFormat(messages: CodexHistoryMessage[]): Message[] {
    return messages.map(msg => ({
      id: msg.uuid,
      role: msg.type,
      content: msg.content,
      timestamp: msg.timestamp,
      // 如果有工具调用，添加摘要
      toolSummary: msg.toolCalls.length > 0 ? {
        count: msg.toolCalls.length,
        names: Array.from(new Set(msg.toolCalls.map(t => t.name))),
      } : undefined,
    }))
  }

  /**
   * 从 Codex 消息中提取工具调用
   */
  extractToolCalls(messages: CodexHistoryMessage[]): ToolCall[] {
    const toolCalls: ToolCall[] = []

    for (const msg of messages) {
      for (const tc of msg.toolCalls) {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          status: 'completed' as const,
          input: tc.input as Record<string, unknown>,
          startedAt: msg.timestamp,
        })
      }
    }

    return toolCalls
  }

  /**
   * 生成会话标题（如果消息中没有标题）
   */
  generateSessionTitle(messages: CodexHistoryMessage[]): string {
    const firstUserMessage = messages.find(m => m.type === 'user')
    if (firstUserMessage) {
      const content = firstUserMessage.content.trim()
      if (content.length > 50) {
        return content.slice(0, 50) + '...'
      }
      return content || 'Codex 对话'
    }
    return 'Codex 对话'
  }

  /**
   * 获取会话摘要
   */
  getSessionSummary(meta: CodexSessionMeta): string {
    const parts: string[] = []

    parts.push(`${meta.messageCount} 条消息`)

    return parts.join(' · ')
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B'
    if (bytes < 1) return `${bytes} B` // 处理小于 1 字节的情况
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  /**
   * 格式化时间
   */
  formatTime(timestamp: string): string {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return '刚刚'
    if (diffMins < 60) return `${diffMins} 分钟前`
    if (diffHours < 24) return `${diffHours} 小时前`
    if (diffDays < 7) return `${diffDays} 天前`

    return date.toLocaleDateString('zh-CN', {
      month: 'short',
      day: 'numeric',
    })
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let globalService: CodexHistoryService | null = null

/**
 * 获取 Codex 历史服务单例
 */
export function getCodexHistoryService(): CodexHistoryService {
  if (!globalService) {
    globalService = new CodexHistoryService()
  }
  return globalService
}

/**
 * 重置服务（主要用于测试）
 */
export function resetCodexHistoryService(): void {
  globalService = null
}
