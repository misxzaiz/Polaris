/**
 * claudeHistoryConvert.ts —— Claude Code 原生消息 → ChatMessage 转换核
 *
 * P4（plans/session-history-plugin-prd.md）从 claudeCodeHistoryService.ts 抽出：
 * 该服务的「查询编排」已被 cap.history 取代（history-desk 插件 + sessionRestore），
 * 仅剩这份纯转换逻辑仍被宿主恢复链路（sessionRestore）消费。转换是纯函数，
 * 落在恢复核心旁；claudeCodeHistoryService.ts 整文件随之拆除。
 *
 * 转换规则（自 claudeCodeHistoryService.convertToChatMessages 原样迁移）：
 * 1. 跳过纯 tool_result 的 user 消息（工具执行结果）；
 * 2. 合并连续 assistant 消息（blocks 累积为一个）；
 * 3. tool_result 经 tool_use_id 回填 ToolCallBlock.output；
 * 4. Task 家族工具块聚合为单个 task_board block（最终态）。
 */

import { generateUUID } from '@/utils/uuid'
import type { ChatMessage, ContentBlock, UserChatMessage, AssistantChatMessage, SystemChatMessage, ToolCallBlock, TaskBoardBlock, TaskBoardItem } from '@/types'

/** Claude Code 原生消息（cap.history get_claude_history 返回项） */
export interface ClaudeCodeMessage {
  role: string
  content: unknown // 字符串或 block 数组
  timestamp?: string
}

/** PR 关联信息（历史条目展示用；原 claudeCodeHistoryService.LinkedPR） */
export interface LinkedPR {
  number: number
  url?: string
  title?: string
  state?: 'open' | 'merged' | 'closed'
}

/** Task 家族工具名（聚合白名单） */
const TASK_TOOLS = new Set(['taskcreate', 'taskupdate', 'tasklist', 'taskget'])

/** 把 Claude Code 原生消息数组转换为 ChatMessage[]（含 blocks） */
export function convertClaudeHistoryToChatMessages(messages: ClaudeCodeMessage[]): ChatMessage[] {
  const chatMessages: ChatMessage[] = []

  // 预构建 tool_result 映射（tool_use_id → output 文本），用于回填
  const toolResultMap = buildToolResultMap(messages)

  // 累积连续的 assistant 消息
  let accumulatedBlocks: ContentBlock[] = []
  let accumulatedTimestamp = ''
  let hasAssistant = false

  for (const msg of messages) {
    const timestamp = msg.timestamp || new Date().toISOString()

    if (msg.role === 'user') {
      // 纯 tool_result 消息跳过（工具执行结果，非用户输入）
      if (isToolResultMessage(msg)) continue

      // 真正的用户消息 - 先输出累积的 assistant
      if (hasAssistant) {
        chatMessages.push({
          id: generateUUID(),
          type: 'assistant',
          blocks: aggregateTaskBlocks(accumulatedBlocks),
          timestamp: accumulatedTimestamp,
          isStreaming: false,
        } as AssistantChatMessage)
        accumulatedBlocks = []
        hasAssistant = false
      }

      chatMessages.push({
        id: generateUUID(),
        type: 'user',
        content: extractUserContent(msg.content),
        timestamp,
      } as UserChatMessage)
    } else if (msg.role === 'assistant') {
      // 助手消息 - 累积 blocks
      accumulatedBlocks.push(...parseAssistantBlocks(msg.content, toolResultMap))
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
          blocks: aggregateTaskBlocks(accumulatedBlocks),
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
      blocks: aggregateTaskBlocks(accumulatedBlocks),
      timestamp: accumulatedTimestamp,
      isStreaming: false,
    } as AssistantChatMessage)
  }

  return chatMessages
}

/** 构建 tool_result 映射: tool_use_id → content string */
function buildToolResultMap(messages: ClaudeCodeMessage[]): Map<string, string> {
  const toolResultMap = new Map<string, string>()
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
    for (const item of msg.content) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'tool_result') {
        const id = String((item as { tool_use_id?: unknown }).tool_use_id || '')
        if (id) {
          const raw = (item as { content?: unknown }).content
          const resultContent = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)
          toolResultMap.set(id, resultContent)
        }
      }
    }
  }
  return toolResultMap
}

/** 检查消息是否为纯 tool_result 类型（仅含 tool_result、无文本） */
function isToolResultMessage(msg: ClaudeCodeMessage): boolean {
  if (msg.role !== 'user') return false
  const content = msg.content
  if (typeof content === 'string') return false
  if (Array.isArray(content)) {
    let hasToolResult = false
    let hasText = false
    for (const item of content) {
      if (item && typeof item === 'object' && 'type' in item) {
        if (item.type === 'tool_result') hasToolResult = true
        else if (item.type === 'text') hasText = true
      }
    }
    return hasToolResult && !hasText
  }
  return false
}

