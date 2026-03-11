/**
 * OpenAI Provider Session
 *
 * 通用的 OpenAI 协议会话实现，负责：
 * - 对话历史管理（上下文记忆）
 * - 工具调用循环
 * - 流式响应处理
 * - 与 Tauri 后端的工具执行桥接
 *
 * @author Polaris Team
 * @since 2025-03-11
 */

import type { AISessionConfig } from '../../ai-runtime'
import type { AITask, AIEvent } from '../../ai-runtime'
import { BaseSession } from '../../ai-runtime/base'
import { createEventIterable } from '../../ai-runtime/base'
import { ToolCallManager } from './tool-manager'
import { generateToolSchemas, generateToolSchemasForIntent } from './tools'
import { tokenTracker } from '../../ai-runtime/token-manager'
import { PromptBuilder, IntentDetector, type Intent } from './core'

/**
 * OpenAI API 消息格式
 */
interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: Array<{
    id: string
    type: string
    function: {
      name: string
      arguments: string
    }
  }>
  tool_call_id?: string
}

/**
 * OpenAI API 响应格式
 */
interface OpenAIResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string | null
      tool_calls: Array<{
        id: string
        type: string
        function: {
          name: string
          arguments: string
        }
      }> | null
    }
    finish_reason: string
  }>
  usage: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * OpenAI Provider 会话配置
 */
export interface OpenAIProviderSessionConfig extends AISessionConfig {
  /** Provider ID */
  providerId: string
  /** Provider Name */
  providerName: string
  /** API Key */
  apiKey: string
  /** API Base URL */
  apiBase: string
  /** 模型名称 */
  model: string
  /** 温度参数 */
  temperature: number
  /** 最大 Token 数 */
  maxTokens: number
  /** 工作区路径 */
  workspaceDir?: string
  /** 超时时间 */
  timeout: number
  /** 是否支持工具调用 */
  supportsTools: boolean
}

/**
 * 工具调用信息
 */
interface ToolCall {
  id: string
  name: string
  arguments: Record<string, any>
}

/**
 * OpenAI Provider Session 实现
 *
 * 核心流程：
 * 1. 接收用户消息
 * 2. 调用 OpenAI 兼容 API
 * 3. 检查是否有工具调用
 * 4. 如果有工具调用，执行工具并获取结果
 * 5. 将工具结果添加到对话历史
 * 6. 重复步骤 2-5，直到没有工具调用
 * 7. 返回最终响应
 */
export class OpenAIProviderSession extends BaseSession {
  /** 会话配置 */
  protected config: OpenAIProviderSessionConfig

  /** 对话历史 */
  private messages: OpenAIMessage[] = []

  /** 工具调用管理器 */
  private toolCallManager: ToolCallManager

  /** 当前任务 ID */
  // private currentTaskId: string | null = null

  /** 当前意图 */
  private currentIntent: Intent | null = null

  /** 最大工具调用迭代次数 (防止无限循环) */
  private readonly MAX_TOOL_ITERATIONS = 10000

  /** 提示词构建器 */
  private promptBuilder: PromptBuilder

  /** 意图检测器 */
  private intentDetector: IntentDetector

  /**
   * 构造函数
   *
   * @param id - 会话 ID
   * @param config - 会话配置
   */
  constructor(id: string, config: OpenAIProviderSessionConfig) {
    super({ id, config })
    this.config = config
    this.toolCallManager = new ToolCallManager(id, config)

    // 初始化核心组件
    this.promptBuilder = new PromptBuilder({
      workspaceDir: config.workspaceDir || '',
      verbose: config.verbose
    })
    this.intentDetector = new IntentDetector()

    // 初始化系统消息（使用精简版本）
    this.initializeSystemMessage()

    console.log(`[OpenAIProviderSession] Session ${id} created for ${config.providerName}`)
  }

