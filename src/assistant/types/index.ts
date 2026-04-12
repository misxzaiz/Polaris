/**
 * AI 助手模块类型定义
 */

// ============================================
// 消息类型
// ============================================

/** 助手消息 */
export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number

  // 工具调用信息
  toolCalls?: ToolCallInfo[]
  toolResults?: ToolResultInfo[]
}

/** 工具调用信息 */
export interface ToolCallInfo {
  id: string
  name: string
  arguments: InvokeClaudeCodeParams
  status: 'pending' | 'running' | 'completed' | 'error'
  /** 关联的 Claude Code 会话 ID */
  claudeCodeSessionId?: string
}

/** 工具执行结果 */
export interface ToolResultInfo {
  toolCallId: string
  result: string
  success: boolean
  /** 来源会话 ID */
  sessionId?: string
}

// ============================================
// Claude Code 调用参数
// ============================================

/** Claude Code 调用参数（支持多会话） */
export interface InvokeClaudeCodeParams {
  prompt: string
  /** 目标会话 ID */
  sessionId?: string
  /** 执行模式 */
  mode: 'continue' | 'new' | 'interrupt'
  reason?: string
  /** 是否后台执行 */
  background?: boolean
}

// ============================================
// Claude Code 会话状态
// ============================================

/** Claude Code 会话类型 */
export type ClaudeCodeSessionType = 'primary' | 'analysis' | 'background'

/** Claude Code 会话状态 */
export interface ClaudeCodeSessionState {
  /** 会话 ID */
  id: string
  /** 会话类型 */
  type: ClaudeCodeSessionType
  /** 会话状态 */
  status: 'idle' | 'running' | 'completed' | 'error'
  /** 显示名称 */
  label: string
  /** 创建时间 */
  createdAt: number
  /** 最后活动时间 */
  lastActiveAt: number
  /** 执行事件列表 */
  events: ClaudeCodeExecutionEvent[]
  /** 关联的工具调用 ID */
  toolCallId?: string
}

/** Claude Code 执行事件 */
export interface ClaudeCodeExecutionEvent {
  type: 'tool_call' | 'token' | 'progress' | 'error' | 'complete' | 'session_end' | 'session_start' | 'assistant_message'
  timestamp: number
  /** 所属会话 ID */
  sessionId: string
  data: {
    tool?: string
    content?: string
    message?: string
    error?: string
    isDelta?: boolean
  }
}

// ============================================
// 完成通知
// ============================================

/** 后台任务完成通知 */
export interface CompletionNotification {
  /** 通知 ID */
  id: string
  /** 关联的会话 ID */
  sessionId: string
  /** 关联的工具调用 ID */
  toolCallId: string
  /** 执行的提示词 */
  prompt: string
  /** 执行结果摘要 */
  resultSummary: string
  /** 完整结果 */
  fullResult?: string
  /** 创建时间 */
  createdAt: number
  /** 是否已处理 */
  handled: boolean
  /** 处理方式 */
  handleType?: 'immediate' | 'delayed' | 'ignored'
}

// ============================================
// 助手事件
// ============================================

/** 助手事件 */
export type AssistantEvent =
  | { type: 'message_start' }
  | { type: 'content_delta'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo }
  | { type: 'tool_result'; result: ToolResultInfo }
  | { type: 'message_complete' }
  | { type: 'claude_code_event'; sessionId: string; event: ClaudeCodeExecutionEvent }
  | { type: 'session_created'; session: ClaudeCodeSessionState }
  | { type: 'session_completed'; sessionId: string; success: boolean }
  | { type: 'background_task_completed'; notification: CompletionNotification }

// ============================================
// 配置类型
// ============================================

/** 助手配置 */
export interface AssistantConfig {
  /** 是否启用助手模块 */
  enabled: boolean

  /** LLM 配置 */
  llm: {
    /** API Base URL */
    baseUrl: string
    /** API Key */
    apiKey: string
    /** 模型 ID */
    model: string
    /** 最大 Token */
    maxTokens?: number
    /** 温度 */
    temperature?: number
  }

  /** Claude Code 调用配置 */
  claudeCode: {
    /** 默认执行模式 */
    defaultMode: 'continue' | 'new'
    /** 超时时间（毫秒） */
    timeout?: number
  }
}

/** 默认助手配置 */
export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.7,
  },
  claudeCode: {
    defaultMode: 'continue',
    timeout: 300000,
  },
}
