import { generateUUID } from '@/utils/uuid';
/**
 * Claude Code 原生历史服务
 *
 * 负责读取 Claude Code 原生存储的会话历史
 * 即 ~/.claude/projects/{项目名}/sessions-index.json
 */

import { invoke } from '@/services/tauri'
import type { Message, ChatMessage, ContentBlock, UserChatMessage, AssistantChatMessage, SystemChatMessage, ToolCallBlock, TaskBoardBlock, TaskBoardItem } from '@/types'
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
            blocks: this.aggregateTaskBlocks(accumulatedBlocks),
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
            blocks: this.aggregateTaskBlocks(accumulatedBlocks),
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
        blocks: this.aggregateTaskBlocks(accumulatedBlocks),
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
   * 将 blocks 中的 Task 家族工具块(TaskCreate/Update/List/Get/Output/Stop)
   * 聚合为单个 task_board block(最终态),使历史回放呈现任务板而非一堆工具块。
   *
   * 策略:扫描所有 Task 工具块,按 taskId 幂等合并为最终态;
   * 首个 Task 块的位置替换为聚合 board,其余 Task 块删除。非 Task 块原样保留。
   * 无 Task 块则原样返回。
   */
  private aggregateTaskBlocks(blocks: ContentBlock[]): ContentBlock[] {
    // TaskStop/TaskOutput 排除:实测其 task_id 是后台 shell id 空间(如 'b8wcfdfju'),
    // 与任务板数字 id 无关,聚合会错挂。仅聚合任务板四工具。
    const taskTools = new Set(['taskcreate', 'taskupdate', 'tasklist', 'taskget'])
    // 收集 Task 块索引 + 是否存在
    const taskIndices: number[] = []
    let hasTask = false
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]
      if (b.type === 'tool_call' && taskTools.has(b.name.toLowerCase())) {
        taskIndices.push(i)
        hasTask = true
      }
    }
    if (!hasTask) return blocks

    // 按 taskId 幂等合并(最终态:后出现的覆盖前面)
    const itemMap = new Map<string, TaskBoardItem>()
    let listSnapshot: TaskBoardItem[] | null = null
    let boardId = 'taskboard-history'
    for (const idx of taskIndices) {
      const block = blocks[idx] as ToolCallBlock
      const lower = block.name.toLowerCase()
      const input = block.input || {}
      if (lower === 'taskcreate') {
        // TaskCreate 的 taskId 由系统分配,在 tool_result output 回传,不在 input。
        // 取 output 中的 taskId 作 id,使 TaskUpdate 的 input.taskId 能匹配合并。
        boardId = block.id // 用首个 TaskCreate 的 callId 作 boardId
        const id = this.extractTaskIdFromOutput(block.output) || generateUUID()
        const item: TaskBoardItem = {
          id,
          subject: (input.subject as string) || (input.activeForm as string) || id,
          activeForm: input.activeForm as string | undefined,
          status: 'pending',
          description: input.description as string | undefined,
        }
        itemMap.set(id, item)
      } else if (lower === 'taskupdate') {
        const id = (input.taskId as string) || (input.task_id as string)
        // deleted 状态:实测 "Updated task #N deleted",对应项从板中剔除
        if (id && input.status === 'deleted') {
          itemMap.delete(id)
          continue
        }
        if (id) {
          const existing = itemMap.get(id)
          const patch: Partial<TaskBoardItem> = {}
          if (input.status) patch.status = input.status as TaskBoardItem['status']
          if (input.subject) patch.subject = input.subject as string
          if (input.activeForm) patch.activeForm = input.activeForm as string
          if (existing) {
            itemMap.set(id, { ...existing, ...patch, updateCount: (existing.updateCount ?? 0) + 1 })
          } else {
            // 未知 id(出现在 TaskCreate 之前):降级新建 pending
            itemMap.set(id, {
              id,
              subject: patch.subject || patch.activeForm || id,
              status: patch.status || 'pending',
              ...patch,
              updateCount: 0,
            })
          }
        }
      } else if (lower === 'tasklist') {
        // 解析 output 快照校准(不覆盖已有更精确状态)
        const snapshot = this.parseTaskListOutput(block.output)
        if (snapshot) listSnapshot = snapshot
      }
      // TaskGet/Output/Stop:仅标记,不影响 board 内容(Stop 可改 status)
      if (lower === 'taskstop') {
        const id = (input.taskId as string) || (input.task_id as string)
        if (id && itemMap.has(id)) {
          const it = itemMap.get(id)!
          itemMap.set(id, { ...it, status: 'stopped' })
        }
      }
    }

    // 用 TaskList 快照校准(补充 TaskCreate 未覆盖的项,不覆盖已有状态)
    if (listSnapshot) {
      for (const snap of listSnapshot) {
        if (!itemMap.has(snap.id)) {
          itemMap.set(snap.id, { ...snap, updateCount: 0 })
        }
      }
    }

    const items = [...itemMap.values()]
    const completed = items.filter(i => i.status === 'completed').length
    const inProgress = items.filter(i => i.status === 'in_progress').length
    const blocked = items.filter(i => i.status === 'blocked').length
    const board: TaskBoardBlock = {
      type: 'task_board',
      id: boardId,
      items,
      completed,
      inProgress,
      blocked,
      total: items.length,
      updatedAt: new Date().toISOString(),
    }

    // 重组:首个 Task 块位置放 board,其余 Task 块删除
    const result: ContentBlock[] = []
    let boardInserted = false
    const taskIdxSet = new Set(taskIndices)
    for (let i = 0; i < blocks.length; i++) {
      if (taskIdxSet.has(i)) {
        if (!boardInserted) {
          result.push(board)
          boardInserted = true
        }
        // 其余 Task 块跳过
      } else {
        result.push(blocks[i])
      }
    }
    // 若所有块都是 Task(board 未插入),补一个
    if (!boardInserted) result.push(board)
    return result
  }

  /** 解析 TaskList 的 tool_result output 为任务项快照 */
  /** 从 TaskCreate 的 tool_result 提取真实 taskId。
   *  实测形状为纯文本 "Task #1 created successfully: <subject>"(非 JSON),
   *  从 #(\d+) 提取数字;TaskUpdate 的 input.taskId 也是该数字字符串。 */
  private extractTaskIdFromOutput(output?: string): string | null {
    if (!output) return null
    const m = output.match(/#\s*(\d+)/)
    return m ? m[1] : null
  }

  private parseTaskListOutput(output?: string): TaskBoardItem[] | null {
    if (!output) return null
    // 实测为纯文本多行 "#1 [completed] 标题"(JSON.parse 14/14 全失败),按行正则提取
    const items: TaskBoardItem[] = []
    for (const line of output.split('
')) {
      const m = line.match(/^\s*#\s*(\d+)\s*\[([A-Za-z_]+)\]\s*(.*)$/)
      if (!m) continue
      const raw = m[2]
      let status: TaskBoardItem['status'] = 'pending'
      if (raw === 'completed' || raw === 'in_progress' || raw === 'blocked' || raw === 'stopped') {
        status = raw
      } else if (raw === 'deleted') {
        continue // 已删除项不入板
      }
      const subject = m[3].trim()
      if (!subject) continue
      items.push({ id: m[1], subject, status })
    }
    return items.length > 0 ? items : null
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
