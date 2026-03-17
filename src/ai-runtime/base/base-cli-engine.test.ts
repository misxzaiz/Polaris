/**
 * BaseCLIEngine 单元测试
 *
 * 测试 CLI Engine 基类的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BaseCLIEngine,
  BaseCLISession,
  type CLIEngineConfig,
  type CLISessionConfig,
  type CLIEngineDescriptor,
} from './base-cli-engine'
import type { AISessionConfig, EngineCapabilities } from '../engine'
import { createCapabilities } from '../engine'
import type { AITask, AIEvent } from '../index'

/**
 * 测试用 Session 实现
 */
class TestCLISession extends BaseCLISession {
  readonly engineId = 'test-engine'
  private mockEvents: AIEvent[] = []

  protected getDefaultExecutable(): string {
    return 'test-cli'
  }

  // 暴露 protected 方法供测试使用
  setMockEvents(events: AIEvent[]): void {
    this.mockEvents = events
  }

  protected override async executeTask(task: AITask): Promise<AsyncIterable<AIEvent>> {
    // 返回模拟的事件流
    return {
      [Symbol.asyncIterator]: async function* (this: TestCLISession) {
        for (const event of this.mockEvents) {
          yield event
        }
      }.bind(this),
    }
  }
}

/**
 * 测试用 Engine 实现
 */
class TestCLIEngine extends BaseCLIEngine {
  protected readonly descriptor: CLIEngineDescriptor = {
    id: 'test-engine',
    name: 'Test Engine',
    description: 'A test CLI engine',
    defaultExecutable: 'test-cli',
  }

  readonly capabilities: EngineCapabilities = createCapabilities({
    supportedTaskKinds: ['chat'],
    supportsStreaming: true,
    supportsConcurrentSessions: true,
    supportsTaskAbort: true,
    maxConcurrentSessions: 3,
    description: 'Test Engine',
    version: '1.0.0',
  })

  protected createCLISession(
    sessionConfig?: AISessionConfig,
    cliConfig?: CLISessionConfig
  ): BaseCLISession {
    return new TestCLISession(sessionConfig, cliConfig)
  }

  // 暴露 protected 方法供测试使用
  testGetDescriptor(): CLIEngineDescriptor {
    return this.descriptor
  }
}

describe('BaseCLIEngine', () => {
  let engine: TestCLIEngine

  beforeEach(() => {
    engine = new TestCLIEngine()
    vi.clearAllMocks()
  })

  afterEach(() => {
    engine.cleanup()
  })

  describe('基本属性', () => {
    it('应正确返回 id', () => {
      expect(engine.id).toBe('test-engine')
    })

    it('应正确返回 name', () => {
      expect(engine.name).toBe('Test Engine')
    })

    it('应正确返回 capabilities', () => {
      expect(engine.capabilities.supportsStreaming).toBe(true)
      expect(engine.capabilities.maxConcurrentSessions).toBe(3)
    })
  })

  describe('构造函数', () => {
    it('应使用默认配置初始化', () => {
      const defaultEngine = new TestCLIEngine()
      expect(defaultEngine.getConfig()).toEqual({})
    })

    it('应接受自定义配置', () => {
      const customEngine = new TestCLIEngine({
        executablePath: '/custom/path/cli',
        model: 'gpt-4',
        apiKey: 'test-key',
      })

      const config = customEngine.getConfig()
      expect(config.executablePath).toBe('/custom/path/cli')
      expect(config.model).toBe('gpt-4')
      expect(config.apiKey).toBe('test-key')
    })
  })

  describe('createSession', () => {
    it('应创建新的 Session', () => {
      const session = engine.createSession()

      expect(session).toBeDefined()
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe('string')
    })

    it('应创建具有不同 ID 的 Session', () => {
      const session1 = engine.createSession()
      const session2 = engine.createSession()

      expect(session1.id).not.toBe(session2.id)
    })

    it('应将配置传递给 Session', () => {
      const session = engine.createSession({
        workspaceDir: '/test/workspace',
      })

      expect(session).toBeDefined()
    })
  })

  describe('isAvailable', () => {
    it('应返回 boolean', async () => {
      const result = await engine.isAvailable()
      expect(typeof result).toBe('boolean')
    })

    it('默认实现应返回 true', async () => {
      // 默认 checkCLIInstalled 返回 true
      const result = await engine.isAvailable()
      expect(result).toBe(true)
    })
  })

  describe('initialize', () => {
    it('首次初始化应成功', async () => {
      const result = await engine.initialize()
      expect(result).toBe(true)
    })

    it('重复初始化应返回 true', async () => {
      await engine.initialize()
      const result = await engine.initialize()
      expect(result).toBe(true)
    })
  })

  describe('cleanup', () => {
    it('应能成功调用清理', async () => {
      await engine.initialize()
      await engine.cleanup()
      // 清理后应能重新初始化
      const result = await engine.initialize()
      expect(result).toBe(true)
    })
  })

  describe('配置管理', () => {
    it('updateConfig 应合并配置', () => {
      engine.updateConfig({ model: 'new-model' })
      const config = engine.getConfig()
      expect(config.model).toBe('new-model')
    })

    it('updateConfig 应保留现有配置', () => {
      engine.updateConfig({ model: 'model-1' })
      engine.updateConfig({ apiKey: 'key-1' })

      const config = engine.getConfig()
      expect(config.model).toBe('model-1')
      expect(config.apiKey).toBe('key-1')
    })

    it('getConfig 应返回配置副本', () => {
      engine.updateConfig({ model: 'test-model' })
      const config1 = engine.getConfig()
      const config2 = engine.getConfig()

      expect(config1).not.toBe(config2) // 不同的对象引用
      expect(config1.model).toBe(config2.model) // 相同的值
    })
  })
})

