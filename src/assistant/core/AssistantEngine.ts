import { OpenAIProtocolEngine } from '../../engines/openai-protocol'
import type { OpenAIMessage } from '../../engines/openai-protocol'
import { getEventBus } from '../../ai-runtime'
import type { AIEvent } from '../../ai-runtime'
import { getSystemPromptWithKnowledge } from './SystemPrompt'
import { ASSISTANT_TOOLS, parseToolCallArgs } from './ToolDefinitions'
import { useAssistantStore } from '../store/assistantStore'
import type {
  AssistantEvent,
  ToolCallInfo,
  ClaudeCodeExecutionEvent,
} from '../types'
import { createLogger } from '../../utils/logger'

const log = createLogger('AssistantEngine')

/** 将 AIEvent 类型映射为 ClaudeCodeExecutionEvent 类型 */
function mapEventType(event: AIEvent): ClaudeCodeExecutionEvent['type'] {
  switch (event.type) {
    case 'tool_call_start':
    case 'tool_call_end':
      return 'tool_call';
    case 'token':
      return 'token';
    case 'thinking':
      return 'progress';
    case 'progress':
      return 'progress';
    case 'error':
      return 'error';
    case 'session_start':
      return 'session_start';
    case 'session_end':
      return 'session_end';
    case 'assistant_message':
      return 'assistant_message';
    case 'result':
      return 'complete';
    default:
      return 'progress';
  }
}

/** 从 AIEvent 安全提取事件数据 */
function extractEventData(event: AIEvent): ClaudeCodeExecutionEvent['data'] {
  switch (event.type) {
    case 'token':
      return { content: event.value };
    case 'assistant_message':
      return { content: event.content, message: event.content };
    case 'thinking':
      return { content: event.content };
    case 'tool_call_start':
      return { tool: event.tool };
    case 'tool_call_end':
      return { tool: event.tool };
    case 'error':
      return { error: event.error };
    case 'progress':
      return { message: event.message };
    case 'result':
      return { content: String(event.output ?? '') };
    default:
      return {};
  }
}

/** 从 AIEvent 安全提取文本内容 */
function extractEventContent(event: AIEvent): string {
  if (event.type === 'assistant_message' || event.type === 'token') {
    return (event.type === 'token' ? event.value : event.content) || '';
  }
  return '';
}

/** 从 AIEvent 安全提取错误信息 */
function extractEventError(event: AIEvent): string {
  if (event.type === 'error') {
    return event.error || '';
  }
  return '';
}

/** 段落级缓冲超时（毫秒） */
const PARAGRAPH_TIMEOUT = 200

/**
 * 段落级文本缓冲器
 *
 * 策略：
 * 1. 首段立即显示（快速响应）
 * 2. 后续段落等待 \n\n（段落结束）才 flush
 * 3. 超时保护：200ms 内没有段落结束也 flush
 *
 * 效果：大幅减少 Zustand 状态更新次数，避免频繁重渲染
 */
class ParagraphBuffer {
  private buffer: string = ''
  private timer: ReturnType<typeof setTimeout> | null = null
  private isFirstChunk: boolean = true
  private flushCallback: ((content: string) => void) | null = null

  /**
   * 设置刷新回调
   */
  setFlushCallback(callback: (content: string) => void): void {
    this.flushCallback = callback
  }

