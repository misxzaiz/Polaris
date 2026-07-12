/**
 * Base Session - 通用会话基类
 *
 * 提供所有 CLI Engine Session 的公共功能：
 * - 事件队列管理 (AsyncIterable 模式)
 * - 基础状态管理
 * - 事件发射器功能
 *
 * 各引擎的 Session 继承此类，只需实现引擎特定的启动/中断逻辑。
 */

import type { AISession, AISessionConfig, AISessionStatus } from '../session'
import type { AITask } from '../task'
import type { AIEvent, AIEventListener } from '../event'
import { EventEmitter } from '../session'

/**
 * 事件队列状态
 */
interface EventQueueState {
  events: AIEvent[]
  isComplete: boolean
  resolve: (() => void) | null
}

/**
 * 创建 AsyncIterable 事件队列的工厂函数
 *
 * 这是一个通用的实现，用于将 EventEmitter 的事件流转换为 AsyncIterable。
 * 所有基于 Tauri/进程通信的 Engine Session 都可以使用此函数。
 */
export function createEventIterable(
  eventEmitter: EventEmitter,
  onCompleteCondition: (event: AIEvent) => boolean
): AsyncIterable<AIEvent> {
  const state: EventQueueState = {
    events: [],
    isComplete: false,
    resolve: null,
  }

  // 监听事件
  const unlisten = eventEmitter.onEvent((event) => {
    state.events.push(event)

    // 检查完成条件
    if (onCompleteCondition(event)) {
      state.isComplete = true
      if (state.resolve) {
        state.resolve()
        state.resolve = null
      }
    }
  })

  return {
    [Symbol.asyncIterator]: async function* () {
      try {
        while (!state.isComplete) {
          if (state.events.length > 0) {
            const event = state.events.shift()
            if (event) yield event
          } else {
            // 等待新事件
            await new Promise<void>((r) => {
              state.resolve = r
              // 设置超时避免死锁
              setTimeout(() => {
                if (!state.isComplete) r()
              }, 100)
            })
          }
        }

        // 返回剩余事件
        while (state.events.length > 0) {
          const event = state.events.shift()
          if (event) yield event
        }
      } finally {
        unlisten()
      }
    },
  }
}

/**
 * 默认的会话完成条件检测器
 *
 * 大多数 CLI Engine 会在以下情况结束会话：
 * - session_end 事件
 * - error 事件
 */
export function createDefaultCompletionChecker(): (event: AIEvent) => boolean {
  return (event: AIEvent) =>
    event.type === 'session_end' || event.type === 'error'
}

/**
 * 基础 Session 配置选项
 */
export interface BaseSessionConfig {
  /** 会话 ID */
  id: string
  /** 会话基础配置 */
  config?: AISessionConfig
}

/**
 * 通用 Session 基类
 *
 * 提供了 Session 的通用实现框架，各引擎只需继承并实现：
 * - `runTask`: 具体的任务执行逻辑
 * - `abortTask`: 具体的中断逻辑
 * - `disposeResources`: 资源释放逻辑
 */
export abstract class BaseSession implements AISession {
  protected eventEmitter = new EventEmitter()
  protected _status: AISessionStatus = 'idle'
  protected isDisposed: boolean = false

  readonly id: string
  protected config: AISessionConfig

  constructor(options: BaseSessionConfig) {
    this.id = options.id
    this.config = options.config || {}
  }

  get status(): AISessionStatus {
    return this._status
  }

  /**
   * 执行任务 - 模板方法
   *
   * 提供了标准的执行流程，子类实现具体的执行逻辑。
   */
  async *run(task: AITask): AsyncIterable<AIEvent> {
    if (this.isDisposed) {
      throw new Error('[BaseSession] Session 已被释放，无法执行任务')
    }

    this._status = 'running'

    try {
      // 发送会话开始事件
      yield { type: 'session_start', sessionId: this.id }

      // 发送用户消息事件
      if (task.input.prompt) {
        yield {
          type: 'user_message',
          sessionId: this.id,
          content: task.input.prompt,
          files: task.input.files,
        }
      }

      // 执行具体任务（由子类实现）
      const eventIterable = await this.executeTask(task)

      // yield 所有事件
      for await (const event of eventIterable) {
        yield event

        // 检查会话结束
        if (event.type === 'session_end' || event.type === 'error') {
          break
        }
      }
    } catch (error) {
      yield {
        type: 'error',
        sessionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      }
    } finally {
      this._status = 'idle'
    }
  }

  /**
   * 中断任务
   */
  abort(taskId?: string): void {
    this.abortTask(taskId)
    this._status = 'idle'
  }

  /**
   * 添加事件监听器
   */
  onEvent(listener: AIEventListener): () => void {
    return this.eventEmitter.onEvent(listener)
  }

  /**
   * 销毁会话
   */
  dispose(): void {
    if (this.isDisposed) {
      return
    }

    this.isDisposed = true
    this._status = 'disposed'

    this.disposeResources()
    this.eventEmitter.removeAllListeners()
  }

  /**
   * 发射事件
   */
  protected emit(event: AIEvent): void {
    this.eventEmitter.emit(event)
  }

  /**
   * 执行具体任务 - 由子类实现
   *
   * @returns 返回事件流的可迭代对象
   */
  protected abstract executeTask(task: AITask): AsyncIterable<AIEvent> | Promise<AsyncIterable<AIEvent>>

  /**
   * 中断任务的具体实现 - 由子类实现
   */
  protected abstract abortTask(taskId?: string): void

  /**
   * 释放资源的具体实现 - 由子类实现
   */
  protected abstract disposeResources(): void

  /**
   * 更新配置
   */
  updateConfig(config: Partial<AISessionConfig>): void {
    this.config = { ...this.config, ...config }
  }

  /**
   * 获取当前配置
  */
  getConfig(): AISessionConfig {
    return { ...this.config }
  }
}
