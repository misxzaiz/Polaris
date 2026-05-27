/**
 * 统一事件总线（EventBus）
 *
 * 提供全局的事件发布订阅机制，支持：
 * - 事件监听器管理
 * - 事件过滤和转换
 * - 命名空间隔离
 * - 事件历史记录
 */

import type { AIEvent } from './event'
import { createLogger } from '@/utils/logger'

const log = createLogger('EventBus')

/**
 * 事件监听器函数类型
 */
export type EventListener<T = AIEvent> = (event: T) => void

/**
 * 事件过滤器函数类型
 */
export type EventFilter<T = AIEvent> = (event: T) => boolean

/**
 * 事件转换器函数类型
 */
export type EventTransformer<T = AIEvent, R = AIEvent> = (event: T) => R | null

/**
 * 事件监听器配置
 */
export interface ListenerOptions {
  /** 是否只监听一次 */
  once?: boolean
  /** 监听器优先级（越大越先执行） */
  priority?: number
  /** 命名空间（用于分组管理） */
  namespace?: string
}

/**
 * 事件监听器包装器
 */
interface ListenerWrapper<T = AIEvent> {
  id: string
  listener: EventListener<T>
  options: Required<ListenerOptions>
  registeredAt: number
}

/**
 * 事件总线配置
 */
export interface EventBusConfig {
  /** 最大历史记录数量 */
  maxHistory?: number
  /** 是否启用调试日志 */
  debug?: boolean
}

/**
 * 命名空间事件总线
 *
 * 支持按命名空间隔离的事件订阅/发布。
 */
export class NamespacedEventBus {
  private listeners = new Map<string, ListenerWrapper[]>()
  private config: Required<EventBusConfig>

  constructor(config: EventBusConfig = {}) {
    this.config = {
      maxHistory: config.maxHistory ?? 20,
      debug: config.debug ?? false,
    }
  }

