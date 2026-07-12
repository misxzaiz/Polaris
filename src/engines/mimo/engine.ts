/**
 * Mimo Code Engine
 *
 * 实现 AIEngine 接口，作为 Mimo (Mimocode) CLI 的适配器。
 * 与 ClaudeCodeEngine / CodexEngine 结构对称。
 */

import type {
  AIEngine,
  AISession,
  AISessionConfig,
  EngineCapabilities,
} from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import { MimoCodeSession, MimoSessionConfig } from './session'

/**
 * Mimo Code Engine 配置
 */
export interface MimoEngineConfig {
  /** 默认工作区目录 */
  defaultWorkspaceDir?: string
}

/**
 * Mimo Code Engine 实现
 */
export class MimoCodeEngine implements AIEngine {
  readonly id = 'mimo'
  readonly name = 'Mimo Code'
  readonly capabilities: EngineCapabilities

  private config: MimoEngineConfig
  private sessions = new Map<string, MimoCodeSession>()
  private sessionCounter = 0

  constructor(config?: MimoEngineConfig) {
    this.config = config || {}

    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat', 'refactor', 'analyze', 'generate'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0,
      description: 'Mimo (Mimocode) CLI - 多提供商 AI 编程助手，支持内置认证',
      version: '1.0.0',
    })
  }

  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()

    const sessionConfig: MimoSessionConfig = {
      ...config,
      workspacePath: config?.workspaceDir || this.config.defaultWorkspaceDir,
    }

    const session = new MimoCodeSession(sessionId, sessionConfig)

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

  async isAvailable(): Promise<boolean> {
    return true
  }

  async initialize(): Promise<boolean> {
    return true
  }

  cleanup(): void {
    this.sessions.forEach((session) => {
      session.dispose()
    })
    this.sessions.clear()
  }

  get activeSessionCount(): number {
    let count = 0
    this.sessions.forEach((session) => {
      if (session.status === 'running') {
        count++
      }
    })
    return count
  }

  getSessions(): MimoCodeSession[] {
    return Array.from(this.sessions.values())
  }

  private generateSessionId(): string {
    return `mimo-${Date.now()}-${++this.sessionCounter}`
  }
}

/**
 * 单例 Engine 实例
 */
let engineInstance: MimoCodeEngine | null = null

/**
 * 获取 Mimo Code Engine 单例
 */
export function getMimoEngine(config?: MimoEngineConfig): MimoCodeEngine {
  if (!engineInstance) {
    engineInstance = new MimoCodeEngine(config)
  }
  return engineInstance
}
