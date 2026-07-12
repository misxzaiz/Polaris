/**
 * EventBus 测试
 *
 * 测试事件总线的发布订阅机制、命名空间隔离和单例模式
 *
 * 注意：EventBus 是单例模式，测试之间需要调用 reset() 或 clear() 清理状态
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  EventBus,
  NamespacedEventBus,
  EventChannel,
  getEventBus,
  resetEventBus,
  type AIEvent,
} from './event-bus'
import { createTokenEvent, createErrorEvent } from './event'

// 在每个测试前重置单例
beforeEach(() => {
  resetEventBus()
})

describe('NamespacedEventBus', () => {
  let bus: NamespacedEventBus

  beforeEach(() => {
    bus = new NamespacedEventBus({ debug: false })
  })

  describe('on() and emit()', () => {
    it('should subscribe and receive events', () => {
      const listener = vi.fn()
      bus.on('token', listener)

      bus.emit('token', { type: 'token', value: 'hello' })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ type: 'token', value: 'hello' })
    })

    it('should support multiple listeners for same event type', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      bus.on('token', listener1)
      bus.on('token', listener2)

      bus.emit('token', { type: 'token', value: 'test' })

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('should not call listeners for different event types', () => {
      const tokenListener = vi.fn()
      const errorListener = vi.fn()

      bus.on('token', tokenListener)
      bus.on('error', errorListener)

      bus.emit('token', { type: 'token', value: 'test' })

      expect(tokenListener).toHaveBeenCalledTimes(1)
      expect(errorListener).not.toHaveBeenCalled()
    })

    it('should return unsubscribe function', () => {
      const listener = vi.fn()
      const unsubscribe = bus.on('token', listener)

      bus.emit('token', { type: 'token', value: 'test1' })
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()

      bus.emit('token', { type: 'token', value: 'test2' })
      expect(listener).toHaveBeenCalledTimes(1) // 仍然是 1
    })
  })

  describe('once()', () => {
    it('should only listen once', () => {
      const listener = vi.fn()

      bus.once('token', listener)

      bus.emit('token', { type: 'token', value: 'test1' })
      bus.emit('token', { type: 'token', value: 'test2' })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith({ type: 'token', value: 'test1' })
    })

    it('should return unsubscribe function', () => {
      const listener = vi.fn()
      const unsubscribe = bus.once('token', listener)

      unsubscribe()

      bus.emit('token', { type: 'token', value: 'test' })

      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('off()', () => {
    it('should remove listener by id', () => {
      const listener = vi.fn()
      const unsubscribe = bus.on('token', listener)

      bus.emit('token', { type: 'token', value: 'before' })
      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()

      bus.emit('token', { type: 'token', value: 'after' })
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('should do nothing for non-existent listener id', () => {
      // 不应该抛出错误
      expect(() => bus.off('token', 'non-existent-id')).not.toThrow()
    })
  })

  describe('priority', () => {
    it('should execute listeners by priority order (higher first)', () => {
      const order: string[] = []

      bus.on('token', () => order.push('low'), { priority: 0 })
      bus.on('token', () => order.push('high'), { priority: 10 })
      bus.on('token', () => order.push('medium'), { priority: 5 })

      bus.emit('token', { type: 'token', value: 'test' })

      expect(order).toEqual(['high', 'medium', 'low'])
    })

    it('should use default priority 0', () => {
      const order: string[] = []

      bus.on('token', () => order.push('first'))
      bus.on('token', () => order.push('second'), { priority: 1 })

      bus.emit('token', { type: 'token', value: 'test' })

      expect(order).toEqual(['second', 'first'])
    })
  })

  describe('namespace', () => {
    it('should store namespace in listener options', () => {
      const listener = vi.fn()
      bus.on('token', listener, { namespace: 'test-ns' })

      // 间接验证：通过 offNamespace 移除
      bus.offNamespace('test-ns')

      bus.emit('token', { type: 'token', value: 'test' })
      expect(listener).not.toHaveBeenCalled()
    })

    it('offNamespace should remove all listeners in namespace', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()
      const otherListener = vi.fn()

      bus.on('token', listener1, { namespace: 'ns1' })
      bus.on('error', listener2, { namespace: 'ns1' })
      bus.on('token', otherListener, { namespace: 'ns2' })

      bus.offNamespace('ns1')

      bus.emit('token', { type: 'token', value: 'test' })
      bus.emit('error', { type: 'error', error: 'test' })

      expect(listener1).not.toHaveBeenCalled()
      expect(listener2).not.toHaveBeenCalled()
      expect(otherListener).toHaveBeenCalledTimes(1)
    })

    it('should use default namespace when not specified', () => {
      const listener = vi.fn()
      bus.on('token', listener)

      // offNamespace with non-existent namespace should not affect default
      bus.offNamespace('non-existent')

      bus.emit('token', { type: 'token', value: 'test' })
      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe('listenerCount()', () => {
    it('should return correct count', () => {
      expect(bus.listenerCount('token')).toBe(0)

      bus.on('token', () => {})
      expect(bus.listenerCount('token')).toBe(1)

      bus.on('token', () => {})
      expect(bus.listenerCount('token')).toBe(2)
    })

    it('should return 0 for non-existent event type', () => {
      expect(bus.listenerCount('non-existent')).toBe(0)
    })
  })

  describe('eventTypes()', () => {
    it('should return all registered event types', () => {
      bus.on('token', () => {})
      bus.on('error', () => {})

      const types = bus.eventTypes()
      expect(types).toContain('token')
      expect(types).toContain('error')
      expect(types.length).toBe(2)
    })

    it('should return empty array when no listeners', () => {
      expect(bus.eventTypes()).toEqual([])
    })

    it('should not include removed event types', () => {
      const unsubscribe = bus.on('token', () => {})
      unsubscribe()

      expect(bus.eventTypes()).toEqual([])
    })
  })

  describe('clear()', () => {
    it('should remove all listeners', () => {
      bus.on('token', () => {})
      bus.on('error', () => {})

      bus.clear()

      expect(bus.eventTypes()).toEqual([])
      expect(bus.listenerCount('token')).toBe(0)
      expect(bus.listenerCount('error')).toBe(0)
    })
  })

  describe('error handling', () => {
    it('should not break emit when listener throws error', () => {
      const errorListener = vi.fn(() => {
        throw new Error('Listener error')
      })
      const normalListener = vi.fn()

      bus.on('token', errorListener)
      bus.on('token', normalListener)

      // 不应该抛出错误
      expect(() => bus.emit('token', { type: 'token', value: 'test' })).not.toThrow()

      // 第二个监听器仍然应该被调用
      expect(normalListener).toHaveBeenCalledTimes(1)
    })
  })
})

describe('EventBus (Singleton)', () => {
  const testSessionId = 'test-session'

  describe('getInstance()', () => {
    it('should return same instance', () => {
      const instance1 = EventBus.getInstance()
      const instance2 = EventBus.getInstance()

      expect(instance1).toBe(instance2)
    })

    it('should create new instance after reset', () => {
      const instance1 = EventBus.getInstance()
      EventBus.reset()
      const instance2 = EventBus.getInstance()

      expect(instance1).not.toBe(instance2)
    })
  })

  describe('on() and emit()', () => {
    it('should subscribe to specific event type', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.on('token', listener)
      bus.emit(createTokenEvent(testSessionId, 'hello'))

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(createTokenEvent(testSessionId, 'hello'))
    })

    it('should support wildcard listener via onAny', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.onAny(listener)
      bus.emit(createTokenEvent(testSessionId, 'test'))
      bus.emit(createErrorEvent(testSessionId, 'error'))

      expect(listener).toHaveBeenCalledTimes(2)
    })
  })

  describe('once()', () => {
    it('should only listen once', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.once('token', listener)
      bus.emit(createTokenEvent(testSessionId, 'test1'))
      bus.emit(createTokenEvent(testSessionId, 'test2'))

      expect(listener).toHaveBeenCalledTimes(1)
    })
  })

  describe('history', () => {
    it('should store emitted events in history', () => {
      const bus = EventBus.getInstance()

      bus.emit(createTokenEvent(testSessionId, 'test1'))
      bus.emit(createErrorEvent(testSessionId, 'error1'))

      const history = bus.getHistory()
      expect(history.length).toBe(2)
      expect(history[0]).toEqual(createTokenEvent(testSessionId, 'test1'))
      expect(history[1]).toEqual(createErrorEvent(testSessionId, 'error1'))
    })

    it('should filter history', () => {
      const bus = EventBus.getInstance()

      bus.emit(createTokenEvent(testSessionId, 'test1'))
      bus.emit(createErrorEvent(testSessionId, 'error1'))
      bus.emit(createTokenEvent(testSessionId, 'test2'))

      const tokenHistory = bus.getHistory((e) => e.type === 'token')
      expect(tokenHistory.length).toBe(2)
    })

    it('should get history by type', () => {
      const bus = EventBus.getInstance()

      bus.emit(createTokenEvent(testSessionId, 'test1'))
      bus.emit(createErrorEvent(testSessionId, 'error1'))
      bus.emit(createTokenEvent(testSessionId, 'test2'))

      const tokenHistory = bus.getHistoryByType('token')
      expect(tokenHistory.length).toBe(2)
      const errorHistory = bus.getHistoryByType('error')
      expect(errorHistory.length).toBe(1)
    })

    it('should limit history size', () => {
      const bus = EventBus.getInstance({ maxHistory: 3 })

      for (let i = 0; i < 5; i++) {
        bus.emit(createTokenEvent('session-id', `test${i}`))
      }

      const history = bus.getHistory()
      expect(history.length).toBe(3)
      // 应该保留最新的 3 个
      expect(history[0].value).toBe('test2')
      expect(history[1].value).toBe('test3')
      expect(history[2].value).toBe('test4')
    })

    it('clearHistory should clear history only', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.on('token', listener)
      bus.emit(createTokenEvent(testSessionId, 'test'))
      bus.clearHistory()

      expect(bus.getHistory().length).toBe(0)
      // 监听器仍然存在
      bus.emit(createTokenEvent(testSessionId, 'test2'))
      expect(listener).toHaveBeenCalledTimes(2)
    })
  })

  describe('emitBatch()', () => {
    it('should emit multiple events', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.on('token', listener)
      bus.emitBatch([createTokenEvent(testSessionId, 'test1'), createTokenEvent(testSessionId, 'test2')])

      expect(listener).toHaveBeenCalledTimes(2)
    })
  })

  describe('clear()', () => {
    it('should clear both listeners and history', () => {
      const bus = EventBus.getInstance()
      const listener = vi.fn()

      bus.on('token', listener)
      bus.emit(createTokenEvent(testSessionId, 'test'))
      bus.clear()

      expect(bus.getHistory().length).toBe(0)
      expect(bus.listenerCount('token')).toBe(0)
    })
  })

  describe('createChannel()', () => {
    it('should create channel with namespace', () => {
      const bus = EventBus.getInstance()
      const channel = bus.createChannel('my-channel')

      expect(channel.getNamespace()).toBe('my-channel')
    })

    it('channel.clear should clear namespace listeners', () => {
      const bus = EventBus.getInstance()
      const channel = bus.createChannel('my-channel')
      const listener = vi.fn()

      channel.on('token', listener)
      bus.emit(createTokenEvent(testSessionId, 'test'))

      expect(listener).toHaveBeenCalledTimes(1)

      channel.clear()
      bus.emit(createTokenEvent(testSessionId, 'test2'))

      expect(listener).toHaveBeenCalledTimes(1)
    })
  })
})

describe('EventChannel', () => {
  const testSessionId = 'test-session'
  let bus: EventBus
  let channel: EventChannel

  beforeEach(() => {
    bus = EventBus.getInstance()
    channel = bus.createChannel('test-ns')
  })

  it('should subscribe with namespace', () => {
    const listener = vi.fn()
    channel.on('token', listener)

    bus.emit(createTokenEvent(testSessionId, 'test'))

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('should add namespace to emitted events', () => {
    const listener = vi.fn()
    bus.onAny(listener)

    channel.emit(createTokenEvent(testSessionId, 'test'))

    expect(listener).toHaveBeenCalledTimes(1)
    const event = listener.mock.calls[0][0] as AIEvent & { _namespace: string }
    expect(event._namespace).toBe('test-ns')
  })

  it('getNamespace should return namespace', () => {
    expect(channel.getNamespace()).toBe('test-ns')
  })
})

describe('getEventBus() and resetEventBus()', () => {
  const testSessionId = 'test-session'

  it('getEventBus should return singleton', () => {
    const bus1 = getEventBus()
    const bus2 = getEventBus()

    expect(bus1).toBe(bus2)
  })

  it('resetEventBus should reset singleton', () => {
    const bus1 = getEventBus()
    bus1.emit(createTokenEvent(testSessionId, 'test'))

    resetEventBus()

    const bus2 = getEventBus()
    expect(bus2).not.toBe(bus1)
    expect(bus2.getHistory().length).toBe(0)
  })

  it('should accept config on first call', () => {
    resetEventBus()
    const bus = getEventBus({ maxHistory: 5, debug: true })

    for (let i = 0; i < 10; i++) {
      bus.emit(createTokenEvent(testSessionId, `test${i}`))
    }

    expect(bus.getHistory().length).toBe(5)
  })
})
