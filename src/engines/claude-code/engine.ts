/**
 * Claude Code Engine
 *
 * 实现 AIEngine 接口，作为 Claude Code CLI 的适配器。
 * 继承 TauriCommandEngine 基类，共享会话管理模板。
 */

import type { AISessionConfig, EngineCapabilities } from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import { TauriCommandEngine } from '@/engines/base/tauri-command-engine'
import { ClaudeCodeSession, type ClaudeSessionConfig } from './session'

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
export class ClaudeCodeEngine extends TauriCommandEngine {
  readonly id = 'claude-code'
  readonly name = 'Claude Code'
  readonly capabilities: EngineCapabilities

  protected get sessionIdPrefix(): string {
    return 'claude'
  }

  private config: ClaudeEngineConfig

  constructor(config?: ClaudeEngineConfig) {
    super()
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

  protected sessionFactory(sessionId: string, config?: AISessionConfig): import('@/ai-runtime').AISession {
    const sessionConfig: ClaudeSessionConfig = {
      ...config,
      claudePath: this.config.claudePath,
      workspacePath: config?.workspaceDir || this.config.defaultWorkspaceDir,
    }
    return new ClaudeCodeSession(sessionId, sessionConfig)
  }
}
