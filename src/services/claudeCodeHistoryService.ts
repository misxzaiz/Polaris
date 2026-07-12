import { generateUUID } from '@/utils/uuid';
/**
 * Claude Code 原生历史服务
 *
 * 负责读取 Claude Code 原生存储的会话历史
 * 即 ~/.claude/projects/{项目名}/sessions-index.json
 */

import { invoke } from '@/services/tauri'
import type { Message, ChatMessage, ContentBlock, UserChatMessage, AssistantChatMessage, SystemChatMessage, ToolCallBlock } from '@/types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ClaudeCodeHistoryService')

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 统一分页结果
 */
export interface PagedResult<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

/**
 * 统一会话元数据（对应后端 SessionMeta）
 */
export interface SessionMetaResponse {
  sessionId: string
  engineId: string
  projectPath?: string
  createdAt?: string
  updatedAt?: string
  messageCount?: number
  summary?: string
  fileSize?: number
  claudeProjectName?: string
  filePath?: string

  // === Fork 关系字段 ===
  parentSessionId?: string
  childSessionIds?: string[]

  // === Git/PR 关联字段 ===
  gitBranch?: string
  linkedPr?: LinkedPR
}

/**
 * PR 关联信息
 */
export interface LinkedPR {
  number: number
  url?: string
  title?: string
  state?: 'open' | 'merged' | 'closed'
}

/**
 * Claude Code 会话元数据（旧接口）
 */
export interface ClaudeCodeSessionMeta {
  sessionId: string
  /** 真实工作区路径（用于前端匹配/创建工作区） */
  projectPath: string
  /** Claude Code 目录名（用于定位 jsonl 文件） */
  claudeProjectName: string
  firstPrompt?: string
  messageCount: number
  created?: string
  modified?: string
  filePath: string
  fileSize: number

  // === Fork 关系字段 ===
  /** 父会话 ID（fork 来源） */
  parentSessionId?: string
  /** 子会话 ID 列表 */
  childSessionIds?: string[]

  // === Git/PR 关联字段 ===
  /** Git 分支名称 */
  gitBranch?: string
  /** PR 关联信息 */
  linkedPr?: LinkedPR
}

/**
 * Claude Code 会话消息
 */
export interface ClaudeCodeMessage {
  role: string
  content: unknown // 可能是字符串或数组
  timestamp?: string
}

// ============================================================================
// 服务类
// ============================================================================

/**
 * Claude Code 历史服务类
 */
export class ClaudeCodeHistoryService {
  /**
   * 列出项目的所有 Claude Code 会话（旧接口，无分页）
   */
  async listSessions(projectPath?: string): Promise<ClaudeCodeSessionMeta[]> {
    try {
      const sessions = await invoke<ClaudeCodeSessionMeta[]>('list_claude_code_sessions', {
        projectPath,
      })
      return sessions
    } catch (e) {
      log.error('列出会话失败:', e instanceof Error ? e : new Error(String(e)))
      return []
    }
  }

  /**
   * 分页列出会话（统一接口，支持按项目过滤）
   */
  async listSessionsPaged(options: {
    page?: number
    pageSize?: number
    workDir?: string | null
  }): Promise<PagedResult<SessionMetaResponse>> {
    try {
      const result = await invoke<PagedResult<SessionMetaResponse>>('list_sessions', {
        engineId: 'claude-code',
        page: options.page ?? 1,
        pageSize: options.pageSize ?? 20,
        workDir: options.workDir ?? null,
      })
      return result
    } catch (e) {
      log.error('列出会话(分页)失败:', e instanceof Error ? e : new Error(String(e)))
      return { items: [], total: 0, page: 1, pageSize: 20, totalPages: 0 }
    }
  }

  /**
   * 获取会话历史消息
   */
  async getSessionHistory(sessionId: string, projectPath?: string): Promise<ClaudeCodeMessage[]> {
    try {
      const messages = await invoke<ClaudeCodeMessage[]>('get_claude_code_session_history', {
        sessionId,
        projectPath,
      })
      return messages
    } catch (e) {
      log.error('获取会话历史失败:', e instanceof Error ? e : new Error(String(e)))
      return []
    }
  }

  /**
   * 将 Claude Code 消息转换为通用 Message 格式
   */
  convertMessagesToFormat(messages: ClaudeCodeMessage[]): Message[] {
    return messages.map((msg, idx) => ({
      id: `${msg.role}-${idx}`,
      role: msg.role as 'user' | 'assistant',
      content: this.extractContentText(msg.content),
      timestamp: msg.timestamp || new Date().toISOString(),
    }))
  }