  /**
   * 订阅事件
   * @param eventType 事件类型（如 'token', 'tool_call_start'）
   * @param listener 监听器函数
   * @param options 监听器配置
   * @returns 取消订阅的函数
   */
  on(eventType: string, listener: EventListener, options: ListenerOptions = {}): () => void {
    const id = `listener-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const wrapper: ListenerWrapper = {
      id,
      listener,
      options: {
        once: options.once ?? false,
        priority: options.priority ?? 0,
        namespace: options.namespace ?? 'default',
      },
      registeredAt: Date.now(),
    }

    // 获取或创建该事件类型的监听器数组
    let typeListeners = this.listeners.get(eventType)
    if (!typeListeners) {
      typeListeners = []
      this.listeners.set(eventType, typeListeners)
    }

    // 按优先级插入
    const insertIndex = typeListeners.findIndex(
      (w) => w.options.priority < wrapper.options.priority
    )
    if (insertIndex === -1) {
      typeListeners.push(wrapper)
    } else {
      typeListeners.splice(insertIndex, 0, wrapper)
    }

    this.log(`[EventBus] Subscribed to "${eventType}" (id: ${id}, namespace: ${wrapper.options.namespace})`)

    // 返回取消订阅函数
    return () => this.off(eventType, id)
  }

  /**
   * 订阅事件（只监听一次）
   */
  once(eventType: string, listener: EventListener, options: ListenerOptions = {}): () => void {
    return this.on(eventType, listener, { ...options, once: true })
  }

  /**
   * 取消订阅
   */
  off(eventType: string, listenerId: string): void {
    const typeListeners = this.listeners.get(eventType)
    if (!typeListeners) return

    const index = typeListeners.findIndex((w) => w.id === listenerId)
    if (index !== -1) {
      typeListeners.splice(index, 1)
      this.log(`[EventBus] Unsubscribed from "${eventType}" (id: ${listenerId})`)
    }

    // 如果没有监听器了，删除该事件类型
    if (typeListeners.length === 0) {
      this.listeners.delete(eventType)
    }
  }

  /**
   * 取消某个命名空间的所有订阅
   */
  offNamespace(namespace: string): void {
    for (const [eventType, typeListeners] of this.listeners.entries()) {
      const toRemove = typeListeners.filter((w) => w.options.namespace === namespace)
      toRemove.forEach((w) => this.off(eventType, w.id))
    }
  }

  /**
   * 发布事件
   */
  emit(eventType: string, data: unknown): void {
    const typeListeners = this.listeners.get(eventType)
    if (!typeListeners || typeListeners.length === 0) {
      this.log(`No listeners`, { eventType })
      return
    }

    this.log(`Emitting`, { eventType, listenerCount: typeListeners.length })

    // 复制数组，避免在遍历过程中修改
    const listeners = [...typeListeners]
    const toRemove: string[] = []

    for (const wrapper of listeners) {
      try {
        wrapper.listener(data as AIEvent)

        // 如果是 once 监听器，标记为需要移除
        if (wrapper.options.once) {
          toRemove.push(wrapper.id)
        }
      } catch (error) {
        log.error(`Listener error`, error as Error, { eventType })
      }
    }

    // 移除 once 监听器
    toRemove.forEach((id) => this.off(eventType, id))
  }

  /**
   * 获取某个事件类型的监听器数量
   */
  listenerCount(eventType: string): number {
    const typeListeners = this.listeners.get(eventType)
    return typeListeners?.length ?? 0
  }

  /**
   * 获取所有事件类型
   */
  eventTypes(): string[] {
    return Array.from(this.listeners.keys())
  }

  /**
   * 清空所有监听器
   */
  clear(): void {
    this.listeners.clear()
    if (this.config.debug) {
      log.debug('Cleared all listeners')
    }
  }

  /**
   * 清空某个命名空间的所有监听器
   */
  clearNamespace(namespace: string): void {
    this.offNamespace(namespace)
  }

  /**
   * 日志输出
   */
  private log(message: string, context?: Record<string, unknown>): void {
    if (this.config.debug) {
      log.debug(message, context)
    }
  }
}

/**
 * 全局事件总线
 *
 * 单例模式，提供全局的事件发布订阅能力。
 */
export class EventBus {
  private static instance: EventBus | null = null
  private bus: NamespacedEventBus
  private history: AIEvent[] = []
  private config: Required<EventBusConfig>

  private constructor(config: EventBusConfig = {}) {
    this.config = {
      maxHistory: config.maxHistory ?? 20,
      debug: config.debug ?? false,
    }
    this.bus = new NamespacedEventBus(config)
  }

  /**
   * 获取全局事件总线实例
   */
  static getInstance(config?: EventBusConfig): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus(config)
    }
    return EventBus.instance
  }

  /**
   * 重置实例（主要用于测试）
   */
  static reset(): void {
    EventBus.instance = null
  }

  /**
   * 订阅 AIEvent（按事件类型）
   */
  on(
    eventType: AIEvent['type'],
    listener: EventListener,
    options?: ListenerOptions
  ): () => void {
    return this.bus.on(eventType, listener, options)
  }

  /**
   * 订阅所有 AIEvent
   */
  onAny(listener: EventListener, options?: ListenerOptions): () => void {
    return this.bus.on('*', listener, options)
  }

  /**
   * 订阅事件（只监听一次）
   */
  once(
    eventType: AIEvent['type'],
    listener: EventListener,
    options?: ListenerOptions
  ): () => void {
    return this.bus.once(eventType, listener, options)
  }

  /**
   * 取消订阅
   */
  off(eventType: AIEvent['type'], listenerId: string): void {
    this.bus.off(eventType, listenerId)
  }

  /**
   * 发布 AIEvent
   */
  emit(event: AIEvent): void {
    // 添加到历史记录
    this.addToHistory(event)

    // 发布到具体事件类型
    this.bus.emit(event.type, event)

    // 发布到通配符
    this.bus.emit('*', event)
  }

  /**
   * 批量发布事件
   */
  emitBatch(events: AIEvent[]): void {
    for (const event of events) {
      this.emit(event)
    }
  }

  /**
   * 添加事件到历史记录
   */
  private addToHistory(event: AIEvent): void {
    this.history.push(event)

    // 限制历史记录数量
    if (this.history.length > this.config.maxHistory) {
      this.history.shift()
    }
  }

  /**
   * 获取历史记录
   */
  getHistory(filter?: (event: AIEvent) => boolean): AIEvent[] {
    if (filter) {
      return this.history.filter(filter)
    }
    return [...this.history]
  }

  /**
   * 按类型获取历史记录
   */
  getHistoryByType(eventType: AIEvent['type']): AIEvent[] {
    return this.history.filter((e) => e.type === eventType)
  }

  /**
   * 清空历史记录
   */
  clearHistory(): void {
    this.history = []
  }

  /**
   * 获取监听器数量
   */
  listenerCount(eventType: AIEvent['type']): number {
    return this.bus.listenerCount(eventType)
  }

  /**
   * 获取所有事件类型
   */
  eventTypes(): string[] {
    return this.bus.eventTypes()
  }

  /**
   * 清空所有监听器
   */
  clear(): void {
    this.bus.clear()
    this.clearHistory()
  }

  /**
   * 清空某个命名空间的所有监听器
   */
  clearNamespace(namespace: string): void {
    this.bus.clearNamespace(namespace)
  }

  /**
   * 创建命名空间隔离的事件通道
   */
  createChannel(namespace: string): EventChannel {
    return new EventChannel(namespace, this)
  }
}

/**
 * 事件通道
 *
 * 提供命名空间隔离的事件订阅/发布能力。
 */
export class EventChannel {
  constructor(
    private namespace: string,
    private eventBus: EventBus
  ) {}

  /**
   * 订阅事件（自动附加命名空间）
   */
  on(
    eventType: AIEvent['type'],
    listener: EventListener,
    options?: Omit<ListenerOptions, 'namespace'>
  ): () => void {
    return this.eventBus.on(eventType, listener, {
      ...options,
      namespace: this.namespace,
    })
  }

  /**
   * 发布事件（通道本身不发布，只是命名空间标记）
   */
  emit(event: AIEvent): void {
    // 添加命名空间标记到事件的 extra 中
    const enhancedEvent = {
      ...event,
      _namespace: this.namespace,
    }
    this.eventBus.emit(enhancedEvent as AIEvent)
  }

  /**
   * 清空该命名空间的所有监听器
   */
  clear(): void {
    this.eventBus.clearNamespace(this.namespace)
  }

  /**
   * 获取命名空间
   */
  getNamespace(): string {
    return this.namespace
  }
}

/**
 * 获取全局事件总线实例
 */
export function getEventBus(config?: EventBusConfig): EventBus {
  return EventBus.getInstance(config)
}

/**
 * 重置全局事件总线
 */
export function resetEventBus(): void {
  EventBus.reset()
}
