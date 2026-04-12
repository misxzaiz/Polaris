import { OpenAIProtocolEngine } from '../../engines/openai-protocol'
import { getEventBus } from '../../ai-runtime'
import type { AIEvent } from '../../ai-runtime'
import { getSystemPrompt } from './SystemPrompt'
import { ASSISTANT_TOOLS, parseToolCallArgs } from './ToolDefinitions'
import { useAssistantStore } from '../store/assistantStore'
import type {
  AssistantEvent,
  ToolCallInfo,
  ClaudeCodeExecutionEvent,
} from '../types'

/**
 * 助手引擎配置
 */
export interface AssistantEngineConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
}

/**
 * 助手引擎
 *
 * 负责：
 * 1. 协调 LLM 调用
 * 2. 处理工具调用
 * 3. 管理 Claude Code 会话
 */
export class AssistantEngine {
  private llmEngine: OpenAIProtocolEngine | null = null
  private eventBus = getEventBus()
  private eventUnsubscribe: (() => void) | null = null
  /** 对话历史，用于多轮对话 */
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = []

  /**
   * 初始化引擎
   */
  initialize(config: AssistantEngineConfig): void {
    this.llmEngine = new OpenAIProtocolEngine({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    })

    this.llmEngine.setTools(ASSISTANT_TOOLS)

    // 订阅事件
    this.subscribeToEvents()

    console.log('[AssistantEngine] 初始化完成')
  }

  /**
   * 处理用户消息
   */
  async *processMessage(message: string): AsyncGenerator<AssistantEvent> {
    if (!this.llmEngine) {
      throw new Error('AssistantEngine not initialized')
    }

    // 添加用户消息到 store
    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user' as const,
      content: message,
      timestamp: Date.now(),
    }
    useAssistantStore.getState().addMessage(userMessage)

    // 添加到对话历史
    this.conversationHistory.push({ role: 'user', content: message })

    // 创建 LLM 会话
    const session = this.llmEngine.createSession({
      options: { systemPrompt: getSystemPrompt() },
    })

    yield { type: 'message_start' }