/** 解析 assistant 消息 content 为 blocks（text/thinking/tool_use） */
function parseAssistantBlocks(content: unknown, toolResultMap?: Map<string, string>): ContentBlock[] {
  const blocks: ContentBlock[] = []

  if (typeof content === 'string') {
    blocks.push({ type: 'text', content })
    return blocks
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      if (!item || typeof item !== 'object') continue
      if ('type' in item) {
        if (item.type === 'text' && 'text' in item) {
          blocks.push({ type: 'text', content: String(item.text) })
        } else if (item.type === 'thinking' && 'thinking' in item) {
          const thinkingContent = String(item.thinking)
          if (thinkingContent.trim()) {
            blocks.push({ type: 'thinking', content: thinkingContent, collapsed: true })
          }
        } else if (item.type === 'tool_use') {
          const block: ToolCallBlock = {
            type: 'tool_call',
            id: String(item.id || generateUUID()),
            name: String(item.name || 'unknown'),
            input: (item.input as Record<string, unknown>) || {},
            status: 'completed',
            startedAt: new Date().toISOString(),
          }
          if (toolResultMap) {
            const resultContent = toolResultMap.get(block.id)
            if (resultContent !== undefined) block.output = resultContent
          }
          blocks.push(block)
        }
      }
    }
  }

  if (blocks.length === 0) blocks.push({ type: 'text', content: '' })
  return blocks
}

/** 提取用户消息文本（过滤 tool_result） */
function extractUserContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const item of content) {
      if (item && typeof item === 'object' && 'type' in item && item.type === 'text' && 'text' in item) {
        texts.push(String(item.text))
      }
    }
    return texts.join('')
  }
  return ''
}

/**
 * 将 blocks 中的 Task 家族工具块（TaskCreate/Update/List/Get/Output/Stop）
 * 聚合为单个 task_board block（最终态），使历史回放呈现任务板而非一堆工具块。
 */
function aggregateTaskBlocks(blocks: ContentBlock[]): ContentBlock[] {
  // TaskStop/TaskOutput 排除：其 task_id 是后台 shell id 空间，与任务板数字 id 无关
  const taskIndices: number[] = []
  let hasTask = false
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'tool_call' && TASK_TOOLS.has(b.name.toLowerCase())) {
      taskIndices.push(i)
      hasTask = true
    }
  }
  if (!hasTask) return blocks

  // 按 taskId 幂等合并（最终态：后出现的覆盖前面）
  const itemMap = new Map<string, TaskBoardItem>()
  let listSnapshot: TaskBoardItem[] | null = null
  let boardId = 'taskboard-history'
  for (const idx of taskIndices) {
    const block = blocks[idx] as ToolCallBlock
    const lower = block.name.toLowerCase()
    const input = block.input || {}
    if (lower === 'taskcreate') {
      // TaskCreate 的 taskId 由系统分配，在 tool_result output 回传
      boardId = block.id
      const id = extractTaskIdFromOutput(block.output) || generateUUID()
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
      const snapshot = parseTaskListOutput(block.output)
      if (snapshot) listSnapshot = snapshot
    }
    if (lower === 'taskstop') {
      const id = (input.taskId as string) || (input.task_id as string)
      if (id && itemMap.has(id)) {
        const it = itemMap.get(id)!
        itemMap.set(id, { ...it, status: 'stopped' })
      }
    }
  }

  // TaskList 快照校准（补缺不覆盖）
  if (listSnapshot) {
    for (const snap of listSnapshot) {
      if (!itemMap.has(snap.id)) itemMap.set(snap.id, { ...snap, updateCount: 0 })
    }
  }

  const items = [...itemMap.values()]
  const completed = items.filter((i) => i.status === 'completed').length
  const inProgress = items.filter((i) => i.status === 'in_progress').length
  const blocked = items.filter((i) => i.status === 'blocked').length
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

  // 重组：首个 Task 块位置放 board，其余 Task 块删除
  const result: ContentBlock[] = []
  let boardInserted = false
  const taskIdxSet = new Set(taskIndices)
  for (let i = 0; i < blocks.length; i++) {
    if (taskIdxSet.has(i)) {
      if (!boardInserted) {
        result.push(board)
        boardInserted = true
      }
    } else {
      result.push(blocks[i])
    }
  }
  if (!boardInserted) result.push(board)
  return result
}

/** 从 TaskCreate 的 tool_result 提取真实 taskId（"Task #1 created ..." → "1"） */
function extractTaskIdFromOutput(output?: string): string | null {
  if (!output) return null
  const m = output.match(/#\s*(\d+)/)
  return m ? m[1] : null
}

/** 解析 TaskList 的 tool_result output 为任务项快照（纯文本多行 "#1 [completed] 标题"） */
function parseTaskListOutput(output?: string): TaskBoardItem[] | null {
  if (!output) return null
  const items: TaskBoardItem[] = []
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*#\s*(\d+)\s*\[([A-Za-z_]+)\]\s*(.*)$/)
    if (!m) continue
    const raw = m[2]
    let status: TaskBoardItem['status'] = 'pending'
    if (raw === 'completed' || raw === 'in_progress' || raw === 'blocked' || raw === 'stopped') {
      status = raw
    } else if (raw === 'deleted') {
      continue
    }
    const subject = m[3].trim()
    if (!subject) continue
    items.push({ id: m[1], subject, status })
  }
  return items.length > 0 ? items : null
}
