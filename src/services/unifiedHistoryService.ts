/**
 * 统一会话历史服务
 *
 * 整合 Claude Code Provider 的历史会话
 * 提供统一的接口访问所有历史会话
 */

import { getClaudeCodeHistoryService } from './claudeCodeHistoryService'
import type { Message } from '../types'

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Provider 类型
 */
export type ProviderType = 'claude-code'

/**
 * 统一的会话元数据
 */
export interface UnifiedSessionMeta {
  /** 会话 ID */
  sessionId: string
  /** Provider 类型 */
  provider: ProviderType
  /** 会话标题 */
  title: string
  /** 消息数量 */
  messageCount: number
  /** 文件大小（字节） */
  fileSize: number
  /** 创建时间 */
  createdAt?: string
  /** 更新时间 */
  updatedAt?: string
  /** 项目路径 */
  projectPath?: string
}

/**
 * Provider 统计信息
 */
export interface ProviderStats {
  provider: ProviderType
  sessionCount: number
  totalMessages: number
  totalSize: number
}

// ============================================================================
// 服务类
// ============================================================================

/**
 * 统一会话历史服务类
 */
export class UnifiedHistoryService {
  private claudeService = getClaudeCodeHistoryService()

  /**
   * 列出所有 Provider 的会话
   */
  async listAllSessions(options?: {
    /** 项目路径 */
    projectPath?: string
  }): Promise<UnifiedSessionMeta[]> {
    const sessions = await this.listClaudeCodeSessions(options?.projectPath)

    // 按更新时间排序
    sessions.sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0
      return timeB - timeA
    })

    return sessions
  }

  /**
   * 获取指定 Provider 的会话列表
   */
  async listSessionsByProvider(
    provider: ProviderType,
    options?: {
      projectPath?: string
    }
  ): Promise<UnifiedSessionMeta[]> {
    if (provider === 'claude-code') {
      return this.listClaudeCodeSessions(options?.projectPath)
    }
    return []
  }

  /**
   * 列出 Claude Code 会话
   */
  private async listClaudeCodeSessions(projectPath?: string): Promise<UnifiedSessionMeta[]> {
    const sessions = await this.claudeService.listSessions(projectPath)
    return sessions.map(s => ({
      sessionId: s.sessionId,
      provider: 'claude-code' as const,
      title: s.firstPrompt || 'Claude Code 对话',
      messageCount: s.messageCount,
      fileSize: s.fileSize,
      createdAt: s.created,
      updatedAt: s.modified,
      projectPath,
    }))
  }

  /**
   * 获取会话详细历史
   */
  async getSessionHistory(
    provider: ProviderType,
    sessionId: string,
    options?: {
      projectPath?: string
    }
  ): Promise<Message[]> {
    if (provider === 'claude-code') {
      const claudeMessages = await this.claudeService.getSessionHistory(sessionId, options?.projectPath)
      return this.claudeService.convertMessagesToFormat(claudeMessages)
    }
    return []
  }

  /**
   * 搜索会话（按标题或内容）
   */
  async searchSessions(query: string, options?: {
    projectPath?: string
  }): Promise<UnifiedSessionMeta[]> {
    const allSessions = await this.listAllSessions(options)

    const lowerQuery = query.toLowerCase()
    return allSessions.filter(session =>
      session.title.toLowerCase().includes(lowerQuery) ||
      session.sessionId.toLowerCase().includes(lowerQuery)
    )
  }

  /**
   * 按时间范围过滤会话
   */
  async filterSessionsByTimeRange(
    startDate: Date,
    endDate: Date,
    options?: {
      projectPath?: string
    }
  ): Promise<UnifiedSessionMeta[]> {
    const allSessions = await this.listAllSessions(options)

    return allSessions.filter(session => {
      if (!session.createdAt) return false
      const sessionDate = new Date(session.createdAt)
      return sessionDate >= startDate && sessionDate <= endDate
    })
  }

  /**
   * 获取 Provider 统计信息
   */
  async getStats(options?: {
    projectPath?: string
  }): Promise<ProviderStats[]> {
    const allSessions = await this.listAllSessions(options)

    const statsMap = new Map<ProviderType, ProviderStats>()

    for (const session of allSessions) {
      const existing = statsMap.get(session.provider)

      if (existing) {
        existing.sessionCount++
        existing.totalMessages += session.messageCount
        existing.totalSize += session.fileSize
      } else {
        statsMap.set(session.provider, {
          provider: session.provider,
          sessionCount: 1,
          totalMessages: session.messageCount,
          totalSize: session.fileSize,
        })
      }
    }

    return Array.from(statsMap.values())
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B'
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
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    })
  }

  /**
   * 获取 Provider 显示名称
   */
  getProviderName(_provider: ProviderType): string {
    return 'Claude Code'
  }

  /**
   * 获取 Provider 图标
   */
  getProviderIcon(_provider: ProviderType): string {
    return 'Claude'
  }
}

// ============================================================================
// 全局单例
// ============================================================================

let globalService: UnifiedHistoryService | null = null

/**
 * 获取统一历史服务单例
 */
export function getUnifiedHistoryService(): UnifiedHistoryService {
  if (!globalService) {
    globalService = new UnifiedHistoryService()
  }
  return globalService
}

/**
 * 重置服务（主要用于测试）
 */
export function resetUnifiedHistoryService(): void {
  globalService = null
}