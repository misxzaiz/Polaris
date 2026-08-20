/**
 * AI Engine Registry - AI 引擎注册表
 *
 * 管理所有可用的 AI Engine，提供统一的注册、获取、列表功能。
 * Registry 不依赖具体引擎实现，只依赖 AIEngine 接口。
 */

import type { AIEngine, EngineDescriptor, EngineCapabilities } from './engine'
import type { AIEvent } from './event'
import { getEventBus } from './event-bus'
import { createLogger } from '@/utils/logger'

const log = createLogger('AIEngineRegistry')

/**
 * Engine 注册信息
 */
export interface EngineRegistration {
  /** Engine 实例 */
  engine: AIEngine
  /** 注册时间 */
  registeredAt: number
  /** 是否已初始化 */
  initialized: boolean
  /** 是否可用 */
  available: boolean
}

/**
 * Engine 注册配置
 */
export interface EngineRegistrationOptions {
  /** 是否自动初始化 */
  autoInitialize?: boolean
  /** 是否设为默认引擎 */
  asDefault?: boolean
}

/**
 * Engine Registry 事件
 */
export type EngineRegistryEvent =
  | { type: 'engine_registered'; engineId: string }
  | { type: 'engine_unregistered'; engineId: string }
  | { type: 'engine_initialized'; engineId: string }
  | { type: 'engine_error'; engineId: string; error: string }
  | { type: 'default_changed'; engineId: string | null }

/**
 * Engine Registry 事件监听器
 */
export type EngineRegistryEventListener = (event: EngineRegistryEvent) => void

/**
 * AI Engine Registry
 *
 * 管理 AI Engine 的注册、获取、初始化和生命周期。
 * 提供统一的接口，UI/Core 通过 Registry 获取 Engine，而非直接 new。
 */
export class AIEngineRegistry {
  private engines = new Map<string, EngineRegistration>()
  private defaultEngineId: string | null = null
  private listeners = new Set<EngineRegistryEventListener>()

  /**
   * 注册 Engine
   * @param engine Engine 实例
   * @param options 注册选项
   */
  register(engine: AIEngine, options: EngineRegistrationOptions = {}): void {
    const engineId = engine.id

    // 检查是否已注册
    if (this.engines.has(engineId)) {
      log.warn(`Engine "${engineId}" already registered`)
      return
    }

    const registration: EngineRegistration = {
      engine,
      registeredAt: Date.now(),
      initialized: false,
      available: false,
    }

    this.engines.set(engineId, registration)

    // 设为默认引擎
    if (options.asDefault || !this.defaultEngineId) {
      this.defaultEngineId = engineId
    }

    // 发出注册事件
    this.emit({ type: 'engine_registered', engineId })

    // 自动初始化
    if (options.autoInitialize) {
      this.initialize(engineId).catch((err) => {
        log.error(`Failed to initialize "${engineId}":`, err)
      })
    }
  }

  /**
   * 注册 Engine 工厂函数（延迟创建）
   * @param engineId Engine ID
   * @param factory 工厂函数
   * @param options 注册选项
   */
  registerFactory(
    engineId: string,
    factory: () => AIEngine,
    options: EngineRegistrationOptions = {}
  ): void {
    // 延迟创建：首次 get 时才调用工厂
    this.engineFactories.set(engineId, { factory, options })

    // 设为默认引擎
    if (options.asDefault || !this.defaultEngineId) {
      this.defaultEngineId = engineId
    }
  }

  private engineFactories = new Map<
    string,
    { factory: () => AIEngine; options: EngineRegistrationOptions }
  >()

  /**
   * 获取 Engine
   * @param engineId Engine ID
   * @returns Engine 实例，不存在返回 undefined
   */
  get(engineId: string): AIEngine | undefined {
    const registration = this.engines.get(engineId)

    if (registration) {
      return registration.engine
    }

    // 尝试从工厂创建
    const factoryInfo = this.engineFactories.get(engineId)
    if (factoryInfo) {
      const engine = factoryInfo.factory()
      this.register(engine, factoryInfo.options)
      this.engineFactories.delete(engineId)
      return engine
    }

    return undefined
  }