  /**
   * 从消息内容中提取纯文本
   */
  private extractContentText(content: unknown): string {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      const texts: string[] = []
      for (const item of content) {
        if (item && typeof item === 'object') {
          if ('type' in item && item.type === 'text' && 'text' in item) {
            texts.push(String(item.text))
          }
        }
      }
      return texts.join('')
    }

    return ''
  }

  /**
   * 从消息中提取工具调用
   */
  extractToolCalls(messages: ClaudeCodeMessage[]): Array<{
    id: string
    name: string
    status: 'pending' | 'completed' | 'failed'
    input: Record<string, unknown>
    startedAt: string
  }> {
    const toolCalls: Array<{
      id: string
      name: string
      status: 'pending' | 'completed' | 'failed'
      input: Record<string, unknown>
      startedAt: string
    }> = []

    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        // 简单实现：暂不解析工具调用
        continue
      }

      if (Array.isArray(msg.content)) {
        for (const item of msg.content) {
          if (item && typeof item === 'object') {
            if ('type' in item && item.type === 'tool_use') {
              toolCalls.push({
                id: String(item.id || generateUUID()),
                name: String(item.name || 'unknown'),
                status: 'completed' as const,
                input: item.input as Record<string, unknown> || {},
                startedAt: msg.timestamp || new Date().toISOString(),
              })
            }
          }
        }
      }
    }

    return toolCalls
  }

  /**
   * 将 Claude Code 消息转换为 ChatMessage 格式（包含 blocks）
   *
   * Claude Code 原生消息格式：
   * {
   *   "role": "assistant",
   *   "content": [
   *     { "type": "tool_use", "name": "TodoWrite", "input": {...} },
   *     { "type": "text", "text": "..." }
   *   ]
   * }
   *
   * 转换规则：
   * 1. 跳过 tool_result 类型的用户消息（工具执行结果）
   * 2. 合并连续的 assistant 消息（将多个 assistant 的 blocks 合并成一个）
   */
  convertToChatMessages(messages: ClaudeCodeMessage[]): ChatMessage[] {
    const chatMessages: ChatMessage[] = []

    // 预构建 tool_result 映射，用于回填 ToolCallBlock.output
    const toolResultMap = this.buildToolResultMap(messages)

    // 累积连续的 assistant 消息
    let accumulatedBlocks: ContentBlock[] = []
    let accumulatedTimestamp = ''
    let hasAssistant = false

    for (const msg of messages) {
      const timestamp = msg.timestamp || new Date().toISOString()

      if (msg.role === 'user') {
        // 检查是否为 tool_result 消息（需要跳过）
        if (this.isToolResultMessage(msg)) {
          // 跳过工具结果消息，继续累积 assistant
          continue
        }

        // 真正的用户消息 - 先输出累积的 assistant
        if (hasAssistant) {
          chatMessages.push({
            id: generateUUID(),
            type: 'assistant',
            blocks: accumulatedBlocks,
            timestamp: accumulatedTimestamp,
            isStreaming: false,
          } as AssistantChatMessage)
          accumulatedBlocks = []
          hasAssistant = false
        }

        // 提取用户消息内容
        const content = this.extractUserContent(msg.content)
        chatMessages.push({
          id: generateUUID(),
          type: 'user',
          content,
          timestamp,
        } as UserChatMessage)

      } else if (msg.role === 'assistant') {
        // 助手消息 - 累积 blocks
        const blocks = this.parseAssistantBlocks(msg.content, toolResultMap)
        accumulatedBlocks.push(...blocks)
        if (!hasAssistant) {
          accumulatedTimestamp = timestamp
          hasAssistant = true
        }

      } else {
        // 系统消息 - 先输出累积的 assistant，再输出系统消息
        if (hasAssistant) {
          chatMessages.push({
            id: generateUUID(),
            type: 'assistant',
            blocks: accumulatedBlocks,
            timestamp: accumulatedTimestamp,
            isStreaming: false,
          } as AssistantChatMessage)
          accumulatedBlocks = []
          hasAssistant = false
        }

        chatMessages.push({
          id: generateUUID(),
          type: 'system',
          content: String(msg.content || ''),
          timestamp,
        } as SystemChatMessage)
      }
    }

    // 处理最后剩余的 assistant 消息
    if (hasAssistant) {
      chatMessages.push({
        id: generateUUID(),
        type: 'assistant',
        blocks: accumulatedBlocks,
        timestamp: accumulatedTimestamp,
        isStreaming: false,
      } as AssistantChatMessage)
    }

    return chatMessages
  }

  /**
   * 构建 tool_result 映射: tool_use_id → content string
   *
   * 从 user 消息中提取 tool_result 内容，用于回填 ToolCallBlock.output
   */
  private buildToolResultMap(messages: ClaudeCodeMessage[]): Map<string, string> {
    const toolResultMap = new Map<string, string>()

    for (const msg of messages) {
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue

      for (const item of msg.content) {
        if (
          item && typeof item === 'object' &&
          'type' in item && item.type === 'tool_result'
        ) {
          const id = String((item as { tool_use_id?: unknown }).tool_use_id || '')
          if (id) {
            const raw = (item as { content?: unknown }).content
            const resultContent = typeof raw === 'string'
              ? raw
              : JSON.stringify(raw, null, 2)
            toolResultMap.set(id, resultContent)
          }
        }
      }
    }

    return toolResultMap
  }

  /**
   * 检查消息是否为纯 tool_result 类型（工具执行结果）
   *
   * 只有当消息仅包含 tool_result（没有文本内容）时才返回 true。
   * 如果消息同时包含文本和 tool_result，则返回 false，由 extractUserContent 提取文本。
   *
   * tool_result 消息格式：
   * {
   *   "role": "user",
   *   "content": [
   *     { "type": "tool_result", "tool_use_id": "...", "content": "..." }
   *   ]
   * }
   */
  private isToolResultMessage(msg: ClaudeCodeMessage): boolean {
    if (msg.role !== 'user') {
      return false
    }

    const content = msg.content

    // 字符串内容不是 tool_result
    if (typeof content === 'string') {
      return false
    }

    // 检查数组是否仅包含 tool_result（没有文本内容）
    if (Array.isArray(content)) {
      let hasToolResult = false
      let hasText = false

      for (const item of content) {
        if (item && typeof item === 'object' && 'type' in item) {
          if (item.type === 'tool_result') {
            hasToolResult = true
          } else if (item.type === 'text') {
            hasText = true
          }
        }
      }

      // 只有包含 tool_result 且没有文本内容时才跳过
      return hasToolResult && !hasText
    }

    return false
  }

  /**
   * 解析助手消息的 content 数组为 blocks
   *
   * 支持的内容类型：
   * - text: 普通文本
   * - thinking: 思考过程（ThinkingBlock）
   * - tool_use: 工具调用
   */
  private parseAssistantBlocks(
    content: unknown,
    toolResultMap?: Map<string, string>
  ): ContentBlock[] {
    const blocks: ContentBlock[] = []

    if (typeof content === 'string') {
      // 纯文本
      blocks.push({ type: 'text', content })
      return blocks
    }

    if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue

        if ('type' in item) {
          if (item.type === 'text' && 'text' in item) {
            // 文本块
            blocks.push({
              type: 'text',
              content: String(item.text),
            })
          } else if (item.type === 'thinking' && 'thinking' in item) {
            // 思考块 - 使用 ThinkingBlock 类型
            const thinkingContent = String(item.thinking)
            if (thinkingContent.trim()) {
              blocks.push({
                type: 'thinking',
                content: thinkingContent,
                collapsed: true,
              })
            }
          } else if (item.type === 'tool_use') {
            // 工具调用块
            const block: ToolCallBlock = {
              type: 'tool_call',
              id: String(item.id || generateUUID()),
              name: String(item.name || 'unknown'),
              input: (item.input as Record<string, unknown>) || {},
              status: 'completed',
              startedAt: new Date().toISOString(),
            }
            // 回填 tool_result output
            if (toolResultMap) {
              const resultContent = toolResultMap.get(block.id)
              if (resultContent !== undefined) {
                block.output = resultContent
              }
            }
            blocks.push(block)
          }
        }
      }
    }

    // 如果没有解析出任何 block，添加空文本块
    if (blocks.length === 0) {
      blocks.push({ type: 'text', content: '' })
    }

    return blocks
  }

  /**
   * 提取用户消息内容（处理 tool_result）
   */
  private extractUserContent(content: unknown): string {
    if (typeof content === 'string') {
      return content
    }

    if (Array.isArray(content)) {
      // 用户消息可能包含 tool_result，过滤掉
      const texts: string[] = []
      for (const item of content) {
        if (item && typeof item === 'object') {
          if ('type' in item) {
            if (item.type === 'text' && 'text' in item) {
              texts.push(String(item.text))
            }
            // 跳过 tool_result
          }
        }
      }
      return texts.join('')
    }

    return ''
  }

  /**
   * 格式化文件大小
   */
  formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    // 使用 Math.max(0, ...) 确保索引不为负数（当 bytes < 1 时 Math.log 返回负数）
    const i = Math.max(0, Math.floor(Math.log(bytes) / Math.log(k)))
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

let globalService: ClaudeCodeHistoryService | null = null

/**
 * 获取 Claude Code 历史服务单例
 */
export function getClaudeCodeHistoryService(): ClaudeCodeHistoryService {
  if (!globalService) {
    globalService = new ClaudeCodeHistoryService()
  }
  return globalService
}
