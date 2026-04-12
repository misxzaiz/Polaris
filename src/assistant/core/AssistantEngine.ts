import { OpenAIProtocolEngine } from '../../engines/openai-protocol'
import { getEventBus } from '../../ai-runtime'
import type { AIEvent } from '../../ai-runtime'
import { getSystemPrompt } from './SystemPrompt'
import { ASSISTANT_TOOLS, parseToolCallArgs } from './ToolDefinitions'
import { useAssistantStore } from '../store/assistantStore'
import type {
  AssistantEvent,
  ToolCallInfo,
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

    // 创建 LLM 会话
    const session = this.llmEngine.createSession({
      options: { systemPrompt: getSystemPrompt() },
    })

    yield { type: 'message_start' }

    try {
      // 执行任务
      const task = {
        id: `task-${Date.now()}`,
        kind: 'chat' as const,
        input: { prompt: message },
      }

      let currentContent = ''
      const pendingToolCalls: ToolCallInfo[] = []

      for await (const event of session.run(task)) {
        // 处理文本增量
        if (event.type === 'assistant_message' && event.isDelta) {
          currentContent += event.content
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

      // 更新助手消息
      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant' as const,
        content: currentContent,
        timestamp: Date.now(),
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      }
      useAssistantStore.getState().addMessage(assistantMessage)

      // 处理工具调用
      for (const toolCall of pendingToolCalls) {
        yield* this.handleToolCall(toolCall)
      }

      yield { type: 'message_complete' }
    } catch (error) {
      console.error('[AssistantEngine] 处理消息失败:', error)
      useAssistantStore.getState().setError((error as Error).message)
      throw error
    }
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
      // 执行任务
      await useAssistantStore.getState().executeInSession(sessionId, params)

      // 非后台任务等待完成
      if (!params.background) {
        await this.waitForSessionCompletion(sessionId)
      }

      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'completed', claudeCodeSessionId: sessionId } }
    } catch (error) {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 等待会话完成
   */
  private waitForSessionCompletion(sessionId: string): Promise<void> {
    return new Promise((resolve) => {
      const unsubscribe = this.eventBus.onAny((event: AIEvent) => {
        if (event.type === 'session_end' && event.sessionId === sessionId) {
          unsubscribe()
          resolve()
        }
      })
    })
  }

  /**
   * 订阅事件
   */
  private subscribeToEvents(): void {
    this.eventUnsubscribe = this.eventBus.onAny((event: AIEvent) => {
      // 同步会话状态
      if (event.type === 'session_start' || event.type === 'session_end') {
        const sessionId = event.sessionId
        const status = event.type === 'session_start' ? 'running' : 'idle'
        useAssistantStore.getState().updateSessionStatus(sessionId, status)
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
