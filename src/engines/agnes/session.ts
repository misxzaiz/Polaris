/**
 * Agnes Multi-Modal Session
 *
 * 处理多模态 AI 任务：聊天、图像生成、图像编辑、视频生成、图生视频。
 * 根据 AITaskKind 路由到不同的适配器。
 */

import type { AISession, AISessionStatus, AITask, AIEvent } from '@/ai-runtime'
import { EventEmitter } from '@/ai-runtime'
import type { AgnesConfig, AgnesMessage, AgnesTool, AgnesSessionConfig } from './types'
import { streamChatCompletion, generateImage, generateVideo } from './adapters'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgnesSession')

/**
 * Agnes 多模态会话
 */
export class AgnesMultiModalSession extends EventEmitter implements AISession {
  readonly id: string
  status: AISessionStatus = 'idle'

  private config: AgnesConfig
  private sessionConfig: AgnesSessionConfig
  private messages: AgnesMessage[] = []
  private tools: AgnesTool[] = []
  private abortController: AbortController | null = null

  constructor(id: string, config: AgnesConfig, sessionConfig: AgnesSessionConfig = {}) {
    super()
    this.id = id
    this.config = config
    this.sessionConfig = sessionConfig

    // 初始化系统消息
    if (sessionConfig.systemPrompt) {
      this.messages.push({
        role: 'system',
        content: sessionConfig.systemPrompt,
      })
    }

    // 初始化历史消息
    if (sessionConfig.initialMessages?.length) {
      const nonSystem = sessionConfig.initialMessages.filter(m => m.role !== 'system')
      this.messages.push(...nonSystem)
    }

    // 初始化工具
    if (sessionConfig.tools) {
      this.tools = sessionConfig.tools
    }
  }

  /**
   * 设置可用工具
   */
  setTools(tools: AgnesTool[]): void {
    this.tools = tools
  }

  /**
   * 添加工具调用结果到消息历史
   */
  addToolResult(toolCallId: string, result: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: result,
    })
  }

  /**
   * 执行 AI 任务 — 根据 task.kind 路由到对应适配器
   */
  async *run(task: AITask): AsyncIterable<AIEvent> {
    this.status = 'running'
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const sessionId = this.id

    try {
      switch (task.kind) {
        case 'chat':
        case 'refactor':
        case 'analyze':
        case 'generate':
          yield* this.runChat(task, sessionId, signal)
          break

        case 'image_generate':
          yield* this.runImageGeneration(task, sessionId)
          break

        case 'image_edit':
          yield* this.runImageEdit(task, sessionId)
          break

        case 'video_generate':
          yield* this.runVideoGeneration(task, sessionId, signal)
          break

        case 'image_to_video':
          yield* this.runImageToVideo(task, sessionId, signal)
          break

        default:
          throw new Error(`Unsupported task kind: ${task.kind}`)
      }
    } catch (error: unknown) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.status = 'idle'
        return
      }
      log.error(`Session task error: ${error instanceof Error ? error.message : String(error)}`)
      yield {
        type: 'error',
        sessionId,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    } finally {
      this.status = 'idle'
      this.abortController = null
    }

    // 发送会话结束事件
    yield {
      type: 'session_end',
      sessionId,
      reason: 'completed',
    }
  }

  /**
   * 运行聊天任务
   */
  private async *runChat(
    task: AITask,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    // 添加用户消息
    if (task.input.prompt.startsWith('[')) {
      try {
        const parsed = JSON.parse(task.input.prompt) as AgnesMessage[]
        const userMessages = parsed.filter(m => m.role !== 'system')
        this.messages.push(...userMessages)
      } catch {
        this.messages.push({ role: 'user', content: task.input.prompt })
      }
    } else {
      this.messages.push({ role: 'user', content: task.input.prompt })
    }

    // 流式聊天
    const temperature = (task.input.extra?.temperature as number) ?? this.sessionConfig.temperature
    const maxTokens = (task.input.extra?.maxTokens as number) ?? this.sessionConfig.maxTokens

    yield* streamChatCompletion(
      this.config,
      this.messages,
      sessionId,
      signal,
      this.tools.length > 0 ? this.tools : undefined,
      temperature,
      maxTokens,
    )
  }

  /**
   * 运行文生图任务
   */
  private async *runImageGeneration(
    task: AITask,
    sessionId: string,
  ): AsyncIterable<AIEvent> {
    yield* generateImage(this.config, task.input.prompt, sessionId, task.id, {
      isImageEdit: false,
    })
  }

  /**
   * 运行图生图/图片编辑任务
   */
  private async *runImageEdit(
    task: AITask,
    sessionId: string,
  ): AsyncIterable<AIEvent> {
    const prompt = task.input.prompt
    const referenceUrls = task.input.extra?.referenceImageUrls as string[] | undefined

    if (!referenceUrls?.length) {
      throw new Error('image_edit requires referenceImageUrls in task.input.extra')
    }

    yield* generateImage(this.config, prompt, sessionId, task.id, {
      isImageEdit: true,
      referenceImageUrls: referenceUrls,
    })
  }

  /**
   * 运行文生视频任务
   */
  private async *runVideoGeneration(
    task: AITask,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    const extra = task.input.extra || {}

    yield* generateVideo(
      this.config,
      task.input.prompt,
      sessionId,
      task.id,
      {
        width: extra.width as number | undefined,
        height: extra.height as number | undefined,
        numFrames: extra.numFrames as number | undefined,
        frameRate: extra.frameRate as number | undefined,
        seed: extra.seed as number | undefined,
      },
      signal,
    )
  }

  /**
   * 运行图生视频任务
   */
  private async *runImageToVideo(
    task: AITask,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    const extra = task.input.extra || {}
    const imageUrl = extra.imageUrl as string | undefined
    const imageUrls = extra.imageUrls as string[] | undefined

    if (!imageUrl && !imageUrls?.length) {
      throw new Error('image_to_video requires imageUrl or imageUrls in task.input.extra')
    }

    yield* generateVideo(
      this.config,
      task.input.prompt,
      sessionId,
      task.id,
      {
        imageUrl,
        imageUrls,
        keyframeMode: extra.keyframeMode as boolean | undefined,
        width: extra.width as number | undefined,
        height: extra.height as number | undefined,
        numFrames: extra.numFrames as number | undefined,
        frameRate: extra.frameRate as number | undefined,
        seed: extra.seed as number | undefined,
      },
      signal,
    )
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
   * 获取消息历史（用于多轮对话）
   */
  getMessages(): AgnesMessage[] {
    return [...this.messages]
  }

  /**
   * 获取会话配置
   */
  getSessionConfig(): AgnesSessionConfig {
    return { ...this.sessionConfig }
  }
}