  /**
   * 执行任务
   *
   * @param task - AI 任务
   * @returns 事件流
   */
  protected async executeTask(task: AITask): Promise<AsyncIterable<AIEvent>> {
    // this.currentTaskId = task.id

    // 🔄 渐进式提示词：根据意图动态构建系统提示词
    const userMessage = task.input.prompt
    const intent = this.intentDetector.detect(userMessage)
    this.currentIntent = intent  // 存储意图供后续使用

    const fullSystemPrompt = await this.buildFullSystemPrompt(userMessage)

    // 更新系统消息
    this.messages[0] = {
      role: 'system',
      content: fullSystemPrompt,
    }

    // 添加用户消息到历史
    this.addUserMessage(userMessage)

    // 先创建事件迭代器，注册监听器
    // 这样 runToolLoop() 中发送的事件才能被捕获
    const eventIterable = createEventIterable(
      this.eventEmitter,
      (event) => event.type === 'session_end' || event.type === 'error'
    )

    // 在后台运行工具循环（不等待）
    // 这样事件发送时，监听器已经注册好了
    this.runToolLoop().catch(error => {
      console.error('[OpenAIProviderSession] Tool loop failed:', error)
      this.emit({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    })

    // 立即返回事件迭代器
    return eventIterable
  }

  /**
   * 工具调用循环 (核心逻辑)
   *
   * 循环执行以下步骤：
   * 1. 调用 OpenAI API
   * 2. 解析响应内容
   * 3. 检查是否有工具调用
   * 4. 如果有，执行工具并获取结果
   * 5. 将工具结果添加到历史
   * 6. 重复直到没有工具调用或达到最大迭代次数
   */
  private async runToolLoop(): Promise<void> {
    let iteration = 0

    while (iteration < this.MAX_TOOL_ITERATIONS) {
      iteration++

      console.log(`[OpenAIProviderSession] Tool loop iteration ${iteration}`)

      // 步骤 1: 调用 OpenAI API
      const response = await this.callOpenAIAPI()

      if (!response) {
        // API 调用失败，退出循环
        console.error('[OpenAIProviderSession] API call failed, exiting loop')
        break
      }

      // 步骤 2: 解析响应
      const message = response.choices[0].message

      // 步骤 3: 处理文本内容
      const textContent = message.content || ''
      if (textContent) {
        // 模拟流式输出（逐字符发送）
        this.emit({
          type: 'assistant_message',
          content: textContent,
          isDelta: true,
        })
      }

      // 步骤 4: 提取工具调用
      const toolCalls = this.extractToolCalls(message)

      if (toolCalls.length === 0) {
        // 没有工具调用，正常退出循环
        console.log('[OpenAIProviderSession] No tool calls, exiting loop')
        break
      }

      // 步骤 5: 执行所有工具调用
      for (const toolCall of toolCalls) {
        await this.executeToolCall(toolCall)
      }

      // 步骤 6: 工具结果已添加到消息历史，继续下一轮
      console.log(`[OpenAIProviderSession] Tool calls completed, continuing to next iteration`)

      // 发送进度事件
      this.emit({
        type: 'progress',
        message: `正在处理工具调用结果... (${iteration}/${this.MAX_TOOL_ITERATIONS})`,
      })
    }

    // 检查是否达到最大迭代次数
    if (iteration >= this.MAX_TOOL_ITERATIONS) {
      console.warn('[OpenAIProviderSession] Reached max tool iterations')
      this.emit({
        type: 'progress',
        message: '达到最大工具调用次数，可能会影响任务完成',
      })
    }

    // 发送会话结束事件
    this.emit({
      type: 'session_end',
      sessionId: this.id,
    })
  }

  /**
   * 调用 OpenAI API
   *
   * @returns API 响应，失败返回 null
   */
  private async callOpenAIAPI(): Promise<OpenAIResponse | null> {
    try {
      // 检查是否支持工具调用
      const supportsTools = this.config.supportsTools

      // 根据意图生成工具 Schema（按需优化）
      const tools = supportsTools && this.currentIntent && this.currentIntent.requiresTools
        ? generateToolSchemasForIntent(this.currentIntent.requiredTools)
        : supportsTools
        ? generateToolSchemas()
        : []

      console.log(`[OpenAIProviderSession] Tools included:`, {
        count: tools.length,
        intent: this.currentIntent?.type,
        requiredTools: this.currentIntent?.requiredTools,
        supportsTools,
      })

      // 裁剪消息历史以适应 token 预算
      const trimmedMessages = this.trimMessagesToFitBudget()

      // 构建请求
      const requestBody: any = {
        model: this.config.model,
        messages: trimmedMessages, // 使用裁剪后的消息
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
        stream: false, // 工具调用需要完整响应
      }

      // 只在支持工具调用时添加 tools 参数
      if (supportsTools && tools.length > 0) {
        requestBody.tools = tools
      }

      console.log('[OpenAIProviderSession] Calling API', {
        model: this.config.model,
        provider: this.config.providerName,
        messageCount: trimmedMessages.length,
        originalCount: this.messages.length,
        trimmed: this.messages.length !== trimmedMessages.length,
      })

      // 发送请求
      const response = await fetch(`${this.config.apiBase.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(this.config.timeout),
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`OpenAI API error (${response.status}): ${errorText}`)
      }

      const data: OpenAIResponse = await response.json()

      // 记录 token 使用
      if (data.usage) {
        tokenTracker.recordUsage(
          this.id,
          this.config.model,
          data.usage.prompt_tokens,
          data.usage.completion_tokens
        )
      }

      return data
    } catch (error) {
      console.error('[OpenAIProviderSession] API call error:', error)
      this.emit({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  /**
   * 从 API 响应中提取工具调用
   *
   * @param message - API 响应消息
   * @returns 工具调用列表
   */
  private extractToolCalls(message: OpenAIResponse['choices'][0]['message']): ToolCall[] {
    if (!message.tool_calls || message.tool_calls.length === 0) {
      return []
    }

    return message.tool_calls.map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }))
  }

  /**
   * 执行单个工具调用
   *
   * @param toolCall - 工具调用信息
   */
  private async executeToolCall(toolCall: ToolCall): Promise<void> {
    console.log(`[OpenAIProviderSession] Executing tool: ${toolCall.name}`)

    // 发送工具调用开始事件
    this.emit({
      type: 'tool_call_start',
      callId: toolCall.id,
      tool: toolCall.name,
      args: toolCall.arguments,
    })

    try {
      // 通过 ToolCallManager 执行工具
      const result = await this.toolCallManager.executeTool(toolCall.name, toolCall.arguments)

      // 发送工具调用结束事件
      this.emit({
        type: 'tool_call_end',
        callId: toolCall.id,
        tool: toolCall.name,
        result: result.success ? (result.data?.toString() || 'Success') : (result.error || 'Failed'),
        success: result.success,
      })

      // 将工具结果添加到消息历史
      const output = result.success ? (result.data?.toString() || 'Success') : (result.error || 'Failed')
      this.addToolResultMessage(toolCall.id, output, !result.success)
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)

      // 发送工具调用结束事件（失败）
      this.emit({
        type: 'tool_call_end',
        callId: toolCall.id,
        tool: toolCall.name,
        result: errorMessage,
        success: false,
      })

      // 将错误结果添加到消息历史
      this.addToolResultMessage(toolCall.id, errorMessage, true)
    }
  }

  /**
   * 初始化系统消息
   */
  private initializeSystemMessage(): void {
    const systemPrompt = this.promptBuilder.buildBasePrompt()
    this.messages = [
      {
        role: 'system',
        content: systemPrompt,
      },
    ]
  }

  /**
   * 构建完整的系统提示词
   *
   * @param userMessage - 用户消息
   * @returns 完整系统提示词
   */
  private async buildFullSystemPrompt(userMessage: string): Promise<string> {
    return this.promptBuilder.buildFullPrompt(userMessage, this.currentIntent || undefined)
  }

  /**
   * 添加用户消息到历史
   *
   * @param content - 用户消息内容
   */
  private addUserMessage(content: string): void {
    this.messages.push({
      role: 'user',
      content,
    })
  }

  /**
   * 添加工具结果消息到历史
   *
   * @param toolCallId - 工具调用 ID
   * @param result - 工具执行结果
   * @param _isError - 是否为错误结果（未使用）
   */
  private addToolResultMessage(toolCallId: string, result: string, _isError: boolean): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: result,
    })
  }

  /**
   * 裁剪消息历史以适应 token 预算
   *
   * @returns 裁剪后的消息列表
   */
  private trimMessagesToFitBudget(): OpenAIMessage[] {
    // 简单实现：保留最近的消息
    // TODO: 实现更智能的裁剪策略（基于 token 计算）
    const MAX_MESSAGES = 50
    if (this.messages.length <= MAX_MESSAGES) {
      return this.messages
    }

    // 保留系统消息和最近的消息
    const systemMessage = this.messages[0]
    const recentMessages = this.messages.slice(-MAX_MESSAGES + 1)

    return [systemMessage, ...recentMessages]
  }

  /**
   * 中止任务
   */
  protected abortTask(_taskId: string): void {
    // TODO: 实现任务中止逻辑
    console.warn(`[OpenAIProviderSession] abortTask not implemented`)
  }

  /**
   * 释放资源
   */
  protected disposeResources(): void {
    // 清理资源
    this.messages = []
    this.currentIntent = null
    console.log(`[OpenAIProviderSession] Resources disposed`)
  }

  /**
   * 获取会话配置 (只读)
   *
   * @returns 会话配置
   */
  getSessionConfig(): Readonly<OpenAIProviderSessionConfig> {
    return { ...this.config }
  }
}
