/**
 * Codex Engine
 *
 * 实现 AIEngine 接口，作为 OpenAI Codex CLI 的适配器。
 * 继承 TauriCommandEngine 基类，共享会话管理模板。
 */

import type { AISessionConfig, EngineCapabilities } from '@/ai-runtime'
import { createCapabilities } from '@/ai-runtime'
import { TauriCommandEngine } from '@/engines/base/tauri-command-engine'
import { CodexSession, type CodexSessionConfig } from './session'

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
export class CodexEngine extends TauriCommandEngine {
  readonly id = 'codex'
  readonly name = 'OpenAI Codex'
  readonly capabilities: EngineCapabilities

  protected get sessionIdPrefix(): string {
    return 'codex'
  }

  private config: CodexEngineConfig

  constructor(config?: CodexEngineConfig) {
    super()
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

  protected sessionFactory(sessionId: string, config?: AISessionConfig): import('@/ai-runtime').AISession {
    const sessionConfig: CodexSessionConfig = {
      ...config,
      workspacePath: config?.workspaceDir || this.config.defaultWorkspaceDir,
    }
    return new CodexSession(sessionId, sessionConfig)
  }
}

