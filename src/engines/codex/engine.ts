/**
 * Codex Engine
 *
 * 实现 AIEngine 接口，作为 OpenAI Codex CLI 的适配器。
 * 与 ClaudeCodeEngine 结构对称。
 */

import type {
  AIEngine,
  AISession,
  AISessionConfig,
  EngineCapabilities,
} from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import { CodexSession, CodexSessionConfig } from './session'

/**
 * Codex Engine 配置
 */
export interface CodexEngineConfig {
  /** 默认工作区目录 */
  defaultWorkspaceDir?: string
}

/**
 * Codex Engine 实现
 */
export class CodexEngine implements AIEngine {
  readonly id = 'codex'
  readonly name = 'OpenAI Codex'
  readonly capabilities: EngineCapabilities

  private config: CodexEngineConfig
  private sessions = new Map<string, CodexSession>()
  private sessionCounter = 0

  constructor(config?: CodexEngineConfig) {
    this.config = config || {}

    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat', 'refactor', 'analyze', 'generate'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0,
      description: 'OpenAI Codex CLI - 全部操作权限',
      version: '1.0.0',
    })
  }

  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()

    const sessionConfig: CodexSessionConfig = {
      ...config,
      workspacePath: config?.workspaceDir || this.config.defaultWorkspaceDir,
    }

    const session = new CodexSession(sessionId, sessionConfig)

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

  getSessions(): CodexSession[] {
    return Array.from(this.sessions.values())
  }

  private generateSessionId(): string {
    return `codex-${Date.now()}-${++this.sessionCounter}`
  }
}

/**
 * 单例 Engine 实例
 */
let engineInstance: CodexEngine | null = null

/**
 * 获取 Codex Engine 单例
 */
export function getCodexEngine(config?: CodexEngineConfig): CodexEngine {
  if (!engineInstance) {
    engineInstance = new CodexEngine(config)
  }
  return engineInstance
}

/**
 * 重置 Engine 单例（主要用于测试）
 */
export function resetCodexEngine(): void {
  if (engineInstance) {
    engineInstance.cleanup()
    engineInstance = null
  }
}
