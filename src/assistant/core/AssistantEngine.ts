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
  CompletionNotification,
} from '../types'

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
    } catch (error) {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 后台执行 Claude Code（不阻塞主流程）
   */
  private executeClaudeCodeBackground(
    sessionId: string,
    params: ToolCallInfo['arguments'],
    toolCallId: string
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
        type: event.type as any,
        timestamp: Date.now(),
        sessionId,
        data: {
          content: (event as any).content,
          message: (event as any).message,
          tool: (event as any).tool,
          error: (event as any).error,
          isDelta: (event as any).isDelta,
        },
      }
      events.push(execEvent)
      useAssistantStore.getState().addSessionEvent(sessionId, execEvent)

      if (event.type === 'assistant_message' && (event as any).content) {
        output += (event as any).content
      }

      // 会话结束，创建通知
      if (event.type === 'session_end') {
        isCompleted = true
        unsubscribe()
        this.backgroundUnsubscribes.delete(sessionId)
        // 更新会话状态为已完成
        useAssistantStore.getState().updateSessionStatus(sessionId, 'completed')
        const notification: CompletionNotification = {
          id: `notification-${Date.now()}`,
          sessionId,
          toolCallId,
          prompt: params.prompt,
          resultSummary: output.slice(0, 200) + (output.length > 200 ? '...' : ''),
          fullResult: output,
          createdAt: Date.now(),
          handled: false,
        }
        useAssistantStore.getState().addCompletionNotification(notification)

        // 发出事件通知 UI
        this.eventBus.emit({
          type: 'assistant_notification' as any,
          notification,
        } as any)

        // 自动汇报给 AI（核心改动）
        if (params.autoReport !== false && output) {
          this.autoReportToAI(params.prompt, output, notification.id)
        }
      }

      if (event.type === 'error') {
        isCompleted = true
        unsubscribe()
        this.backgroundUnsubscribes.delete(sessionId)
        // 更新会话状态为错误
        useAssistantStore.getState().updateSessionStatus(sessionId, 'error')
        const notification: CompletionNotification = {
          id: `notification-${Date.now()}`,
          sessionId,
          toolCallId,
          prompt: params.prompt,
          resultSummary: `执行失败: ${(event as any).error || '未知错误'}`,
          createdAt: Date.now(),
          handled: false,
        }
        useAssistantStore.getState().addCompletionNotification(notification)

        // 发出事件通知 UI
        this.eventBus.emit({
          type: 'assistant_notification' as any,
          notification,
        } as any)
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
  private autoReportToAI(
    prompt: string,
    result: string,
    notificationId: string
  ): void {
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

    // 标记通知已自动汇报
    useAssistantStore.getState().markNotificationAutoReported(notificationId)

    // 异步处理，不阻塞主流程
    this.processAutoReport(reportMessage, notificationId).catch((error) => {
      console.error('[AssistantEngine] 自动汇报失败:', error)
      // 标记自动汇报失败，让用户可以手动处理
      useAssistantStore.getState().updateNotificationError(
        notificationId,
        `自动汇报失败: ${(error as Error).message}`
      )
    })
  }

  /**
   * 处理自动汇报的 LLM 调用
   */
  private async processAutoReport(reportMessage: string, notificationId: string): Promise<void> {
    if (!this.llmEngine) return

    // 创建新的 LLM 会话处理汇报
    const session = this.llmEngine.createSession({
      options: { systemPrompt: getSystemPrompt() },
    })

    const task = {
      id: `task-auto-report-${Date.now()}`,
      kind: 'chat' as const,
      input: { prompt: this.buildPromptWithHistory(reportMessage) },
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

    // 发出事件通知 UI 对话已完成，使用通知关联的会话 ID
    const notification = useAssistantStore.getState().completionNotifications.find(n => n.id === notificationId)
    this.eventBus.emit({
      type: 'assistant_auto_report_complete',
      sessionId: notification?.sessionId || this.llmEngine.id,
      message: currentContent,
    } as any)
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
              console.log(`[AssistantEngine] 兜底状态同步: ${sessionId} -> ${status}`)
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
  store.clearNotifications()

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

  console.log('[AssistantEngine] 对话已清空')
}
