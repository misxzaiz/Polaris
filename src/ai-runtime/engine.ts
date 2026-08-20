/**
 * AI Engine - AI 引擎抽象
 *
 * 定义了 AI Engine 的顶层能力接口。
 * 每个 AI 实现都必须实现此接口。
 */

import type { AISession, AISessionConfig } from './session'

/**
 * Engine 能力描述
 */
export interface EngineCapabilities {
  /** 支持的任务类型 */
  supportedTaskKinds: string[]
  /** 是否支持流式输出 */
  supportsStreaming: boolean
  /** 是否支持多会话并发 */
  supportsConcurrentSessions: boolean
  /** 是否支持任务中断 */
  supportsTaskAbort: boolean
  /** 最大并发会话数（0 表示无限制） */
  maxConcurrentSessions: number
  /** Engine 描述信息 */
  description: string
  /** Engine 版本 */
  version: string
}

/**
 * AI Engine 接口
 *
 * 这是 AI Runtime 的顶层抽象。
 * 所有 AI 实现（Claude Code、OpenAI、本地 LLM 等）都必须实现此接口。
 *
 * UI 层只依赖此接口，不关心具体是哪个 AI 实现。
 */
export interface AIEngine {
  /** Engine 唯一标识（如 'claude-code', 'openai'） */
  readonly id: string

  /** Engine 显示名称 */
  readonly name: string

  /** Engine 能力描述 */
  readonly capabilities: EngineCapabilities

  /**
   * 创建新的会话
   * @param config 会话配置
   * @returns 新的会话实例
   */
  createSession(config?: AISessionConfig): AISession

  /**
   * 检查 Engine 是否可用
   * @returns 是否可用
   */
  isAvailable(): Promise<boolean> | boolean

  /**
   * 初始化 Engine（如检查依赖、配置等）
   * @returns 是否初始化成功
   */
  initialize?(): Promise<boolean> | boolean

  /**
   * 清理 Engine 资源
   */
  cleanup?(): Promise<void> | void
}

/**
 * Engine 描述符
 *
 * 用于 Engine 注册和发现。
 */
export interface EngineDescriptor {
  /** Engine ID */
  id: string
  /** Engine 名称 */
  name: string
  /** Engine 描述 */
  description: string
  /** Engine 版本 */
  version: string
  /** Engine 图标 URL（可选） */
  iconUrl?: string
  /** Engine 主页 URL（可选） */
  homepageUrl?: string
}

/**
 * Engine 工厂函数类型
 */
export type AIEngineFactory = () => AIEngine

/**
 * 创建基础能力的辅助函数
 */
export function createCapabilities(
  partial: Partial<EngineCapabilities>
): EngineCapabilities {
  return {
    supportedTaskKinds: ['chat'],
    supportsStreaming: false,
    supportsConcurrentSessions: false,
    supportsTaskAbort: false,
    maxConcurrentSessions: 1,
    description: '',
    version: '1.0.0',
    ...partial,
  }
}