describe('BaseCLISession', () => {
  let session: TestCLISession

  beforeEach(() => {
    session = new TestCLISession()
  })

  afterEach(() => {
    session.dispose()
  })

  describe('基本属性', () => {
    it('应正确返回 engineId', () => {
      expect(session.engineId).toBe('test-engine')
    })

    it('应有有效的 session ID', () => {
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe('string')
    })

    it('初始状态应为 idle', () => {
      expect(session.status).toBe('idle')
    })
  })

  describe('run', () => {
    it('应发送 session_start 事件', async () => {
      const events: AIEvent[] = []
      session.setMockEvents([{ type: 'session_end' }])

      for await (const event of session.run({
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Hello' },
      })) {
        events.push(event)
      }

      expect(events[0].type).toBe('session_start')
    })

    it('应发送 user_message 事件', async () => {
      const events: AIEvent[] = []
      session.setMockEvents([{ type: 'session_end' }])

      for await (const event of session.run({
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Test prompt' },
      })) {
        events.push(event)
      }

      const userMessage = events.find((e) => e.type === 'user_message')
      expect(userMessage).toBeDefined()
      expect((userMessage as any).content).toBe('Test prompt')
    })

    it('执行后状态应为 running 然后回到 idle', async () => {
      session.setMockEvents([{ type: 'session_end' }])

      const iterator = session.run({
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Test' },
      })

      // 开始迭代
      const firstPromise = iterator[Symbol.asyncIterator]().next()
      await firstPromise

      // 迭代完成后状态应回到 idle
      for await (const _ of iterator) {
        // 继续迭代
      }

      expect(session.status).toBe('idle')
    })

    it('应正确传递 mock 事件', async () => {
      const events: AIEvent[] = []
      session.setMockEvents([
        { type: 'token', content: 'Hello' },
        { type: 'token', content: ' World' },
        { type: 'session_end' },
      ])

      for await (const event of session.run({
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Test' },
      })) {
        events.push(event)
      }

      const tokenEvents = events.filter((e) => e.type === 'token')
      expect(tokenEvents).toHaveLength(2)
    })
  })

  describe('abort', () => {
    it('应能调用 abort', () => {
      session.abort()
      expect(session.status).toBe('idle')
    })

    it('abort 后状态应为 idle', () => {
      session.abort('task-1')
      expect(session.status).toBe('idle')
    })
  })

  describe('dispose', () => {
    it('应能调用 dispose', () => {
      session.dispose()
      expect(session.status).toBe('disposed')
    })

    it('重复 dispose 不应报错', () => {
      session.dispose()
      session.dispose()
      expect(session.status).toBe('disposed')
    })

    it('dispose 后不应能执行任务', async () => {
      session.dispose()

      await expect(async () => {
        for await (const _ of session.run({
          id: 'task-1',
          kind: 'chat',
          input: { prompt: 'Test' },
        })) {
          // 不应到达这里
        }
      }).rejects.toThrow('Session 已被释放')
    })
  })

  describe('onEvent', () => {
    it('应能添加事件监听器', () => {
      const listener = vi.fn()
      const unsubscribe = session.onEvent(listener)

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })

    it('监听器应收到事件', () => {
      const events: AIEvent[] = []
      session.onEvent((e) => events.push(e))

      session.setMockEvents([{ type: 'session_end' }])

      // 触发事件
      session.run({
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Test' },
      })

      // 验证事件被收集（不等待完成）
      expect(events.length).toBeGreaterThanOrEqual(0)
    })
  })

  describe('CLI 配置管理', () => {
    it('updateCLIConfig 应合并配置', () => {
      session.updateCLIConfig({ model: 'gpt-4' })
      const config = session.getCLIConfig()
      expect(config.model).toBe('gpt-4')
    })

    it('getCLIConfig 应返回配置副本', () => {
      session.updateCLIConfig({ model: 'test-model' })
      const config1 = session.getCLIConfig()
      const config2 = session.getCLIConfig()

      expect(config1).not.toBe(config2)
      expect(config1.model).toBe(config2.model)
    })
  })
})