    try {
      // 构建包含历史的提示
      const promptWithHistory = this.buildPromptWithHistory(message)

      // 执行任务
      const task = {
        id: `task-${Date.now()}`,
        kind: 'chat' as const,
        input: { prompt: promptWithHistory },
      }

      // 预先创建助手消息用于流式更新
      const assistantMessageId = `assistant-${Date.now()}`
      const assistantMessage = {
        id: assistantMessageId,
        role: 'assistant' as const,
        content: '',
        timestamp: Date.now(),
      }
      useAssistantStore.getState().addMessage(assistantMessage)
      useAssistantStore.getState().setStreamingMessageId(assistantMessageId)

      let currentContent = ''
      const pendingToolCalls: ToolCallInfo[] = []

      for await (const event of session.run(task)) {
        // 处理文本增量
        if (event.type === 'assistant_message' && event.isDelta) {
          currentContent += event.content
          // 实时更新消息内容
          useAssistantStore.getState().appendToLastAssistantMessage(event.content)
          yield { type: 'content_delta', content: event.content }
        }

        // 处理工具调用开始
        if (event.type === 'tool_call_start') {
          const toolCallInfo: ToolCallInfo = {
            id: event.callId || `tc-${Date.now()}`,
            name: event.tool,
            arguments: parseToolCallArgs(JSON.stringify(event.args)),
            status: 'pending',
          }
          pendingToolCalls.push(toolCallInfo)
        }
      }

      // 清除流式状态
      useAssistantStore.getState().setStreamingMessageId(null)

      // 更新工具调用信息到消息
      if (pendingToolCalls.length > 0) {
        useAssistantStore.getState().updateLastAssistantMessage(currentContent)
        // 更新消息的 toolCalls
        setImmediate(() => {
          const messages = useAssistantStore.getState().messages
          const lastMsg = messages[messages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            // 直接修改最后一条消息
            useAssistantStore.setState((state) => {
              const updatedMessages = [...state.messages]
              const idx = updatedMessages.length - 1
              if (idx >= 0 && updatedMessages[idx].role === 'assistant') {
                updatedMessages[idx] = {
                  ...updatedMessages[idx],
                  toolCalls: pendingToolCalls,
                }
              }
              return { messages: updatedMessages }
            })
          }
        })
      }

      // 添加到对话历史
      this.conversationHistory.push({ role: 'assistant', content: currentContent })

      // 处理工具调用
      for (const toolCall of pendingToolCalls) {
        yield* this.handleToolCall(toolCall)
      }

      yield { type: 'message_complete' }
    } catch (error) {
      console.error('[AssistantEngine] 处理消息失败:', error)
      useAssistantStore.getState().setStreamingMessageId(null)
      useAssistantStore.getState().setError((error as Error).message)
      throw error
    }
  }

  /**
   * 构建包含历史的提示
   */
  private buildPromptWithHistory(currentMessage: string): string {
    if (this.conversationHistory.length <= 1) {
      return currentMessage
    }

    // 构建历史上下文
    const historyParts = this.conversationHistory.slice(0, -1).map((msg) => {
      return `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}`
    })

    return `以下是之前的对话历史：
${historyParts.join('\n\n')}

用户最新消息: ${currentMessage}`
  }

  /**
   * 处理工具调用
   */
  private async *handleToolCall(toolCall: ToolCallInfo): AsyncGenerator<AssistantEvent> {
    if (toolCall.name !== 'invoke_claude_code') {
      return
    }

    const params = toolCall.arguments
    let sessionId = params.sessionId || 'primary'

    // 创建新会话
    if (params.mode === 'new' || sessionId.startsWith('new-')) {
      const purpose = sessionId.replace('new-', '') || 'analysis'
      sessionId = useAssistantStore.getState().createClaudeCodeSession(
        params.background ? 'background' : 'analysis',
        purpose
      )
      yield { type: 'session_created', session: useAssistantStore.getState().getClaudeCodeSession(sessionId)! }
    }

    // 中断指定会话
    if (params.mode === 'interrupt') {
      await useAssistantStore.getState().abortSession(sessionId)
      return
    }

    // 更新工具调用状态
    yield { type: 'tool_call', toolCall: { ...toolCall, status: 'running', claudeCodeSessionId: sessionId } }

    try {
      // 收集执行结果
      const result = await this.executeClaudeCode(sessionId, params)

      // 非后台任务等待完成并反馈结果
      if (!params.background) {
        yield { type: 'tool_call', toolCall: { ...toolCall, status: 'completed', claudeCodeSessionId: sessionId } }

        // 将执行结果反馈给 AI
        yield* this.feedbackToAI(params.prompt, result, sessionId)
      }
    } catch (error) {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 执行 Claude Code 并收集结果
   */
  private executeClaudeCode(sessionId: string, params: ToolCallInfo['arguments']): Promise<string> {
    return new Promise((resolve, reject) => {
      const events: ClaudeCodeExecutionEvent[] = []
      let output = ''

      // 订阅事件
      const unsubscribe = this.eventBus.onAny((event: AIEvent) => {
        // 检查事件是否有 sessionId 属性
        const eventWithSession = event as { sessionId?: string }
        if (eventWithSession.sessionId !== sessionId) return

        // 收集事件
        const execEvent: ClaudeCodeExecutionEvent = {
          type: event.type as any,
          timestamp: Date.now(),
          sessionId,
          data: {
            content: (event as any).content,
            message: (event as any).message,
            tool: (event as any).tool,
            error: (event as any).error,
          },
        }
        events.push(execEvent)
        useAssistantStore.getState().addSessionEvent(sessionId, execEvent)

        // 收集输出
        if (event.type === 'assistant_message' && (event as any).content) {
          output += (event as any).content
        }

        // 会话结束
        if (event.type === 'session_end') {
          unsubscribe()
          resolve(output)
        }

        // 错误
        if (event.type === 'error') {
          unsubscribe()
          reject(new Error((event as any).error || 'Claude Code 执行失败'))
        }
      })

      // 开始执行
      useAssistantStore.getState().executeInSession(sessionId, params)
    })
  }

  /**
   * 将 Claude Code 执行结果反馈给 AI
   */
  private async *feedbackToAI(prompt: string, result: string, _sessionId: string): AsyncGenerator<AssistantEvent> {
    if (!this.llmEngine || !result) return

    // 构建反馈消息
    const feedbackMessage = `Claude Code 已完成执行。

**执行的提示词：**
${prompt}

**执行结果：**
${result}

请根据以上执行结果进行下一步操作或回复用户。`

    // 添加反馈到对话历史
    this.conversationHistory.push({ role: 'user', content: feedbackMessage })

    // 创建新的 LLM 会话处理反馈
    const session = this.llmEngine.createSession({
      options: { systemPrompt: getSystemPrompt() },
    })

    const task = {
      id: `task-feedback-${Date.now()}`,
      kind: 'chat' as const,
      input: { prompt: this.buildPromptWithHistory(feedbackMessage) },
    }

    // 创建助手消息用于流式更新
    const assistantMessageId = `assistant-feedback-${Date.now()}`
    useAssistantStore.getState().addMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    })
    useAssistantStore.getState().setStreamingMessageId(assistantMessageId)

    let currentContent = ''

    for await (const event of session.run(task)) {
      if (event.type === 'assistant_message' && event.isDelta) {
        currentContent += event.content
        useAssistantStore.getState().appendToLastAssistantMessage(event.content)
        yield { type: 'content_delta', content: event.content }
      }
    }

    useAssistantStore.getState().setStreamingMessageId(null)
    this.conversationHistory.push({ role: 'assistant', content: currentContent })

    yield { type: 'message_complete' }
  }

  /**
   * 订阅事件
   */
  private subscribeToEvents(): void {
    this.eventUnsubscribe = this.eventBus.onAny((event: AIEvent) => {
      // 同步会话状态
      if (event.type === 'session_start' || event.type === 'session_end') {
        const eventWithSession = event as { sessionId?: string; type: string }
        const sessionId = eventWithSession.sessionId
        if (sessionId) {
          const status = event.type === 'session_start' ? 'running' : 'idle'
          useAssistantStore.getState().updateSessionStatus(sessionId, status)
        }
      }
    })
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }
    if (this.llmEngine) {
      this.llmEngine.cleanup()
      this.llmEngine = null
    }
    // 清空对话历史
    this.conversationHistory = []
  }
}

/**
 * 全局单例
 */
let engineInstance: AssistantEngine | null = null

export function getAssistantEngine(): AssistantEngine {
  if (!engineInstance) {
    engineInstance = new AssistantEngine()
  }
  return engineInstance
}

export function resetAssistantEngine(): void {
  if (engineInstance) {
    engineInstance.cleanup()
    engineInstance = null
  }
}