  /**
   * 获取或创建 Engine
   * @param engineId Engine ID
   * @param factory 如果不存在，使用此工厂创建
   * @returns Engine 实例
   */
  getOrCreate(engineId: string, factory?: () => AIEngine): AIEngine | undefined {
    let engine = this.get(engineId)

    if (!engine && factory) {
      engine = factory()
      this.register(engine)
    }

    return engine
  }

  /**
   * 获取默认 Engine
   * @returns 默认 Engine 实例
   */
  getDefault(): AIEngine | undefined {
    if (this.defaultEngineId) {
      return this.get(this.defaultEngineId)
    }
    return undefined
  }

  /**
   * 设置默认 Engine
   * @param engineId Engine ID
   */
  setDefault(engineId: string): void {
    if (!this.has(engineId)) {
      throw new Error(`Engine "${engineId}" not registered`)
    }
    this.defaultEngineId = engineId

    this.emit({ type: 'default_changed', engineId })
  }

  /**
   * 获取默认 Engine ID
   */
  getDefaultId(): string | null {
    return this.defaultEngineId
  }

  /**
   * 列出所有已注册的 Engine
   * @returns Engine 描述符列表
   */
  list(): EngineDescriptor[] {
    const descriptors: EngineDescriptor[] = []

    for (const [engineId, registration] of this.engines) {
      descriptors.push({
        id: engineId,
        name: registration.engine.name,
        description: registration.engine.capabilities.description,
        version: registration.engine.capabilities.version,
      })
    }

    // 包含工厂注册的 Engine
    for (const [engineId, { factory }] of this.engineFactories) {
      try {
        const engine = factory()
        descriptors.push({
          id: engineId,
          name: engine.name,
          description: engine.capabilities.description,
          version: engine.capabilities.version,
        })
      } catch {
        // 忽略创建失败的 Engine
      }
    }

    return descriptors
  }

  /**
   * 列出所有可用的 Engine
   * @returns 可用的 Engine 描述符列表
   */
  async listAvailable(): Promise<EngineDescriptor[]> {
    const descriptors: EngineDescriptor[] = []

    for (const [engineId, registration] of this.engines) {
      if (registration.available) {
        descriptors.push({
          id: engineId,
          name: registration.engine.name,
          description: registration.engine.capabilities.description,
          version: registration.engine.capabilities.version,
        })
      }
    }

    return descriptors
  }

  /**
   * 检查 Engine 是否已注册
   * @param engineId Engine ID
   * @returns 是否已注册
   */
  has(engineId: string): boolean {
    return this.engines.has(engineId) || this.engineFactories.has(engineId)
  }

  /**
   * 初始化 Engine
   * @param engineId Engine ID
   */
  async initialize(engineId: string): Promise<boolean> {
    const registration = this.engines.get(engineId)

    if (!registration) {
      throw new Error(`Engine "${engineId}" not registered`)
    }

    const { engine } = registration

    // 如果已经初始化，直接返回
    if (registration.initialized) {
      return true
    }

    try {
      // 检查是否可用
      const available = await engine.isAvailable()

      if (!available) {
        registration.available = false
        this.emit({ type: 'engine_error', engineId, error: 'Engine not available' })
        return false
      }

      // 调用初始化方法
      if (engine.initialize) {
        const initialized = await engine.initialize()
        registration.initialized = initialized
        registration.available = initialized

        if (initialized) {
          this.emit({ type: 'engine_initialized', engineId })
        } else {
          this.emit({ type: 'engine_error', engineId, error: 'Initialization failed' })
        }

        return initialized
      }

      registration.initialized = true
      registration.available = true
      this.emit({ type: 'engine_initialized', engineId })
      return true
    } catch (error) {
      registration.available = false
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.emit({ type: 'engine_error', engineId, error: errorMessage })
      return false
    }
  }

