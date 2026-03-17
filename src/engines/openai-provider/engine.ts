/**
 * OpenAI Provider Engine
 *
 * 通用的 OpenAI 协议兼容引擎，支持：
 * - OpenAI 官方 API
 * - DeepSeek
 * - Ollama (本地)
 * - Azure OpenAI
 * - 其他兼容 API
 *
 * @author Polaris Team
 * @since 2025-03-11
 */

import type {
  AIEngine,
  AISession,
  EngineCapabilities,
} from '../../ai-runtime'
import { createCapabilities, getEngineRegistry } from '../../ai-runtime'
import { OpenAIProviderSession, type OpenAIProviderSessionConfig } from './session'

/**
 * OpenAI Provider Engine 配置
 */
export interface OpenAIProviderEngineConfig {
  /** Provider ID (唯一标识) */
  providerId: string
  /** Provider Name (显示名称) */
  providerName: string
  /** API Key (必填) */
  apiKey: string
  /** API Base URL (必填) */
  apiBase: string
  /** Model Name (必填，任意值) */
  model: string
  /** 温度参数 (0-2，可选) */
  temperature?: number
  /** 最大 Token 数 (可选) */
  maxTokens?: number
  /** 默认工作区路径 (可选) */
  workspaceDir?: string
  /** 请求超时时间 (毫秒，可选) */
  timeout?: number
  /** 是否支持工具调用 (Function Calling，默认 false) */
  supportsTools?: boolean
}

/**
 * OpenAI Provider 引擎默认配置
 */
const DEFAULT_CONFIG = {
  temperature: 0.7,
  maxTokens: 8192,
  timeout: 300000,
  supportsTools: true, // 默认支持工具调用
}

/**
 * OpenAI Provider 引擎（通用）
 *
 * 核心职责：
 * - 管理 OpenAI 兼容 API 连接
 * - 创建和管理会话
 * - 提供引擎级别的配置
 *
 * @example
 * ```typescript
 * const engine = new OpenAIProviderEngine({
 *   providerId: 'openai-official',
 *   providerName: 'OpenAI 官方',
 *   apiKey: 'sk-xxx',
 *   apiBase: 'https://api.openai.com/v1',
 *   model: 'gpt-4o-mini',
 * })
 *
 * const session = engine.createSession()
 * await session.run({ prompt: '帮我写一个 React 计数器' })
 * ```
 */
export class OpenAIProviderEngine implements AIEngine {
  /** 引擎唯一标识 = "provider-{providerId}" */
  readonly id: string

  /** 引擎显示名称 */
  readonly name: string

  /** 引擎能力描述 */
  readonly capabilities: EngineCapabilities

  /** 引擎配置 */
  private config: Required<OpenAIProviderEngineConfig>

  /** 活跃会话映射表 */
  private sessions = new Map<string, OpenAIProviderSession>()

  /** 会话计数器 (用于生成唯一 ID) */
  private sessionCounter = 0

