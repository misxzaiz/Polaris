/**
 * Agnes Multi-Modal AI Engine
 *
 * 实现 AIEngine 接口，支持：
 * - 对话（Agnes 2.0 Flash，兼容 OpenAI Chat Completions API）
 * - 文生图 / 图生图（Agnes Image 2.1 Flash）
 * - 文生视频 / 图生视频 / 关键帧动画（Agnes Video V2.0）
 * - 漫画/漫剧管线编排（ComicPipelineEngine）
 *
 * 所有 API 通过 https://apihub.agnes-ai.com/v1 访问。
 */

import type { AIEngine, AISession, AISessionConfig, EngineCapabilities } from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import type { AgnesConfig, AgnesTool, AgnesMessage } from './types'
import { AgnesMultiModalSession } from './session'
import { validateAgnesConfig, mergeAgnesConfig, isAgnesConfigComplete } from './config'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgnesEngine')

/**
 * Agnes 多模态引擎
 */
export class AgnesMultiModalEngine implements AIEngine {
  readonly id = 'agnes'
  readonly name = 'Agnes Multi-Modal'
  readonly capabilities: EngineCapabilities

  private config: AgnesConfig
  private sessions = new Map<string, AgnesMultiModalSession>()
  private sessionCounter = 0
  private tools: AgnesTool[] = []

  constructor(config: Partial<AgnesConfig>) {
    // 验证并合并配置
    const validation = validateAgnesConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid Agnes config: ${validation.errors.join(', ')}`)
    }

    this.config = mergeAgnesConfig(config)

    this.capabilities = createCapabilities({
      supportedTaskKinds: [
        'chat',
        'refactor',
        'analyze',
        'generate',
        'image_generate',
        'image_edit',
        'video_generate',
        'image_to_video',
      ],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0, // 无限制
      description: 'Agnes AI 全模态引擎 — 对话 / 生图 / 生视频 / 图片编辑 / 图生视频',
      version: '1.0.0',
    })
  }

  /**
   * 设置可用工具（所有新会话都会使用）
   */
  setTools(tools: AgnesTool[]): void {
    this.tools = tools
  }

  /**
   * 创建新会话
   */
  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()

    const session = new AgnesMultiModalSession(sessionId, this.config, {
      systemPrompt: config?.options?.systemPrompt as string | undefined,
      initialMessages: config?.options?.initialMessages as AgnesMessage[] | undefined,
      tools: this.tools.length > 0 ? this.tools : undefined,
      temperature: config?.options?.temperature as number | undefined,
      maxTokens: config?.options?.maxTokens as number | undefined,
    })

    // 清理已销毁的会话
    session.onEvent((event) => {
      if (event.type === 'session_end') {
        setTimeout(() => {
          if (session.status === 'idle') {
            this.sessions.delete(sessionId)
          }
        }, 5000)
      }
    })

    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * 检查引擎是否可用
   */
  async isAvailable(): Promise<boolean> {
    return isAgnesConfigComplete(this.config)
  }

  /**
   * 初始化引擎
   */
  async initialize(): Promise<boolean> {
    const available = await this.isAvailable()
    if (available) {
      log.info('Agnes engine initialized', {
        chatModel: this.config.chatModel,
        imageModel: this.config.imageModel,
        videoModel: this.config.videoModel,
      })
    } else {
      log.warn('Agnes engine config incomplete')
    }
    return available
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.sessions.forEach((session) => {
      session.dispose()
    })
    this.sessions.clear()
    log.info('Agnes engine cleaned up')
  }

  /**
   * 获取配置
   */
  getConfig(): AgnesConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AgnesConfig>): void {
    const validation = validateAgnesConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid Agnes config: ${validation.errors.join(', ')}`)
    }
    this.config = mergeAgnesConfig({ ...this.config, ...config })
  }

  /**
   * 生成唯一会话 ID
   */
  private generateSessionId(): string {
    return `agnes-${Date.now()}-${++this.sessionCounter}`
  }
}
