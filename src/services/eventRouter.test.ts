/**
 * EventRouter 单元测试
 *
 * 测试事件路由器的核心功能：
 * - 单例模式
 * - 事件注册与分发
 * - StrictMode 兼容性
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 取消其他测试文件可能设置的 mock，确保使用真实模块
vi.unmock('./eventRouter')

import { EventRouter, getEventRouter, ensureEventRouterInitialized, createContextId, resetEventRouter } from './eventRouter'

// Mock Tauri event API
const mockUnlisten = vi.fn()
const mockListen = vi.fn(() => Promise.resolve(mockUnlisten))

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: any[]) => mockListen(...args),
}))

// 全局 afterEach 确保模块级单例被重置
afterEach(() => {
  resetEventRouter()
})

describe('EventRouter', () => {
  let router: EventRouter

  beforeEach(() => {
    vi.clearAllMocks()
    router = new EventRouter()
  })

  afterEach(() => {
    router.destroy()
  })

  // ============================================================
  // 初始化测试
  // ============================================================
  describe('initialize', () => {
    it('应成功初始化并注册 chat-event 监听器', async () => {
      await router.initialize()

      expect(mockListen).toHaveBeenCalledWith('chat-event', expect.any(Function))
      expect(router.isInitialized()).toBe(true)
    })

    it('并发调用应只初始化一次', async () => {
      // 并发发起多次初始化
      const results = await Promise.all([
        router.initialize(),
        router.initialize(),
        router.initialize(),
      ])

      // listen 应只被调用一次
      expect(mockListen).toHaveBeenCalledTimes(1)
      expect(router.isInitialized()).toBe(true)
    })

    it('初始化完成后再次调用应直接返回', async () => {
      await router.initialize()
      mockListen.mockClear()

      await router.initialize()

      expect(mockListen).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // register 测试
  // ============================================================
  describe('register', () => {
    it('应成功注册处理器', async () => {
      await router.initialize()
      const handler = vi.fn()

      const unregister = router.register('main', handler)

      expect(typeof unregister).toBe('function')
    })

    it('同一 contextId 重复注册应清除旧处理器', async () => {
      await router.initialize()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      router.register('main', handler1)
      router.register('main', handler2)

      // 触发事件
      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
    })

    it('注销后处理器不应被调用', async () => {
      await router.initialize()
      const handler = vi.fn()

      const unregister = router.register('main', handler)
      unregister()

      // 触发事件
      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

      expect(handler).not.toHaveBeenCalled()
    })

    it('不同 contextId 应独立处理', async () => {
      await router.initialize()
      const handler1 = vi.fn()
      const handler2 = vi.fn()

      router.register('main', handler1)
      router.register('git-commit', handler2)

      // 触发 main 事件
      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

      expect(handler1).toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })
  })

  // ============================================================
  // 事件分发测试
  // ============================================================
  describe('dispatch', () => {
    it('应正确解析 JSON payload', async () => {
      await router.initialize()
      const handler = vi.fn()
      router.register('main', handler)

      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'token', text: 'hello' } }) })

      expect(handler).toHaveBeenCalledWith({ type: 'token', text: 'hello' })
    })

    it('应处理对象类型 payload', async () => {
      await router.initialize()
      const handler = vi.fn()
      router.register('main', handler)

      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: { contextId: 'main', payload: { type: 'token' } } })

      expect(handler).toHaveBeenCalled()
    })

    it('无 contextId 应默认路由到 main', async () => {
      await router.initialize()
      const handler = vi.fn()
      router.register('main', handler)

      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: { type: 'token' } })

      expect(handler).toHaveBeenCalled()
    })

    it('处理器抛错不应影响其他处理器', async () => {
      await router.initialize()
      const errorHandler = vi.fn(() => { throw new Error('Handler error') })
      const normalHandler = vi.fn()

      router.register('main', errorHandler)
      // 由于单例模式，后注册的会覆盖前面的
      // 所以这里测试通配符处理器
      router.register('*' as any, normalHandler)

      const eventCallback = mockListen.mock.calls[0][1]
      // 使用 console.error mock 来避免日志污染
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      eventCallback({ payload: { contextId: 'main', payload: { type: 'test' } } })

      expect(normalHandler).toHaveBeenCalled()
      consoleErrorSpy.mockRestore()
    })
  })

  // ============================================================
  // destroy 测试
  // ============================================================
  describe('destroy', () => {
    it('应取消监听器', async () => {
      await router.initialize()

      router.destroy()

      expect(mockUnlisten).toHaveBeenCalled()
      expect(router.isInitialized()).toBe(false)
    })

    it('销毁后应可重新初始化', async () => {
      await router.initialize()
      router.destroy()
      mockListen.mockClear()

      await router.initialize()

      expect(mockListen).toHaveBeenCalled()
    })

    it('应清除所有处理器', async () => {
      await router.initialize()
      const handler = vi.fn()
      router.register('main', handler)

      router.destroy()

      // 重新初始化
      await router.initialize()
      // 触发事件
      const eventCallback = mockListen.mock.calls[0][1]
      eventCallback({ payload: { contextId: 'main', payload: { type: 'test' } } })

      // 旧的 handler 不应被调用
      expect(handler).not.toHaveBeenCalled()
    })
  })
})

// ============================================================
// 单例函数测试
// ============================================================

describe('getEventRouter', () => {
  beforeEach(() => {
    // 重置单例确保测试隔离
    resetEventRouter()
  })

  it('应返回单例实例', () => {
    // 由于模块级单例，需要通过模块导入测试
    const router1 = getEventRouter()
    const router2 = getEventRouter()

    expect(router1).toBe(router2)
  })
})

describe('ensureEventRouterInitialized', () => {
  it('应返回已初始化的路由器', async () => {
    const router = await ensureEventRouterInitialized()

    expect(router.isInitialized()).toBe(true)
  })
})

describe('createContextId', () => {
  it('应创建唯一 ID', () => {
    const id1 = createContextId()
    const id2 = createContextId()

    expect(id1).not.toBe(id2)
  })

  it('应包含前缀', () => {
    const id = createContextId('custom')

    expect(id.startsWith('custom-')).toBe(true)
  })

  it('默认前缀应为 ctx', () => {
    const id = createContextId()

    expect(id.startsWith('ctx-')).toBe(true)
  })
})

// ============================================================
// StrictMode 兼容性测试
// ============================================================
describe('StrictMode 兼容性', () => {
  let router: EventRouter

  beforeEach(() => {
    vi.clearAllMocks()
    router = new EventRouter()
  })

  afterEach(() => {
    router.destroy()
  })

  it('应正确处理 StrictMode 双重挂载场景', async () => {
    await router.initialize()

    // 模拟 StrictMode: 第一次挂载
    const handler1 = vi.fn()
    const cleanup1 = router.register('main', handler1)

    // StrictMode: 卸载
    cleanup1()

    // StrictMode: 第二次挂载
    const handler2 = vi.fn()
    const cleanup2 = router.register('main', handler2)

    // 触发事件
    const eventCallback = mockListen.mock.calls[0][1]
    eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

    // 只有第二个 handler 应该被调用
    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()

    cleanup2()
  })

  it('应处理无卸载的双挂载场景（注册覆盖）', async () => {
    await router.initialize()

    // 模拟某些 StrictMode 边缘情况：连续两次注册同一 contextId
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    router.register('main', handler1)
    router.register('main', handler2)

    // 触发事件
    const eventCallback = mockListen.mock.calls[0][1]
    eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

    // handler1 应该被清除，只有 handler2 被调用
    expect(handler1).not.toHaveBeenCalled()
    expect(handler2).toHaveBeenCalled()
  })

  it('cleanup 函数应幂等 - 多次调用不应出错', async () => {
    await router.initialize()
    const handler = vi.fn()

    const cleanup = router.register('main', handler)

    // 多次调用 cleanup 不应抛出错误
    expect(() => {
      cleanup()
      cleanup()
      cleanup()
    }).not.toThrow()

    // 触发事件，handler 不应被调用
    const eventCallback = mockListen.mock.calls[0][1]
    eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

    expect(handler).not.toHaveBeenCalled()
  })
})

// ============================================================
// 并发安全测试
// ============================================================
describe('并发安全', () => {
  let router: EventRouter

  beforeEach(() => {
    vi.clearAllMocks()
    router = new EventRouter()
  })

  afterEach(() => {
    router.destroy()
  })

  it('并发初始化应只创建一个监听器', async () => {
    // 并发调用 initialize
    const [result1, result2, result3] = await Promise.all([
      router.initialize(),
      router.initialize(),
      router.initialize(),
    ])

    // 所有结果应该是 undefined (void)
    expect(result1).toBeUndefined()
    expect(result2).toBeUndefined()
    expect(result3).toBeUndefined()

    // 只应该调用一次 listen
    expect(mockListen).toHaveBeenCalledTimes(1)
  })

  it('初始化过程中注册应正常工作', async () => {
    const handler = vi.fn()

    // 同时初始化和注册
    const initPromise = router.initialize()
    router.register('main', handler)

    await initPromise

    // 触发事件
    const eventCallback = mockListen.mock.calls[0][1]
    eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

    expect(handler).toHaveBeenCalled()
  })
})

// ============================================================
// 事件路由边界情况测试
// ============================================================
describe('事件路由边界情况', () => {
  let router: EventRouter

  beforeEach(() => {
    vi.clearAllMocks()
    router = new EventRouter()
  })

  afterEach(() => {
    router.destroy()
  })

  it('应处理无效 JSON payload', async () => {
    await router.initialize()
    const handler = vi.fn()
    router.register('main', handler)

    const eventCallback = mockListen.mock.calls[0][1]
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    // 发送无效 JSON
    eventCallback({ payload: 'invalid-json{' })

    // 不应崩溃，handler 可能被调用（因为 fallback 到 raw data）
    // 这里主要测试不抛出异常
    expect(() => eventCallback({ payload: 'invalid-json{' })).not.toThrow()

    consoleErrorSpy.mockRestore()
  })

  it('应处理空 payload', async () => {
    await router.initialize()
    const handler = vi.fn()
    router.register('main', handler)

    const eventCallback = mockListen.mock.calls[0][1]

    // 空对象
    eventCallback({ payload: {} })

    // 应该路由到 main（默认）
    expect(handler).toHaveBeenCalled()
  })

  it('应处理嵌套的 payload', async () => {
    await router.initialize()
    const handler = vi.fn()
    router.register('main', handler)

    const eventCallback = mockListen.mock.calls[0][1]
    const nestedPayload = {
      contextId: 'main',
      payload: {
        type: 'result',
        data: { nested: { deep: 'value' } }
      }
    }

    eventCallback({ payload: JSON.stringify(nestedPayload) })

    expect(handler).toHaveBeenCalledWith({
      type: 'result',
      data: { nested: { deep: 'value' } }
    })
  })

  it('应正确处理字符串 payload（非 JSON）', async () => {
    await router.initialize()
    const handler = vi.fn()
    router.register('main', handler)

    const eventCallback = mockListen.mock.calls[0][1]

    // 发送纯字符串
    eventCallback({ payload: 'plain text response' })

    // 应该路由到 main，payload 为原始字符串
    expect(handler).toHaveBeenCalledWith('plain text response')
  })

  it('通配符处理器应接收完整事件', async () => {
    await router.initialize()
    const mainHandler = vi.fn()
    const wildcardHandler = vi.fn()

    router.register('main', mainHandler)
    router.register('*' as any, wildcardHandler)

    const eventCallback = mockListen.mock.calls[0][1]
    eventCallback({ payload: JSON.stringify({ contextId: 'main', payload: { type: 'test' } }) })

    // main handler 接收 payload
    expect(mainHandler).toHaveBeenCalledWith({ type: 'test' })
    // wildcard handler 接收完整事件
    expect(wildcardHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        contextId: 'main',
        payload: { type: 'test' }
      })
    )
  })
})
