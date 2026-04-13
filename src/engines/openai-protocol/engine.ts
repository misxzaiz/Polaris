import type { AIEngine, AISession, AISessionConfig, EngineCapabilities } from '../../ai-runtime'
import { createCapabilities } from '../../ai-runtime'
import type { OpenAIEngineConfig, OpenAITool, OpenAIMessage } from './types'
import { OpenAISession } from './session'
import { validateConfig, mergeWithDefaults, isConfigComplete } from './config'

/**
 * OpenAI 协议引擎
 *
 * 实现 AIEngine 接口，支持 OpenAI 兼容的 API 服务
 */
export class OpenAIProtocolEngine implements AIEngine {
  readonly id = 'openai-protocol'
  readonly name = 'OpenAI Protocol'
  readonly capabilities: EngineCapabilities

  private config: OpenAIEngineConfig
  private sessions = new Map<string, OpenAISession>()
  private sessionCounter = 0
  private tools: OpenAITool[] = []

  constructor(config: Partial<OpenAIEngineConfig>) {
    // 验证并合并配置
    const validation = validateConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid OpenAI config: ${validation.errors.join(', ')}`)
    }

    this.config = mergeWithDefaults(config)

    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0, // 无限制
      description: 'OpenAI Protocol Engine - 支持所有 OpenAI 兼容 API',
      version: '1.0.0',
    })
  }

  /**
   * 设置可用工具
   */
  setTools(tools: OpenAITool[]): void {
    this.tools = tools
  }

  /**
   * 创建新会话
   */
  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()

    const session = new OpenAISession(sessionId, {
      ...this.config,
      systemPrompt: config?.options?.systemPrompt as string | undefined,
      initialMessages: config?.options?.initialMessages as OpenAIMessage[] | undefined,
    })

    // 设置工具
    if (this.tools.length > 0) {
      session.setTools(this.tools)
    }

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
    return isConfigComplete(this.config)
  }

  /**
   * 初始化引擎
   */
  async initialize(): Promise<boolean> {
    return this.isAvailable()
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.sessions.forEach((session) => {
      session.dispose()
    })
    this.sessions.clear()
  }

  /**
   * 获取配置
   */
  getConfig(): OpenAIEngineConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<OpenAIEngineConfig>): void {
    const validation = validateConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid OpenAI config: ${validation.errors.join(', ')}`)
    }
    this.config = mergeWithDefaults({ ...this.config, ...config })
  }

  /**
   * 生成唯一会话 ID
   */
  private generateSessionId(): string {
    return `openai-${Date.now()}-${++this.sessionCounter}`
  }
}
