import type { AISession, AISessionStatus } from '../../ai-runtime'
import type { AITask, AIEvent } from '../../ai-runtime'
import { EventEmitter } from '../../ai-runtime'
import type { OpenAIEngineConfig, OpenAIMessage, OpenAITool, OpenAIToolCall } from './types'

/**
 * OpenAI 会话配置
 */
export interface OpenAISessionConfig extends OpenAIEngineConfig {
  /** 系统提示词 */
  systemPrompt?: string
  /** 初始消息历史（用于多轮对话） */
  initialMessages?: OpenAIMessage[]
}

/**
 * OpenAI 协议会话
 */
export class OpenAISession extends EventEmitter implements AISession {
  readonly id: string
  status: AISessionStatus = 'idle'

  private config: OpenAISessionConfig
  private messages: OpenAIMessage[] = []
  private tools: OpenAITool[] = []
  private abortController: AbortController | null = null

  constructor(id: string, config: OpenAISessionConfig) {
    super()
    this.id = id
    this.config = config

    // 初始化系统消息
    if (config.systemPrompt) {
      this.messages.push({
        role: 'system',
        content: config.systemPrompt,
      })
    }

    // 初始化历史消息（用于多轮对话）
    if (config.initialMessages && config.initialMessages.length > 0) {
      // 过滤掉 system 消息，因为已经通过 systemPrompt 设置
      const nonSystemMessages = config.initialMessages.filter(m => m.role !== 'system')
      this.messages.push(...nonSystemMessages)
    }
  }

  /**
   * 设置可用工具
   */
  setTools(tools: OpenAITool[]): void {
    this.tools = tools
  }

  /**
   * 执行任务
   */
  async *run(task: AITask): AsyncIterable<AIEvent> {
    this.status = 'running'
    this.abortController = new AbortController()

    // 添加用户消息
    // 如果 prompt 是 JSON 格式的消息数组，则直接使用
    // 否则作为普通字符串处理
    if (task.input.prompt.startsWith('[')) {
      try {
        const parsedMessages = JSON.parse(task.input.prompt) as OpenAIMessage[]
        // 过滤掉 system 消息（已通过 systemPrompt 设置）
        const userMessages = parsedMessages.filter(m => m.role !== 'system')
        this.messages.push(...userMessages)
      } catch {
        // 解析失败，作为普通字符串处理
        this.messages.push({
          role: 'user',
          content: task.input.prompt,
        })
      }
    } else {
      this.messages.push({
        role: 'user',
        content: task.input.prompt,
      })
    }

    try {
      // 流式调用 API
      yield* this.streamCompletion()
    } catch (error) {
      this.status = 'idle'
      // 清理 AbortController
      this.abortController = null
      throw error
    }

    this.status = 'idle'
  }

  /**
   * 流式调用 OpenAI API
   */
  private async *streamCompletion(): AsyncIterable<AIEvent> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: this.messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
        tool_choice: this.tools.length > 0 ? 'auto' : undefined,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        stream: true,
      }),
      signal: this.abortController?.signal,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }))
      throw new Error(error.error?.message || `API error: ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body is null')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let currentToolCalls: Map<number, OpenAIToolCall> = new Map()
    let assistantContent = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') continue

            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              const finishReason = chunk.choices?.[0]?.finish_reason

              if (delta?.content) {
                assistantContent += delta.content
                yield {
                  type: 'assistant_message',
                  sessionId: this.id,
                  content: delta.content,
                  isDelta: true,
                }
              }

              // 处理工具调用
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = currentToolCalls.get(tc.index)
                  if (existing) {
                    // 追加参数
                    if (tc.function?.arguments) {
                      existing.function.arguments += tc.function.arguments
                    }
                  } else {
                    // 新建工具调用
                    currentToolCalls.set(tc.index, {
                      id: tc.id || `call_${tc.index}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      },
                    })
                  }
                }
              }

              // 流结束
              if (finishReason === 'stop' || finishReason === 'tool_calls') {
                // 保存 assistant 消息
                const assistantMessage: OpenAIMessage = {
                  role: 'assistant',
                  content: assistantContent || null,
                }

                if (currentToolCalls.size > 0) {
                  assistantMessage.tool_calls = Array.from(currentToolCalls.values())

                  // 发送工具调用事件
                  for (const tc of assistantMessage.tool_calls) {
                    yield {
                      type: 'tool_call_start',
                      sessionId: this.id,
                      callId: tc.id,
                      tool: tc.function.name,
                      args: JSON.parse(tc.function.arguments),
                    }
                  }
                }

                this.messages.push(assistantMessage)
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }

    // 流结束后发出 session_end 事件
    this.status = 'idle'
    this.emit({
      type: 'session_end',
      sessionId: this.id,
    })
  }

  /**
   * 添加工具结果
   */
  addToolResult(toolCallId: string, result: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: result,
    })
  }

  /**
   * 中断执行
   */
  abort(): void {
    this.abortController?.abort()
    this.status = 'idle'
  }

  /**
   * 销毁会话
   */
  dispose(): void {
    this.abort()
    this.removeAllListeners()
    this.messages = []
  }

  /**
   * 获取消息历史
   */
  getMessages(): OpenAIMessage[] {
    return [...this.messages]
  }
}