  /**
   * 初始化所有已注册的 Engine
   */
  async initializeAll(): Promise<void> {
    const promises: Promise<boolean>[] = []

    for (const engineId of this.engines.keys()) {
      promises.push(this.initialize(engineId))
    }

    await Promise.all(promises)
  }

  /**
   * 注销 Engine
   * @param engineId Engine ID
   * @returns 是否成功
   */
  async unregister(engineId: string): Promise<boolean> {
    const registration = this.engines.get(engineId)

    if (!registration) {
      return false
    }

    // 清理资源
    if (registration.engine.cleanup) {
      try {
        await registration.engine.cleanup()
      } catch (error) {
        log.error(`Failed to cleanup "${engineId}":`, error instanceof Error ? error : new Error(String(error)))
      }
    }

    this.engines.delete(engineId)

    // 如果是默认引擎，清除默认
    if (this.defaultEngineId === engineId) {
      this.defaultEngineId = this.engines.keys().next().value || null
    }

    this.emit({ type: 'engine_unregistered', engineId })

    return true
  }

  /**
   * 清空所有 Engine
   */
  async clear(): Promise<void> {
    const engineIds = Array.from(this.engines.keys())

    for (const engineId of engineIds) {
      await this.unregister(engineId)
    }

    this.engineFactories.clear()
    this.defaultEngineId = null
  }

  /**
   * 获取 Engine 能力
   * @param engineId Engine ID
   * @returns Engine 能力描述
   */
  getCapabilities(engineId: string): EngineCapabilities | undefined {
    const engine = this.get(engineId)
    return engine?.capabilities
  }

  /**
   * 检查 Engine 是否可用
   * @param engineId Engine ID
   * @returns 是否可用
   */
  async isAvailable(engineId: string): Promise<boolean> {
    const registration = this.engines.get(engineId)

    if (!registration) {
      return false
    }

    // 如果已经检查过且可用，直接返回
    if (registration.available) {
      return true
    }

    // 重新检查
    const available = await registration.engine.isAvailable()
    registration.available = available

    return available
  }

  /**
   * 获取注册的 Engine 数量
   */
  size(): number {
    return this.engines.size + this.engineFactories.size
  }

  /**
   * 添加事件监听器
   * @param listener 监听器函数
   * @returns 取消监听的函数
   */
  addEventListener(listener: EngineRegistryEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * 发出事件
   */
  private emit(event: EngineRegistryEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event)
      } catch (error) {
        log.error('Listener error:', error instanceof Error ? error : new Error(String(error)))
      }
    })

    // 同时通过 EventBus 发送
    const eventBus = getEventBus()
    eventBus.emit({
      type: 'progress',
      sessionId: 'engine-registry',
      message: `EngineRegistry: ${event.type}`,
    } as AIEvent)
  }
}

/**
 * 全局 Engine Registry 单例
 */
let globalRegistry: AIEngineRegistry | null = null

/**
 * 获取全局 Engine Registry 实例
 */
export function getEngineRegistry(): AIEngineRegistry {
  if (!globalRegistry) {
    globalRegistry = new AIEngineRegistry()
  }
  return globalRegistry
}

/**
 * 重置全局 Registry（主要用于测试）
 */
export function resetEngineRegistry(): void {
  if (globalRegistry) {
    globalRegistry.clear()
    globalRegistry = null
  }
}

/**
 * 快捷方法：注册 Engine
 */
export function registerEngine(engine: AIEngine, options?: EngineRegistrationOptions): void {
  return getEngineRegistry().register(engine, options)
}

/**
 * 快捷方法：获取 Engine
 */
export function getEngine(engineId: string): AIEngine | undefined {
  return getEngineRegistry().get(engineId)
}

/**
 * 快捷方法：列出所有 Engine
 */
export function listEngines(): EngineDescriptor[] {
  return getEngineRegistry().list()
}

/**
 * 快捷方法：获取默认 Engine
 */
export function getDefaultEngine(): AIEngine | undefined {
  return getEngineRegistry().getDefault()
}