  /**
   * 构造函数
   *
   * @param config - 引擎配置
   * @throws {Error} 如果未提供必填参数
   */
  constructor(config: OpenAIProviderEngineConfig) {
    // 验证必填参数
    if (!config.apiKey) {
      throw new Error(`[OpenAIProviderEngine] API Key is required`)
    }
    if (!config.apiBase) {
      throw new Error(`[OpenAIProviderEngine] API Base URL is required`)
    }
    if (!config.model) {
      throw new Error(`[OpenAIProviderEngine] Model name is required`)
    }

    // 生成引擎 ID
    const providerId = config.providerId || 'custom'
    this.id = `provider-${providerId}`
    this.name = config.providerName || 'OpenAI Provider'

    // 合并默认配置
    this.config = {
      providerId: config.providerId,
      providerName: config.providerName || this.name,
      apiKey: config.apiKey,
      apiBase: config.apiBase,
      model: config.model,
      temperature: config.temperature ?? DEFAULT_CONFIG.temperature,
      maxTokens: config.maxTokens ?? DEFAULT_CONFIG.maxTokens,
      workspaceDir: config.workspaceDir || '',
      timeout: config.timeout ?? DEFAULT_CONFIG.timeout,
      supportsTools: config.supportsTools ?? DEFAULT_CONFIG.supportsTools,
    }

    // 初始化能力描述
    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat', 'codegen', 'analyze', 'refactor', 'debug'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0, // 无限制
      description: `${this.name} (${this.config.model})`,
      version: '1.0.0',
    })

    console.log(`[OpenAIProviderEngine] Engine initialized`, {
      id: this.id,
      name: this.name,
      model: this.config.model,
      apiBase: this.config.apiBase,
    })
  }

  /**
   * 创建新会话
   *
   * @param config - 会话级别的配置（可选，会覆盖引擎级别配置）
   * @returns 新的会话实例
   */
  createSession(config?: Partial<OpenAIProviderEngineConfig>): AISession {
    const sessionId = this.generateSessionId()

    // 合并引擎配置和会话级别的配置（会话配置优先级更高）
    const sessionConfig: OpenAIProviderSessionConfig = {
      providerId: this.config.providerId,
      providerName: this.config.providerName,
      apiKey: this.config.apiKey,
      apiBase: this.config.apiBase,
      model: config?.model || this.config.model,
      temperature: config?.temperature ?? this.config.temperature,
      maxTokens: config?.maxTokens ?? this.config.maxTokens,
      workspaceDir: config?.workspaceDir || this.config.workspaceDir,
      timeout: config?.timeout ?? this.config.timeout,
      supportsTools: config?.supportsTools ?? this.config.supportsTools,
    }

    console.log(`[OpenAIProviderEngine] Creating session ${sessionId}:`, {
      engineWorkspaceDir: this.config.workspaceDir,
      sessionWorkspaceDir: config?.workspaceDir,
      finalWorkspaceDir: sessionConfig.workspaceDir,
    })

    const session = new OpenAIProviderSession(sessionId, sessionConfig)

    // 监听会话销毁事件
    session.onEvent((event) => {
      if (event.type === 'session_end') {
        // 延迟清理，给事件处理留出时间
        setTimeout(() => {
          if (session.status === 'idle') {
            this.sessions.delete(sessionId)
            console.log(`[OpenAIProviderEngine] Session ${sessionId} removed from Map`)
          }
        }, 5000)
      }
    })

    this.sessions.set(sessionId, session)

    console.log(`[OpenAIProviderEngine] Session created: ${sessionId}`, {
      workspaceDir: sessionConfig.workspaceDir,
    })
    return session
  }

  /**
   * 检查引擎是否可用
   *
   * 通过调用 API 的 /models 端点来验证连接
   *
   * @returns 引擎是否可用
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiBase.replace(/\/$/, '')}/models`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.config.apiKey}`,
        },
        signal: AbortSignal.timeout(5000), // 5 秒超时
      })

      const available = response.ok

      if (!available) {
        console.warn(`[${this.name}] API check failed:`, response.status, response.statusText)
      }

      return available
    } catch (error) {
      console.error(`[${this.name}] API check error:`, error)
      return false
    }
  }

  /**
   * 初始化引擎
   *
   * 在首次使用前检查 API 可用性
   *
   * @returns 初始化是否成功
   */
  async initialize(): Promise<boolean> {
    console.log(`[${this.name}] Initializing...`)

    const available = await this.isAvailable()

    if (available) {
      console.log(`[${this.name}] Initialized successfully`)
    } else {
      console.error(`[${this.name}] Initialization failed - API unavailable`)
    }

    return available
  }

  /**
   * 清理引擎资源
   *
   * 销毁所有活跃会话
   */
  cleanup(): void {
    console.log(`[${this.name}] Cleaning up...`)

    this.sessions.forEach((session, sessionId) => {
      console.log(`[${this.name}] Disposing session: ${sessionId}`)
      session.dispose()
    })

    this.sessions.clear()
    console.log(`[${this.name}] Cleanup complete`)
  }

  /**
   * 获取当前活跃会话数量
   *
   * @returns 活跃会话数量
   */
  get activeSessionCount(): number {
    let count = 0
    this.sessions.forEach((session) => {
      if (session.status !== 'disposed') {
        count++
      }
    })
    return count
  }

  /**
   * 获取所有会话
   *
   * @returns 所有会话列表
   */
  getSessions(): OpenAIProviderSession[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 获取引擎配置 (只读)
   *
   * @returns 引擎配置副本
   */
  getConfig(): Readonly<Required<OpenAIProviderEngineConfig>> {
    return { ...this.config }
  }

  /**
   * 更新引擎配置
   *
   * @param updates - 要更新的配置项
   */
  updateConfig(updates: Partial<OpenAIProviderEngineConfig>): void {
    if (updates.apiKey) {
      this.config.apiKey = updates.apiKey
    }
    if (updates.apiBase) {
      this.config.apiBase = updates.apiBase
    }
    if (updates.model) {
      this.config.model = updates.model
    }
    if (updates.temperature !== undefined) {
      this.config.temperature = updates.temperature
    }
    if (updates.maxTokens !== undefined) {
      this.config.maxTokens = updates.maxTokens
    }
    if (updates.workspaceDir !== undefined) {
      this.config.workspaceDir = updates.workspaceDir
    }
    if (updates.timeout !== undefined) {
      this.config.timeout = updates.timeout
    }

    console.log(`[${this.name}] Config updated`, updates)
  }

  /**
   * 生成唯一会话 ID
   *
   * 格式: `provider-{providerId}-{timestamp}-{counter}`
   *
   * @returns 会话 ID
   */
  private generateSessionId(): string {
    return `provider-${this.config.providerId}-${Date.now()}-${++this.sessionCounter}`
  }
}

