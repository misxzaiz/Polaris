/**
 * Claude Code Engine
 *
 * 实现 AIEngine 接口，作为 Claude Code CLI 的适配器。
 */

import type {
  AIEngine,
  AISession,
  AISessionConfig,
  EngineCapabilities,
} from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import { ClaudeCodeSession, ClaudeSessionConfig } from './session'

/**
 * Claude Code Engine 配置
 */
export interface ClaudeEngineConfig {
  /** Claude Code CLI 路径 */
  claudePath?: string
  /** 默认工作区目录 */
  defaultWorkspaceDir?: string
}

/**
 * Claude Code Engine 实现
 *
 * 实现 AIEngine 接口，提供 Claude Code CLI 的访问能力。
 */
export class ClaudeCodeEngine implements AIEngine {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly capabilities: EngineCapabilities

  private config: ClaudeEngineConfig
  private sessions = new Map<string, ClaudeCodeSession>()
  private sessionCounter = 0

  constructor(config?: ClaudeEngineConfig) {
    this.config = config || {}

    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat', 'refactor', 'analyze', 'generate'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0, // 无限制
      description: 'Claude Code CLI - Anthropic 官方的 AI 编程助手',
      version: '1.0.0',
    })
  }

  /**
   * 创建新会话
   */
  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()

    const sessionConfig: ClaudeSessionConfig = {
      ...config,
      claudePath: this.config.claudePath,
      workspacePath: config?.workspaceDir || this.config.defaultWorkspaceDir,
    }

    const session = new ClaudeCodeSession(sessionId, sessionConfig)

    // 清理已销毁的会话
    session.onEvent((event) => {
      if (event.type === 'session_end') {
        // 延迟清理，给事件处理留出时间
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
   * 检查 Engine 是否可用
   */
  async isAvailable(): Promise<boolean> {
    // Claude Code Engine 的可用性由后端 Tauri 命令处理
    // 前端只需检查后端是否响应
    return true
  }

  /**
   * 初始化 Engine
   */
  async initialize(): Promise<boolean> {
    return true
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    // 销毁所有活动会话
    this.sessions.forEach((session) => {
      session.dispose()
    })
    this.sessions.clear()
  }

  /**
   * 获取当前活动会话数量
   */
  get activeSessionCount(): number {
    let count = 0
    this.sessions.forEach((session) => {
      if (session.status === 'running') {
        count++
      }
    })
    return count
  }

  /**
   * 获取所有会话
   */
  getSessions(): ClaudeCodeSession[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 生成唯一会话 ID
   */
  private generateSessionId(): string {
    return `claude-${Date.now()}-${++this.sessionCounter}`
  }
}

/**
 * 单例 Engine 实例
 */
let engineInstance: ClaudeCodeEngine | null = null

/**
 * 获取 Claude Code Engine 单例
 */
export function getClaudeEngine(config?: ClaudeEngineConfig): ClaudeCodeEngine {
  if (!engineInstance) {
    engineInstance = new ClaudeCodeEngine(config)
  }
  return engineInstance
}

/**
 * 重置 Engine 单例（主要用于测试）
 */
export function resetClaudeEngine(): void {
  if (engineInstance) {
    engineInstance.cleanup()
    engineInstance = null
  }
}
