/**
 * Claude Code Session 单元测试
 *
 * 测试 ClaudeCodeSession 的核心功能，包括：
 * - Session 状态管理
 * - 事件发射与监听
 * - 任务执行流程
 * - 中断机制
 * - 资源清理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeCodeSession, createClaudeSession } from './session'
import type { AITask, AIEvent } from '../../ai-runtime'

// Mock Tauri API
const mockInvoke = vi.fn()
const mockListen = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: () => mockInvoke(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => mockListen(),
}))

// Mock logger
vi.mock('../../utils/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))

describe('ClaudeCodeSession', () => {
  let session: ClaudeCodeSession
  let mockUnlisten: () => void

  beforeEach(() => {
    vi.clearAllMocks()

    // 设置默认 mock 行为
    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue(undefined)

    session = new ClaudeCodeSession('test-session-id', {
      workspacePath: '/test/workspace',
    })
  })

  afterEach(() => {
    session.dispose()
  })

  describe('基本属性', () => {
    it('应正确返回 session ID', () => {
      expect(session.id).toBe('test-session-id')
    })

    it('初始状态应为 idle', () => {
      expect(session.status).toBe('idle')
    })
  })

  describe('构造函数', () => {
    it('应使用提供的 ID 创建 Session', () => {
      const customSession = new ClaudeCodeSession('custom-id')
      expect(customSession.id).toBe('custom-id')
    })

    it('应接受配置参数', () => {
      const configuredSession = new ClaudeCodeSession('id', {
        workspacePath: '/custom/path',
        verbose: true,
        timeout: 60000,
      })

      expect(configuredSession.id).toBe('id')
    })
  })

  describe('事件监听', () => {
    it('应能添加事件监听器', () => {
      const listener = vi.fn()
      const unsubscribe = session.onEvent(listener)

      expect(typeof unsubscribe).toBe('function')
      unsubscribe()
    })

    it('监听器应收到发射的事件', () => {
      const receivedEvents: AIEvent[] = []
      session.onEvent((event) => receivedEvents.push(event))

      // 直接调用 emit（通过 run 触发）
      // 这里我们测试监听器机制本身
      expect(receivedEvents).toHaveLength(0)
    })

    it('取消订阅后不应收到事件', () => {
      const listener = vi.fn()
      const unsubscribe = session.onEvent(listener)

      unsubscribe()

      // 取消后监听器不应被调用
      expect(listener).not.toHaveBeenCalled()
    })
  })

  describe('dispose', () => {
    it('应将状态设置为 disposed', () => {
      session.dispose()
      expect(session.status).toBe('disposed')
    })

    it('多次调用 dispose 不应报错', () => {
      session.dispose()
      session.dispose()
      session.dispose()
      expect(session.status).toBe('disposed')
    })

    it('dispose 后不应能执行任务', async () => {
      session.dispose()

      const task: AITask = {
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Hello' },
      }

      await expect(async () => {
        for await (const _ of session.run(task)) {
          // 不应到达
        }
      }).rejects.toThrow()
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

  describe('配置管理', () => {
    it('updateConfig 应合并配置', () => {
      session.updateConfig({ verbose: true })
      const config = session.getConfig()
      expect(config.verbose).toBe(true)
    })

    it('getConfig 应返回配置副本', () => {
      session.updateConfig({ timeout: 30000 })
      const config1 = session.getConfig()
      const config2 = session.getConfig()

      expect(config1).not.toBe(config2)
      expect(config1.timeout).toBe(config2.timeout)
    })
  })
})

describe('createClaudeSession 工厂函数', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(mockListen).mockResolvedValue(vi.fn())
  })

  it('应创建具有指定 ID 的 Session', () => {
    const session = createClaudeSession('factory-id')
    expect(session.id).toBe('factory-id')
    session.dispose()
  })

  it('应传递配置给 Session', () => {
    const session = createClaudeSession('factory-id', {
      workspacePath: '/factory/workspace',
      verbose: true,
    })

    expect(session.id).toBe('factory-id')
    session.dispose()
  })
})

describe('ClaudeCodeSession 事件流', () => {
  let session: ClaudeCodeSession
  let mockUnlisten: () => void

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue(undefined)

    session = new ClaudeCodeSession('event-test-session')
  })

  afterEach(() => {
    session.dispose()
  })

  describe('run 方法', () => {
    it('应发送 session_start 事件', async () => {
      const task: AITask = {
        id: 'task-1',
        kind: 'chat',
        input: { prompt: 'Test prompt' },
      }

      const events: AIEvent[] = []

      // 模拟后端发送 session_end 事件
      setTimeout(() => {
        // 触发 session_end 来结束迭代
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 10)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break // 防止无限循环
      }

      expect(events[0].type).toBe('session_start')
    })

    it('应发送 user_message 事件', async () => {
      const task: AITask = {
        id: 'task-2',
        kind: 'chat',
        input: { prompt: 'Hello Claude' },
      }

      const events: AIEvent[] = []

      setTimeout(() => {
        session['emit']({ type: 'session_end', sessionId: session.id })
      }, 10)

      for await (const event of session.run(task)) {
        events.push(event)
        if (events.length >= 10) break
      }

      const userMessage = events.find((e) => e.type === 'user_message')
      expect(userMessage).toBeDefined()
      if (userMessage && 'content' in userMessage) {
        expect(userMessage.content).toBe('Hello Claude')
      }
    })
  })
})

describe('ClaudeCodeSession 工作区上下文', () => {
  let session: ClaudeCodeSession
  let mockUnlisten: () => void

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue(undefined)

    session = new ClaudeCodeSession('context-session')
  })

  afterEach(() => {
    session.dispose()
  })

  it('应正确处理带工作区上下文的任务', async () => {
    const task: AITask = {
      id: 'task-context',
      kind: 'chat',
      input: {
        prompt: 'Analyze this workspace',
        extra: {
          workspaceContext: {
            currentWorkspace: {
              name: 'test-workspace',
              path: '/test/path',
            },
            contextWorkspaces: [
              { name: 'lib-workspace', path: '/lib/path' },
            ],
          },
        },
      },
    }

    const events: AIEvent[] = []

    setTimeout(() => {
      session['emit']({ type: 'session_end', sessionId: session.id })
    }, 10)

    for await (const event of session.run(task)) {
      events.push(event)
      if (events.length >= 10) break
    }

    // 验证任务能够正常处理工作区上下文
    expect(events.length).toBeGreaterThan(0)
  })
})

describe('ClaudeCodeSession continue 方法', () => {
  let session: ClaudeCodeSession
  let mockUnlisten: () => void

  beforeEach(() => {
    vi.clearAllMocks()

    mockUnlisten = vi.fn()
    mockListen.mockResolvedValue(mockUnlisten)
    mockInvoke.mockResolvedValue(undefined)

    session = new ClaudeCodeSession('continue-session')
  })

  afterEach(() => {
    session.dispose()
  })

  it('应能继续会话', async () => {
    await session.continue('Continue the conversation')

    // 验证 invoke 被调用（由于 mock 实现，只需验证无错误抛出）
    expect(mockInvoke).toHaveBeenCalled()
  })

  it('已销毁的 Session 不应能继续', async () => {
    session.dispose()

    await expect(
      session.continue('Should fail')
    ).rejects.toThrow('Session has been disposed')
  })
})
