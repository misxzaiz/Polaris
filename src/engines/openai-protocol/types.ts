/**
 * OpenAI API 类型定义
 * 支持 OpenAI 兼容的 API 服务
 */

/** OpenAI 消息角色 */
export type OpenAIMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** OpenAI 消息 */
export interface OpenAIMessage {
  role: OpenAIMessageRole
  content: string | null
  /** 工具调用（assistant 消息） */
  tool_calls?: OpenAIToolCall[]
  /** 工具调用 ID（tool 消息） */
  tool_call_id?: string
  /** 名称（tool 消息） */
  name?: string
}

/** OpenAI 工具定义 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** OpenAI 工具调用 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** OpenAI Chat Completion 请求 */
export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

/** OpenAI Chat Completion 响应 */
export interface OpenAIChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: OpenAIMessage
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/** OpenAI 流式响应 Delta */
export interface OpenAIStreamDelta {
  role?: OpenAIMessageRole
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

/** OpenAI 流式响应块 */
export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: OpenAIStreamDelta
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
  }>
}

/** OpenAI API 错误响应 */
export interface OpenAIError {
  error: {
    message: string
    type: string
    code?: string
    param?: string
  }
}

/** OpenAI 引擎配置 */
export interface OpenAIEngineConfig {
  /** API Base URL */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 模型 ID */
  model: string
  /** 最大 Token 数 */
  maxTokens?: number
  /** 温度参数 */
  temperature?: number
  /** 请求超时（毫秒） */
  timeout?: number
}

/** 默认配置 */
export const DEFAULT_OPENAI_CONFIG: Partial<OpenAIEngineConfig> = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
  timeout: 60000,
}
