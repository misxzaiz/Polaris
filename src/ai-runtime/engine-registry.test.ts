/**
 * AIEngineRegistry 集成测试
 *
 * 测试 Engine 注册表的核心功能，包括：
 * - Engine 注册/注销
 * - 默认 Engine 管理
 * - 初始化流程
 * - 事件监听
 * - 与 CLI Engine 的集成
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  AIEngineRegistry,
  getEngineRegistry,
  resetEngineRegistry,
  registerEngine,
  getEngine,
  listEngines,
  getDefaultEngine,
} from './engine-registry'
import type { AIEngine, EngineCapabilities, AISession } from './engine'
import { createCapabilities } from './engine'

/**
 * 创建测试用 Engine
 */
function createMockEngine(
  id: string,
  name: string,
  options: {
    available?: boolean
    initializeResult?: boolean
    session?: AISession
  } = {}
): AIEngine {
  const { available = true, initializeResult = true, session } = options

  const capabilities: EngineCapabilities = createCapabilities({
    supportedTaskKinds: ['chat'],
    supportsStreaming: true,
    supportsConcurrentSessions: true,
    supportsTaskAbort: true,
    maxConcurrentSessions: 3,
    description: `${name} Description`,
    version: '1.0.0',
  })

  return {
    id,
    name,
    capabilities,
    createSession: vi.fn(() => session || createMockSession()),
    isAvailable: vi.fn(async () => available),
    initialize: vi.fn(async () => initializeResult),
    cleanup: vi.fn(),
  }
}

/**
 * 创建测试用 Session
 */
function createMockSession(): AISession {
  return {
    id: crypto.randomUUID(),
    status: 'idle',
    run: vi.fn(),
    abort: vi.fn(),
    dispose: vi.fn(),
    onEvent: vi.fn(),
    offEvent: vi.fn(),
  }
}