  /**
   * 追加内容到缓冲区
   */
  append(content: string): void {
    this.buffer += content

    // 首次立即 flush（保证首 token 响应速度）
    if (this.isFirstChunk) {
      this.flush()
      this.isFirstChunk = false
      return
    }

    // 段落结束检测：\n\n 表示段落结束
    if (this.buffer.includes('\n\n')) {
      this.cancelTimer()
      this.flush()
      return
    }

    // 启动超时保护定时器
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        this.flush()
      }, PARAGRAPH_TIMEOUT)
    }
  }

  /**
   * 立即刷新缓冲区到回调
   */
  flush(): void {
    this.cancelTimer()

    if (this.buffer && this.flushCallback) {
      this.flushCallback(this.buffer)
      this.buffer = ''
    }
  }

  /**
   * 重置缓冲器状态
   */
  reset(): void {
    this.cancelTimer()
    this.buffer = ''
    this.isFirstChunk = true
  }

  private cancelTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}

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
  /** 后台任务订阅清理函数映射 */
  private backgroundUnsubscribes: Map<string, () => void> = new Map()
  /** 段落级文本缓冲器 */
  private paragraphBuffer: ParagraphBuffer = new ParagraphBuffer()

  /**
   * 初始化引擎
   */
  initialize(config: AssistantEngineConfig): void {
    // 如果已经初始化，先清理
    if (this.llmEngine) {
      this.cleanup()
    }

    // 清理旧的事件订阅
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }

    this.llmEngine = new OpenAIProtocolEngine({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    })

    this.llmEngine.setTools(ASSISTANT_TOOLS)

    // 设置段落级缓冲器的回调
    this.paragraphBuffer.setFlushCallback((content) => {
      useAssistantStore.getState().appendToLastAssistantMessage(content)
    })

    // 订阅事件
    this.subscribeToEvents()

    log.info('AssistantEngine initialized')
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

    // 构建 OpenAI 消息数组（包含历史）
    const contextMessages = this.buildContextMessages()

    // 获取带知识增强的系统提示词
    const systemPrompt = await getSystemPromptWithKnowledge()

    // 创建 LLM 会话，传入历史消息
    const session = this.llmEngine.createSession({
      options: {
        systemPrompt,
        initialMessages: contextMessages,
      },
    })

    yield { type: 'message_start' }

    try {
      // 执行任务 - 只传当前用户消息
      const task = {
        id: `task-${Date.now()}`,
        kind: 'chat' as const,
        input: { prompt: message },
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

      // 重置段落级缓冲器
      this.paragraphBuffer.reset()

      let currentContent = ''
      const pendingToolCalls: ToolCallInfo[] = []

      for await (const event of session.run(task)) {
        // 处理文本增量（使用段落级缓冲）
        if (event.type === 'assistant_message' && event.isDelta) {
          currentContent += event.content
          // 使用段落级缓冲，大幅减少状态更新次数
          this.paragraphBuffer.append(event.content)
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

      // 刷新剩余内容并清除流式状态
      this.paragraphBuffer.flush()
      useAssistantStore.getState().setStreamingMessageId(null)

      // 更新工具调用信息到消息
      if (pendingToolCalls.length > 0) {
        useAssistantStore.getState().updateLastAssistantMessage(currentContent)
        // 更新消息的 toolCalls - 使用 Promise.resolve 替代 setImmediate
        Promise.resolve().then(() => {
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
      log.error('Failed to process message', error instanceof Error ? error : new Error(String(error)))
      useAssistantStore.getState().setStreamingMessageId(null)
      useAssistantStore.getState().setError((error as Error).message)
      throw error
    }
  }

  /**
   * 构建 OpenAI 格式的上下文消息数组
   */
  private buildContextMessages(): OpenAIMessage[] {
    // conversationHistory 不包含当前消息，因为当前消息在 processMessage 中刚添加
    // 这里需要排除最后一条（当前用户消息），因为会通过 task.input.prompt 传入
    const historyMessages = this.conversationHistory.slice(0, -1).map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    }))

    return historyMessages
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
      const session = useAssistantStore.getState().getClaudeCodeSession(sessionId)
      if (session) {
        yield { type: 'session_created', session }
      }
    }

    // 中断指定会话
    if (params.mode === 'interrupt') {
      await useAssistantStore.getState().abortSession(sessionId)
      return
    }

    // 更新工具调用状态
    yield { type: 'tool_call', toolCall: { ...toolCall, status: 'running', claudeCodeSessionId: sessionId } }

    // 后台执行模式：不等待完成，直接返回
    if (params.background !== false) {
      this.executeClaudeCodeBackground(sessionId, params, toolCall.id)
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'running', claudeCodeSessionId: sessionId } }
      return
    }

    // 同步执行模式
    try {
      const result = await this.executeClaudeCode(sessionId, params)
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'completed', claudeCodeSessionId: sessionId } }
      yield* this.feedbackToAI(params.prompt, result, sessionId)
    } catch {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 后台执行 Claude Code（不阻塞主流程）
   */
  private executeClaudeCodeBackground(
    sessionId: string,
    params: ToolCallInfo['arguments'],
    _toolCallId: string
  ): void {
    const events: ClaudeCodeExecutionEvent[] = []
    let output = ''
    let isCompleted = false // 防止重复处理

    // 清理该会话之前的订阅（如果存在）
    const existingUnsubscribe = this.backgroundUnsubscribes.get(sessionId)
    if (existingUnsubscribe) {
      existingUnsubscribe()
    }

    // 订阅事件
    // 注意：使用 _routeSessionId 匹配前端会话 ID，而不是 event.sessionId（后端会话 ID）
    const unsubscribe = this.eventBus.onAny((event: AIEvent) => {
      // 如果已完成，忽略后续事件
      if (isCompleted) return

      const eventWithRouteId = event as { sessionId?: string; _routeSessionId?: string }
      // 优先使用 _routeSessionId（前端会话 ID），其次使用 sessionId
      const eventSessionId = eventWithRouteId._routeSessionId || eventWithRouteId.sessionId

      // 关键修复：如果事件中没有 sessionId，检查是否是当前会话相关的事件
      // 通过检查事件的其他特征来判断（如 tool 相关信息）
      // 但最可靠的方式是确保事件总是携带正确的 sessionId
      if (eventSessionId && eventSessionId !== sessionId) return

      const execEvent: ClaudeCodeExecutionEvent = {
        type: mapEventType(event),
        timestamp: Date.now(),
        sessionId,
        data: {
          ...extractEventData(event),
          isDelta: event.type === 'token',
        },
      }
      events.push(execEvent)
      useAssistantStore.getState().addSessionEvent(sessionId, execEvent)

      if (event.type === 'assistant_message') {
        output += extractEventContent(event)
      }

      // 会话结束
      if (event.type === 'session_end') {
        isCompleted = true
        unsubscribe()
        this.backgroundUnsubscribes.delete(sessionId)
        // 更新会话状态为已完成
        useAssistantStore.getState().updateSessionStatus(sessionId, 'completed')

        // 自动汇报给 AI
        if (params.autoReport !== false && output) {
          this.autoReportToAI(params.prompt, output)
        }
      }

      if (event.type === 'error') {
        isCompleted = true
        unsubscribe()
        this.backgroundUnsubscribes.delete(sessionId)
        // 更新会话状态为错误
        useAssistantStore.getState().updateSessionStatus(sessionId, 'error')
      }
    })

    // 保存订阅清理函数
    this.backgroundUnsubscribes.set(sessionId, unsubscribe)

    // 开始执行
    useAssistantStore.getState().executeInSession(sessionId, params)
  }

  /**
   * 执行 Claude Code 并收集结果
   */
  private executeClaudeCode(sessionId: string, params: ToolCallInfo['arguments']): Promise<string> {
    return new Promise((resolve, reject) => {
      const events: ClaudeCodeExecutionEvent[] = []
      let output = ''

      // 订阅事件
      // 注意：使用 _routeSessionId 匹配前端会话 ID，而不是 event.sessionId（后端会话 ID）
      const unsubscribe = this.eventBus.onAny((event: AIEvent) => {
        const eventWithRouteId = event as { sessionId?: string; _routeSessionId?: string }
        // 优先使用 _routeSessionId（前端会话 ID），其次使用 sessionId
        const eventSessionId = eventWithRouteId._routeSessionId || eventWithRouteId.sessionId
        if (eventSessionId !== sessionId) return

        // 收集事件
        const execEvent: ClaudeCodeExecutionEvent = {
          type: mapEventType(event),
          timestamp: Date.now(),
          sessionId,
          data: extractEventData(event),
        }
        events.push(execEvent)
        useAssistantStore.getState().addSessionEvent(sessionId, execEvent)

        // 收集输出
        if (event.type === 'assistant_message') {
          output += extractEventContent(event)
        }

        // 会话结束
        if (event.type === 'session_end') {
          unsubscribe()
          resolve(output)
        }

        // 错误
        if (event.type === 'error') {
          unsubscribe()
          reject(new Error(extractEventError(event) || 'Claude Code 执行失败'))
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

    // 构建 OpenAI 消息数组（包含历史）
    const contextMessages = this.buildContextMessages()

    // 获取带知识增强的系统提示词
    const systemPrompt = await getSystemPromptWithKnowledge()

    // 创建新的 LLM 会话处理反馈
    const session = this.llmEngine.createSession({
      options: {
        systemPrompt,
        initialMessages: contextMessages,
      },
    })

    const task = {
      id: `task-feedback-${Date.now()}`,
      kind: 'chat' as const,
      input: { prompt: feedbackMessage },
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

    // 重置段落级缓冲器
    this.paragraphBuffer.reset()

    let currentContent = ''

    for await (const event of session.run(task)) {
      if (event.type === 'assistant_message' && event.isDelta) {
        currentContent += event.content
        // 使用段落级缓冲
        this.paragraphBuffer.append(event.content)
        yield { type: 'content_delta', content: event.content }
      }
    }

    // 刷新剩余内容
    this.paragraphBuffer.flush()
    useAssistantStore.getState().setStreamingMessageId(null)
    this.conversationHistory.push({ role: 'assistant', content: currentContent })

    yield { type: 'message_complete' }
  }

  /**
   * 自动将后台任务结果汇报给 AI
   * 用于实现 AI 主动汇报能力
   */
  private autoReportToAI(prompt: string, result: string): void {
    if (!this.llmEngine || !result) return

    // 构建汇报消息
    const reportMessage = `后台任务已完成。

**执行的提示词：**
${prompt}

**执行结果：**
${result}

请根据以上结果主动向用户汇报，并建议下一步操作。`

    // 添加到对话历史
    this.conversationHistory.push({ role: 'user', content: reportMessage })

    // 异步处理，不阻塞主流程
    this.processAutoReport(reportMessage).catch((error) => {
      log.error('Auto-report failed', error instanceof Error ? error : new Error(String(error)))
    })
  }

  /**
   * 处理自动汇报的 LLM 调用
   */
  private async processAutoReport(reportMessage: string): Promise<void> {
    if (!this.llmEngine) return

    // 构建 OpenAI 消息数组（包含历史）
    const contextMessages = this.buildContextMessages()

    // 获取带知识增强的系统提示词
    const systemPrompt = await getSystemPromptWithKnowledge()

    // 创建新的 LLM 会话处理汇报
    const session = this.llmEngine.createSession({
      options: {
        systemPrompt,
        initialMessages: contextMessages,
      },
    })

    const task = {
      id: `task-auto-report-${Date.now()}`,
      kind: 'chat' as const,
      input: { prompt: reportMessage },
    }

    // 创建助手消息用于流式更新
    const assistantMessageId = `assistant-auto-report-${Date.now()}`
    useAssistantStore.getState().addMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
    })
    useAssistantStore.getState().setStreamingMessageId(assistantMessageId)

    // 重置段落级缓冲器
    this.paragraphBuffer.reset()

    let currentContent = ''

    for await (const event of session.run(task)) {
      if (event.type === 'assistant_message' && event.isDelta) {
        currentContent += event.content
        // 使用段落级缓冲
        this.paragraphBuffer.append(event.content)
      }
    }

    // 刷新剩余内容
    this.paragraphBuffer.flush()
    useAssistantStore.getState().setStreamingMessageId(null)
    this.conversationHistory.push({ role: 'assistant', content: currentContent })
  }

  /**
   * 订阅事件
   */
  private subscribeToEvents(): void {
    this.eventUnsubscribe = this.eventBus.onAny((event: AIEvent) => {
      // 同步会话状态
      if (event.type === 'session_start' || event.type === 'session_end') {
        const eventWithSession = event as { sessionId?: string; _routeSessionId?: string; type: string }
        // 优先使用 _routeSessionId（前端会话 ID）
        const sessionId = eventWithSession._routeSessionId || eventWithSession.sessionId
        if (sessionId) {
          // 检查是否是 Claude Code 会话
          const claudeCodeSession = useAssistantStore.getState().getClaudeCodeSession(sessionId)
          if (claudeCodeSession) {
            // 如果会话已经是 completed 或 error 状态，说明 executeClaudeCodeBackground 已处理
            // 这里作为兜底，确保状态同步（防止事件 ID 不匹配导致的状态卡住）
            if (claudeCodeSession.status === 'running') {
              const status = event.type === 'session_start' ? 'running' : 'completed'
              log.info(`Fallback status sync: ${sessionId} -> ${status}`)
              useAssistantStore.getState().updateSessionStatus(sessionId, status)
            }
            return
          }
          const status = event.type === 'session_start' ? 'running' : 'idle'
          useAssistantStore.getState().updateSessionStatus(sessionId, status)
        }
      }
    })
  }

  /**
   * 清空对话历史（不清理引擎本身）
   */
  clearHistory(): void {
    // 清空对话历史
    this.conversationHistory = []

    // 清理所有后台任务订阅
    this.backgroundUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.backgroundUnsubscribes.clear()
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 清理所有后台任务订阅
    this.backgroundUnsubscribes.forEach((unsubscribe) => unsubscribe())
    this.backgroundUnsubscribes.clear()

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

/**
 * 清空对话（包括消息、会话、通知、历史）
 */
export function clearConversation(): void {
  const store = useAssistantStore.getState()

  // 1. 检查是否有正在运行的任务
  const runningSessions = store.getRunningSessions()
  if (runningSessions.length > 0) {
    // 中断所有运行中的任务
    store.abortAllSessions()
  }

  // 2. 清理 store 状态
  store.clearMessages()

  // 3. 清理所有非 primary 会话
  const allSessions = store.getAllClaudeCodeSessions()
  const nonPrimarySessions = allSessions.filter(s => s.id !== 'primary')
  if (nonPrimarySessions.length > 0) {
    store.clearSessions(nonPrimarySessions.map(s => s.id))
  }

  // 4. 清理 Engine 内部历史
  if (engineInstance) {
    engineInstance.clearHistory()
  }

  // 5. 重置错误状态
  store.setError(null)
  store.setStreamingMessageId(null)
  store.setLoading(false)

  log.info('Conversation cleared')
}
