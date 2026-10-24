/**
 * Claude Code Engine 单元测试
 *
 * 测试 ClaudeCodeEngine 的核心功能，包括：
 * - 引擎基本属性
 * - 会话创建与管理
 * - 资源清理
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ClaudeCodeEngine } from './engine'

// Mock Tauri API
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock Tauri event
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
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

describe('ClaudeCodeEngine', () => {
  let engine: ClaudeCodeEngine

  beforeEach(() => {
    vi.clearAllMocks()
    // 对齐实现：模块级单例已移除，每个用例直接 new 独立实例，天然隔离
    engine = new ClaudeCodeEngine()
  })

  afterEach(() => {
    engine.cleanup()
  })

  describe('基本属性', () => {
    it('应正确返回 id', () => {
      expect(engine.id).toBe('claude-code')
    })

    it('应正确返回 name', () => {
      expect(engine.name).toBe('Claude Code')
    })

    it('应正确返回 capabilities', () => {
      expect(engine.capabilities.supportsStreaming).toBe(true)
      expect(engine.capabilities.supportsConcurrentSessions).toBe(true)
      expect(engine.capabilities.supportsTaskAbort).toBe(true)
      expect(engine.capabilities.maxConcurrentSessions).toBe(0) // 无限制
      expect(engine.capabilities.supportedTaskKinds).toContain('chat')
      expect(engine.capabilities.supportedTaskKinds).toContain('refactor')
      expect(engine.capabilities.supportedTaskKinds).toContain('analyze')
      expect(engine.capabilities.supportedTaskKinds).toContain('generate')
    })
  })

  describe('构造函数', () => {
    it('应使用默认配置初始化', () => {
      const defaultEngine = new ClaudeCodeEngine()
      expect(defaultEngine.id).toBe('claude-code')
    })

    it('应接受自定义配置', () => {
      const customEngine = new ClaudeCodeEngine({
        claudePath: '/custom/path/claude',
        defaultWorkspaceDir: '/custom/workspace',
      })

      expect(customEngine.id).toBe('claude-code')
    })
  })

  describe('createSession', () => {
    it('应创建新的 Session', () => {
      const session = engine.createSession()

      expect(session).toBeDefined()
      expect(session.id).toBeDefined()
      expect(typeof session.id).toBe('string')
      expect(session.id.startsWith('claude-')).toBe(true)
    })

    it('应创建具有不同 ID 的 Session', () => {
      const session1 = engine.createSession()
      const session2 = engine.createSession()

      expect(session1.id).not.toBe(session2.id)
    })

    it('应将配置传递给 Session', () => {
      const session = engine.createSession({
        workspaceDir: '/test/workspace',
        verbose: true,
      })

      expect(session).toBeDefined()
      expect(session.status).toBe('idle')
    })
  })

  describe('isAvailable', () => {
    it('应返回 true（前端总是返回 true，由后端处理实际可用性）', async () => {
      const result = await engine.isAvailable()
      expect(result).toBe(true)
    })
  })

  describe('initialize', () => {
    it('应成功初始化', async () => {
      const result = await engine.initialize()
      expect(result).toBe(true)
    })
  })

  describe('cleanup', () => {
    it('应清理所有会话', () => {
      engine.createSession()
      engine.createSession()
      engine.createSession()

      engine.cleanup()

      // 清理后应能创建新会话
      const newSession = engine.createSession()
      expect(newSession).toBeDefined()
    })

    it('多次调用 cleanup 不应报错', () => {
      engine.cleanup()
      engine.cleanup()
      engine.cleanup()
    })
  })

  describe('activeSessionCount', () => {
    it('初始时应为 0', () => {
      expect(engine.activeSessionCount).toBe(0)
    })

    it('创建会话后应正确计数', () => {
      engine.createSession()
      engine.createSession()
      // 注意：会话状态默认为 idle，所以 activeSessionCount 应为 0
      expect(engine.activeSessionCount).toBe(0)
    })
  })

  describe('getSessions', () => {
    it('应返回所有会话', () => {
      const session1 = engine.createSession()
      const session2 = engine.createSession()

      const sessions = engine.getSessions()

      expect(sessions).toHaveLength(2)
      expect(sessions.map((s) => s.id)).toContain(session1.id)
      expect(sessions.map((s) => s.id)).toContain(session2.id)
    })

    it('清理后应返回空数组', () => {
      engine.createSession()
      engine.cleanup()

      expect(engine.getSessions()).toHaveLength(0)
    })
  })
})

// 「ClaudeCodeEngine 单例」用例已删除：模块级单例 getClaudeEngine/resetClaudeEngine
// 已从实现移除，实例获取与惰性工厂由 engine-bootstrap.ts + EngineRegistry 接管，
// 其行为已在 src/ai-runtime/engine-registry.test.ts 覆盖。

describe('ClaudeCodeEngine Session 集成', () => {
  let engine: ClaudeCodeEngine

  beforeEach(() => {
    vi.clearAllMocks()
    // 对齐实现：模块级单例已移除，每个用例直接 new 独立实例，天然隔离
    engine = new ClaudeCodeEngine()
  })

  afterEach(() => {
    engine.cleanup()
  })

  describe('Session 状态管理', () => {
    it('创建的 Session 初始状态应为 idle', () => {
      const session = engine.createSession()
      expect(session.status).toBe('idle')
    })

    it('Session 应能被销毁', () => {
      const session = engine.createSession()
      session.dispose()

      expect(session.status).toBe('disposed')
    })

    it('Session 应能添加事件监听器', () => {
      const session = engine.createSession()
      const listener = vi.fn()

      const unsubscribe = session.onEvent(listener)
      expect(typeof unsubscribe).toBe('function')

      unsubscribe()
    })
  })
})