describe('AIEngineRegistry', () => {
  let registry: AIEngineRegistry

  beforeEach(() => {
    registry = new AIEngineRegistry()
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await registry.clear()
  })

  describe('Engine 注册', () => {
    it('应成功注册 Engine', () => {
      const engine = createMockEngine('test-engine', 'Test Engine')

      registry.register(engine)

      expect(registry.has('test-engine')).toBe(true)
      expect(registry.get('test-engine')).toBe(engine)
    })

    it('应阻止重复注册相同 ID 的 Engine', () => {
      const engine1 = createMockEngine('test-engine', 'Test Engine 1')
      const engine2 = createMockEngine('test-engine', 'Test Engine 2')

      registry.register(engine1)
      registry.register(engine2) // 应该被忽略

      const registered = registry.get('test-engine')
      expect(registered?.name).toBe('Test Engine 1')
    })

    it('应正确设置第一个注册的 Engine 为默认', () => {
      const engine = createMockEngine('first-engine', 'First Engine')

      registry.register(engine)

      expect(registry.getDefaultId()).toBe('first-engine')
    })

    it('应支持 asDefault 选项', () => {
      const engine1 = createMockEngine('engine-1', 'Engine 1')
      const engine2 = createMockEngine('engine-2', 'Engine 2')

      registry.register(engine1)
      registry.register(engine2, { asDefault: true })

      expect(registry.getDefaultId()).toBe('engine-2')
    })

    it('应在注册时发出事件', () => {
      const listener = vi.fn()
      registry.addEventListener(listener)

      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      expect(listener).toHaveBeenCalledWith({
        type: 'engine_registered',
        engineId: 'test-engine',
      })
    })
  })

  describe('Engine 注销', () => {
    it('应成功注销已注册的 Engine', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      const result = await registry.unregister('test-engine')

      expect(result).toBe(true)
      expect(registry.has('test-engine')).toBe(false)
    })

    it('应在注销时调用 Engine 的 cleanup 方法', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      await registry.unregister('test-engine')

      expect(engine.cleanup).toHaveBeenCalled()
    })

    it('应在注销时发出事件', async () => {
      const listener = vi.fn()
      registry.register(createMockEngine('test-engine', 'Test Engine'))
      registry.addEventListener(listener)

      await registry.unregister('test-engine')

      expect(listener).toHaveBeenCalledWith({
        type: 'engine_unregistered',
        engineId: 'test-engine',
      })
    })

    it('应在注销默认 Engine 后更新默认值', async () => {
      const engine1 = createMockEngine('engine-1', 'Engine 1')
      const engine2 = createMockEngine('engine-2', 'Engine 2')

      registry.register(engine1)
      registry.register(engine2)

      expect(registry.getDefaultId()).toBe('engine-1')

      await registry.unregister('engine-1')

      // 默认值应切换到剩余的 Engine
      expect(registry.getDefaultId()).toBe('engine-2')
    })
  })

  describe('Engine 初始化', () => {
    it('应成功初始化 Engine', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine', {
        available: true,
        initializeResult: true,
      })
      registry.register(engine)

      const result = await registry.initialize('test-engine')

      expect(result).toBe(true)
      expect(engine.isAvailable).toHaveBeenCalled()
      expect(engine.initialize).toHaveBeenCalled()
    })

    it('应在 Engine 不可用时初始化失败', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine', {
        available: false,
      })
      registry.register(engine)

      const result = await registry.initialize('test-engine')

      expect(result).toBe(false)
    })

    it('应在初始化成功时发出事件', async () => {
      const listener = vi.fn()
      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)
      registry.addEventListener(listener)

      await registry.initialize('test-engine')

      expect(listener).toHaveBeenCalledWith({
        type: 'engine_initialized',
        engineId: 'test-engine',
      })
    })

    it('应在初始化失败时发出错误事件', async () => {
      const listener = vi.fn()
      const engine = createMockEngine('test-engine', 'Test Engine', {
        available: true,
        initializeResult: false,
      })
      registry.register(engine)
      registry.addEventListener(listener)

      await registry.initialize('test-engine')

      expect(listener).toHaveBeenCalledWith({
        type: 'engine_error',
        engineId: 'test-engine',
        error: 'Initialization failed',
      })
    })

    it('应支持自动初始化选项', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine')

      registry.register(engine, { autoInitialize: true })

      // 等待异步初始化
      await new Promise((resolve) => setTimeout(resolve, 100))

      expect(engine.initialize).toHaveBeenCalled()
    })
  })

  describe('Engine 查询', () => {
    it('应正确列出所有已注册的 Engine', () => {
      const engine1 = createMockEngine('engine-1', 'Engine 1')
      const engine2 = createMockEngine('engine-2', 'Engine 2')

      registry.register(engine1)
      registry.register(engine2)

      const list = registry.list()

      expect(list).toHaveLength(2)
      expect(list.map((e) => e.id)).toContain('engine-1')
      expect(list.map((e) => e.id)).toContain('engine-2')
    })

    it('应正确获取 Engine 能力', () => {
      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      const capabilities = registry.getCapabilities('test-engine')

      expect(capabilities).toBeDefined()
      expect(capabilities?.supportsStreaming).toBe(true)
    })

    it('应正确检查 Engine 可用性', async () => {
      const engine = createMockEngine('test-engine', 'Test Engine', {
        available: true,
      })
      registry.register(engine)

      const available = await registry.isAvailable('test-engine')

      expect(available).toBe(true)
    })

    it('应正确返回注册数量', () => {
      expect(registry.size()).toBe(0)

      registry.register(createMockEngine('engine-1', 'Engine 1'))
      expect(registry.size()).toBe(1)

      registry.register(createMockEngine('engine-2', 'Engine 2'))
      expect(registry.size()).toBe(2)
    })
  })

  describe('Engine 工厂注册', () => {
    it('应支持延迟创建 Engine', () => {
      const factory = vi.fn(() => createMockEngine('lazy-engine', 'Lazy Engine'))

      registry.registerFactory('lazy-engine', factory)

      // 工厂不应立即调用
      expect(factory).not.toHaveBeenCalled()

      // 首次 get 时才创建
      const engine = registry.get('lazy-engine')

      expect(factory).toHaveBeenCalled()
      expect(engine?.id).toBe('lazy-engine')
    })

    it('应在 list 中包含工厂注册的 Engine', () => {
      registry.registerFactory('lazy-engine', () => createMockEngine('lazy-engine', 'Lazy Engine'))

      const list = registry.list()

      expect(list.some((e) => e.id === 'lazy-engine')).toBe(true)
    })
  })

  describe('默认 Engine 管理', () => {
    it('应正确设置默认 Engine', () => {
      const engine1 = createMockEngine('engine-1', 'Engine 1')
      const engine2 = createMockEngine('engine-2', 'Engine 2')

      registry.register(engine1)
      registry.register(engine2)

      registry.setDefault('engine-2')

      expect(registry.getDefaultId()).toBe('engine-2')
      expect(registry.getDefault()).toBe(engine2)
    })

    it('应在设置不存在的 Engine 为默认时抛出错误', () => {
      expect(() => registry.setDefault('non-existent')).toThrow(
        'Engine "non-existent" not registered'
      )
    })

    it('应在默认值变更时发出事件', () => {
      const listener = vi.fn()
      registry.register(createMockEngine('engine-1', 'Engine 1'))
      registry.register(createMockEngine('engine-2', 'Engine 2'))
      registry.addEventListener(listener)

      registry.setDefault('engine-2')

      expect(listener).toHaveBeenCalledWith({
        type: 'default_changed',
        engineId: 'engine-2',
      })
    })
  })

  describe('事件监听', () => {
    it('应支持多个事件监听器', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      registry.addEventListener(listener1)
      registry.addEventListener(listener2)

      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      expect(listener1).toHaveBeenCalled()
      expect(listener2).toHaveBeenCalled()
    })

    it('应正确取消事件监听', () => {
      const listener = vi.fn()
      const unsubscribe = registry.addEventListener(listener)

      unsubscribe()

      const engine = createMockEngine('test-engine', 'Test Engine')
      registry.register(engine)

      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('清理', () => {
    it('应正确清空所有 Engine', async () => {
      registry.register(createMockEngine('engine-1', 'Engine 1'))
      registry.register(createMockEngine('engine-2', 'Engine 2'))

      await registry.clear()

      expect(registry.size()).toBe(0)
      expect(registry.getDefaultId()).toBeNull()
    })

    it('应在清空时调用所有 Engine 的 cleanup', async () => {
      const engine1 = createMockEngine('engine-1', 'Engine 1')
      const engine2 = createMockEngine('engine-2', 'Engine 2')

      registry.register(engine1)
      registry.register(engine2)

      await registry.clear()

      expect(engine1.cleanup).toHaveBeenCalled()
      expect(engine2.cleanup).toHaveBeenCalled()
    })
  })
})

describe('全局 Registry 快捷方法', () => {
  beforeEach(() => {
    resetEngineRegistry()
  })

  afterEach(() => {
    resetEngineRegistry()
  })

  it('getEngineRegistry 应返回单例', () => {
    const registry1 = getEngineRegistry()
    const registry2 = getEngineRegistry()

    expect(registry1).toBe(registry2)
  })

  it('registerEngine 应正确注册 Engine', () => {
    const engine = createMockEngine('test-engine', 'Test Engine')

    registerEngine(engine)

    expect(getEngine('test-engine')).toBe(engine)
  })

  it('listEngines 应返回已注册的 Engine 列表', () => {
    registerEngine(createMockEngine('engine-1', 'Engine 1'))
    registerEngine(createMockEngine('engine-2', 'Engine 2'))

    const list = listEngines()

    expect(list).toHaveLength(2)
  })

  it('getDefaultEngine 应返回默认 Engine', () => {
    const engine = createMockEngine('default-engine', 'Default Engine')
    registerEngine(engine, { asDefault: true })

    const defaultEngine = getDefaultEngine()

    expect(defaultEngine).toBe(engine)
  })

  it('resetEngineRegistry 应重置全局 Registry', async () => {
    registerEngine(createMockEngine('test-engine', 'Test Engine'))

    resetEngineRegistry()

    const registry = getEngineRegistry()
    expect(registry.size()).toBe(0)
  })
})

describe('Engine 注册与 Session 创建集成', () => {
  let registry: AIEngineRegistry

  beforeEach(() => {
    registry = new AIEngineRegistry()
  })

  afterEach(async () => {
    await registry.clear()
  })

  it('应能通过 Registry 创建 Session', () => {
    const mockSession = createMockSession()
    const engine = createMockEngine('test-engine', 'Test Engine', {
      session: mockSession,
    })

    registry.register(engine)

    const registeredEngine = registry.get('test-engine')
    const session = registeredEngine?.createSession()

    expect(session).toBe(mockSession)
    expect(engine.createSession).toHaveBeenCalled()
  })

  it('应能通过默认 Engine 创建 Session', () => {
    const mockSession = createMockSession()
    const engine = createMockEngine('default-engine', 'Default Engine', {
      session: mockSession,
    })

    registry.register(engine, { asDefault: true })

    const defaultEngine = registry.getDefault()
    const session = defaultEngine?.createSession()

    expect(session).toBe(mockSession)
  })

  it('初始化后应能创建 Session', async () => {
    const mockSession = createMockSession()
    const engine = createMockEngine('test-engine', 'Test Engine', {
      available: true,
      initializeResult: true,
      session: mockSession,
    })

    registry.register(engine)
    await registry.initialize('test-engine')

    const registeredEngine = registry.get('test-engine')
    const session = registeredEngine?.createSession()

    expect(session).toBeDefined()
  })
})