/**
 * 引擎实例缓存
 *
 * 键: provider ID
 * 值: OpenAIProviderEngine 实例
 */
const engineCache = new Map<string, OpenAIProviderEngine>()

/**
 * 获取或创建 OpenAI Provider Engine
 *
 * @param config - 引擎配置
 * @returns OpenAI Provider Engine 实例
 */
export function getOpenAIProviderEngine(config: OpenAIProviderEngineConfig): OpenAIProviderEngine {
  const providerId = config.providerId || 'custom'

  // 如果缓存中存在，直接返回
  if (engineCache.has(providerId)) {
    return engineCache.get(providerId)!
  }

  // 创建新实例并缓存
  const engine = new OpenAIProviderEngine(config)
  engineCache.set(providerId, engine)

  return engine
}

/**
 * 移除缓存的引擎实例
 *
 * @param providerId - Provider ID
 */
export function removeOpenAIProviderEngine(providerId: string): void {
  const engine = engineCache.get(providerId)
  if (engine) {
    engine.cleanup()
    engineCache.delete(providerId)
    console.log(`[OpenAIProviderEngine] Removed engine: ${providerId}`)
  }
}

/**
 * 清空所有引擎实例
 */
export async function clearOpenAIProviderEngines(): Promise<void> {
  // 从全局注册表中注销所有 provider 引擎
  const registry = getEngineRegistry()
  const allEngines = registry.list()

  // 注销所有 provider 引擎
  for (const engineDesc of allEngines) {
    if (engineDesc.id.startsWith('provider-')) {
      await registry.unregister(engineDesc.id)
      console.log(`[OpenAIProviderEngine] Unregistered engine: ${engineDesc.id}`)
    }
  }

  // 清理本地缓存
  engineCache.forEach((engine) => {
    engine.cleanup()
  })
  engineCache.clear()
  console.log('[OpenAIProviderEngine] Cleared all engines')
}
