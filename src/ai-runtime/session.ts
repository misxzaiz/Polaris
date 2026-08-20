/**
 * AI Session - AI 会话抽象
 *
 * 定义了 AI Engine 的会话管理接口。
 * 一个 Session 代表一次完整的 AI 交互会话，可以执行多个任务。
 */

import type { AITask } from './task'
import type { AIEvent, AIEventListener } from './event'

/**
 * AI 会话状态
 */
export type AISessionStatus = 'idle' | 'running' | 'disposed'

/**
 * AI 会话配置
 */
export interface AISessionConfig {
  /** 工作区目录 */
  workspaceDir?: string
  /** 是否启用详细日志 */
  verbose?: boolean
  /** 超时时间（毫秒） */
  timeout?: number
  /** 自定义配置项 */
  options?: Record<string, unknown>
}

/**
 * AI 会话接口
 *
 * 这是 AI Runtime 的核心执行单元抽象。
 * 每个 Engine 必须实现此接口，提供统一的会话管理能力。
 */
export interface AISession {
  /** 会话唯一标识 */
  readonly id: string

  /** 当前会话状态 */
  readonly status: AISessionStatus

  /**
   * 执行任务
   * @param task 要执行的任务
   * @returns 异步可迭代的事件流
   */
  run(task: AITask): AsyncIterable<AIEvent>

  /**
   * 中断正在执行的任务
   * @param taskId 任务 ID，不传则中断当前任务
   */
  abort(taskId?: string): void

  /**
   * 添加事件监听器
   * @param listener 事件监听函数
   * @returns 取消监听的函数
   */
  onEvent(listener: AIEventListener): () => void

  /**
   * 销毁会话，释放资源
   */
  dispose(): void
}

/**
 * 同步会话接口（可选）
 *
 * 一些 Engine 可能需要同步执行任务。
 * 大多数情况下应优先使用异步的 AISession。
 */
export interface AISyncSession {
  /** 会话唯一标识 */
  readonly id: string

  /** 当前会话状态 */
  readonly status: AISessionStatus

  /**
   * 同步执行任务
   * @param task 要执行的任务
   * @returns 执行结果
   */
  run(task: AITask): AIEvent[]

  /**
   * 中断正在执行的任务
   */
  abort(): void

  /**
   * 销毁会话
   */
  dispose(): void
}

/**
 * 会话工厂函数类型
 */
export type AISessionFactory = (config?: AISessionConfig) => AISession

/**
 * 创建会话配置的辅助函数
 */
export function createSessionConfig(
  options?: AISessionConfig
): AISessionConfig {
  return {
    workspaceDir: undefined,
    verbose: false,
    timeout: 300000, // 5 分钟默认超时
    ...options,
  }
}

/**
 * 会话事件基类（可选，用于 Engine 实现）
 *
 * Engine 可以继承此类来快速实现事件监听功能。
 */
export class EventEmitter {
  private listeners: Set<AIEventListener> = new Set()

  onEvent(listener: AIEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: AIEvent): void {
    this.listeners.forEach((listener) => listener(event))
  }

  removeAllListeners(): void {
    this.listeners.clear()
  }

  get listenerCount(): number {
    return this.listeners.size
  }
}
