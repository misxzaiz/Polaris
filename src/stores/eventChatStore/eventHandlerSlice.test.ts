/**
 * eventHandlerSlice 单元测试
 *
 * 测试事件处理、消息发送、会话控制等核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'

// Mock Tauri invoke
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

// Mock eventBus
vi.mock('../../ai-runtime', () => ({
  getEventBus: vi.fn(() => ({
    emit: vi.fn(),
  })),
}))

// Mock eventRouter
vi.mock('../../services/eventRouter', () => ({
  getEventRouter: vi.fn(() => ({
    initialize: vi.fn(() => Promise.resolve()),
    register: vi.fn(() => vi.fn()),
  })),
}))

// Mock engine-bootstrap
vi.mock('../../core/engine-bootstrap', () => ({
  getEngine: vi.fn(),
  listEngines: vi.fn(() => []),
}))

// Mock workspaceReference
vi.mock('../../services/workspaceReference', () => ({
  parseWorkspaceReferences: vi.fn((content) => ({ processedMessage: content })),
  buildWorkspaceSystemPrompt: vi.fn(() => 'System prompt'),
  getUserSystemPrompt: vi.fn(() => ''),
}))

// Mock types/errors
vi.mock('../../types/errors', () => ({
  toAppError: vi.fn((e) => ({
    message: String(e),
    getUserMessage: () => 'AI 处理失败，请稍后重试',
  })),
  errorLogger: { log: vi.fn() },
  ErrorSource: { AI: 'ai' },
}))

// Mock utils/logger
vi.mock('../../utils/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// Mock sessionStoreManager
vi.mock('../conversationStore/sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: vi.fn(() => ({
      getActiveSessionId: vi.fn(() => null),
      getSessionMessages: vi.fn(),
      setSessionMessages: vi.fn(),
      updateSessionStatus: vi.fn(),
    })),
  },
}))

// Mock utils
vi.mock('./utils', () => ({
  handleAIEvent: vi.fn(),
}))

// Import after mocking
import { createEventHandlerSlice } from './eventHandlerSlice'
import type { EventChatState } from './types'

// 创建测试用的依赖
function createMockDependencies() {
  return {
    workspaceActions: {
      getCurrentWorkspace: vi.fn(() => ({ path: '/test/workspace' })),
      getWorkspaces: vi.fn(() => []),
      getContextWorkspaces: vi.fn(() => []),
      getCurrentWorkspaceId: vi.fn(() => null),
    },
    configActions: {
      getConfig: vi.fn(() => ({
        defaultEngine: 'claude-code',
      })),
    },
    gitActions: {
      refreshStatusDebounced: vi.fn(),
    },
  }
}

// 创建测试用的 store
function createTestStore(deps = createMockDependencies()) {
  return create<EventChatState>((...args) => ({
    // 最小状态集合用于测试
    messages: [],
    archivedMessages: [],
    currentMessage: null,
    toolBlockMap: new Map(),
    streamingUpdateCounter: 0,
    conversationId: null,
    currentConversationSeed: null,
    isStreaming: false,
    error: null,
    progressMessage: null,
    _eventListenersInitialized: false,
    _eventListenersCleanup: null,
    _dependencies: deps,
    isInitialized: true,
    isLoadingHistory: false,
    isArchiveExpanded: false,
    maxMessages: 500,

    // Mock 方法
    addMessage: vi.fn((msg) => {
      const store = createTestStore(deps)
      store.setState((state: any) => ({ messages: [...state.messages, msg] }))
    }),
    finishMessage: vi.fn(),
    saveToStorage: vi.fn(),
    setConversationId: vi.fn((id) => {
      const store = createTestStore(deps)
      store.setState({ conversationId: id })
    }),

    // 依赖注入方法
    setDependencies: vi.fn(),
    getGitActions: () => deps?.gitActions,
    getConfigActions: () => deps?.configActions,
    getWorkspaceActions: () => deps?.workspaceActions,
    getSessionSyncActions: () => ({
      getActiveSessionId: () => null,
      getSessionMessages: vi.fn(),
      setSessionMessages: vi.fn(),
      updateSessionStatus: vi.fn(),
    }),

    // 应用 eventHandlerSlice
    ...createEventHandlerSlice(...args),
  }) as any)
}

describe('eventHandlerSlice', () => {
  let mockDeps: ReturnType<typeof createMockDependencies>

  beforeEach(() => {
    vi.clearAllMocks()
    
    // 创建新的 mock 依赖
    mockDeps = createMockDependencies()
    
    // Mock sessionStorage
    vi.stubGlobal('sessionStorage', {
      setItem: vi.fn(),
      getItem: vi.fn(() => null),
      removeItem: vi.fn(),
      clear: vi.fn(),
    })
    // Mock crypto.randomUUID
    vi.stubGlobal('crypto', {
      randomUUID: () => 'test-uuid-' + Math.random().toString(36).slice(2),
    })
    // Reset invoke mock
    vi.mocked(invoke).mockReset()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ============================================================
  // 初始状态测试
  // ============================================================
  describe('初始状态', () => {
    it('事件监听器应未初始化', () => {
      const store = createTestStore()
      expect(store.getState()._eventListenersInitialized).toBe(false)
    })

    it('事件监听器清理函数应为 null', () => {
      const store = createTestStore()
      expect(store.getState()._eventListenersCleanup).toBeNull()
    })
  })

  // ============================================================
  // initializeEventListeners 测试
  // ============================================================
  describe('initializeEventListeners', () => {
    it('应成功初始化并返回清理函数', async () => {
      const store = createTestStore()

      const cleanup = await store.getState().initializeEventListeners()

      expect(store.getState()._eventListenersInitialized).toBe(true)
      expect(typeof cleanup).toBe('function')
    })

    it('重复调用应返回相同清理函数', async () => {
      const store = createTestStore()

      const cleanup1 = await store.getState().initializeEventListeners()
      const cleanup2 = await store.getState().initializeEventListeners()

      // 两次调用返回相同清理函数
      expect(cleanup1).toBe(cleanup2)
    })

    it('清理函数应重置初始化状态', async () => {
      const store = createTestStore()

      const cleanup = await store.getState().initializeEventListeners()
      expect(store.getState()._eventListenersInitialized).toBe(true)

      cleanup()

      expect(store.getState()._eventListenersInitialized).toBe(false)
      expect(store.getState()._eventListenersCleanup).toBeNull()
    })

    // ============================================================
    // StrictMode 场景测试
    // ============================================================
    describe('StrictMode 兼容性', () => {
      it('应正确处理 StrictMode 双重挂载', async () => {
        const store = createTestStore()

        // 模拟 StrictMode 行为：mount -> unmount -> remount
        // 第一次 mount
        const cleanup1 = await store.getState().initializeEventListeners()
        expect(store.getState()._eventListenersInitialized).toBe(true)

        // StrictMode unmount
        cleanup1()
        expect(store.getState()._eventListenersInitialized).toBe(false)

        // 第二次 mount (StrictMode remount)
        const cleanup2 = await store.getState().initializeEventListeners()
        expect(store.getState()._eventListenersInitialized).toBe(true)

        // 清理
        cleanup2()
        expect(store.getState()._eventListenersInitialized).toBe(false)
      })

      it('未完成初始化时的并发调用应安全处理', async () => {
        const store = createTestStore()

        // 同时发起多次初始化（模拟竞态）
        const [cleanup1, cleanup2] = await Promise.all([
          store.getState().initializeEventListeners(),
          store.getState().initializeEventListeners(),
        ])

        // 并发调用时，两个 cleanup 函数可能不同，但最终状态应一致
        // EventRouter 的 register 强制单例模式确保不会有重复 handler
        expect(store.getState()._eventListenersInitialized).toBe(true)

        // 任一 cleanup 都能正确清理状态
        cleanup1()
        expect(store.getState()._eventListenersInitialized).toBe(false)

        // cleanup2 也应该是安全的（幂等）
        expect(() => cleanup2()).not.toThrow()
      })

      it('清理后再初始化应成功', async () => {
        const store = createTestStore()

        // 初始化
        const cleanup1 = await store.getState().initializeEventListeners()
        expect(store.getState()._eventListenersInitialized).toBe(true)

        // 清理
        cleanup1()

        // 再次初始化
        const cleanup2 = await store.getState().initializeEventListeners()
        expect(store.getState()._eventListenersInitialized).toBe(true)

        cleanup2()
      })

      it('cleanup 函数应幂等', async () => {
        const store = createTestStore()

        const cleanup = await store.getState().initializeEventListeners()
        expect(store.getState()._eventListenersInitialized).toBe(true)

        // 多次调用 cleanup 不应抛出错误
        cleanup()
        cleanup()
        cleanup()

        expect(store.getState()._eventListenersInitialized).toBe(false)
      })
    })
  })

  // ============================================================
  // sendMessage 测试
  // ============================================================
  describe('sendMessage', () => {
    it('无工作区时应设置错误', async () => {
      // Mock 无工作区
      mockDeps.workspaceActions.getCurrentWorkspace.mockReturnValue(null)
      const store = createTestStore(mockDeps)

      await store.getState().sendMessage('Hello')

      expect(store.getState().error).toBe('请先创建或选择一个工作区')
    })

    it('应添加用户消息到列表', async () => {
      const store = createTestStore(mockDeps)
      const addMessageSpy = vi.spyOn(store.getState(), 'addMessage')

      // Mock start_chat invoke
      vi.mocked(invoke).mockResolvedValueOnce('new-session-id')

      await store.getState().sendMessage('Hello')

      expect(addMessageSpy).toHaveBeenCalled()
      const callArg = addMessageSpy.mock.calls[0][0]
      expect(callArg.type).toBe('user')
      expect(callArg.content).toBe('Hello')
    })

    it('新会话应调用 start_chat', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: null })

      vi.mocked(invoke).mockResolvedValueOnce('new-session-id')

      await store.getState().sendMessage('Hello')

      expect(invoke).toHaveBeenCalledWith(
        'start_chat',
        expect.objectContaining({
          message: 'Hello',
          options: expect.objectContaining({
            workDir: '/test/workspace',
            contextId: 'main',
            engineId: 'claude-code',
            enableMcpTools: true,
          }),
        })
      )
    })

    it('已有会话应调用 continue_chat', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: 'existing-session-id' })

      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await store.getState().sendMessage('Continue message')

      expect(invoke).toHaveBeenCalledWith(
        'continue_chat',
        expect.objectContaining({
          sessionId: 'existing-session-id',
          message: expect.any(String),
          options: expect.objectContaining({
            enableMcpTools: true,
          }),
        })
      )
    })

    it('发送消息时应设置 isStreaming 为 true', async () => {
      // 注意：修复竞态条件后，isStreaming 由 session_start 事件设置
      // 所以在 sendMessage 返回后，如果没有收到 session_start 事件，isStreaming 应为 false
      const store = createTestStore(mockDeps)
      vi.mocked(invoke).mockResolvedValueOnce('new-session-id')

      await store.getState().sendMessage('Hello')

      // 修复后：isStreaming 不再在 sendMessage 中设置，而是等待 session_start 事件
      expect(store.getState().isStreaming).toBe(false)
    })

    it('发送失败时应设置错误', async () => {
      const store = createTestStore(mockDeps)
      vi.mocked(invoke).mockRejectedValueOnce(new Error('Network error'))

      await store.getState().sendMessage('Hello')

      // 统一错误处理返回用户友好消息
      expect(store.getState().error).toBe('AI 处理失败，请稍后重试')
      expect(store.getState().isStreaming).toBe(false)
    })

    it('发送消息时应清空之前的错误', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ error: 'Previous error' })
      vi.mocked(invoke).mockResolvedValueOnce('new-session-id')

      await store.getState().sendMessage('Hello')

      expect(store.getState().error).toBeNull()
    })
  })

  // ============================================================
  // continueChat 测试
  // ============================================================
  describe('continueChat', () => {
    it('无会话 ID 应设置错误', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: null })

      await store.getState().continueChat()

      expect(store.getState().error).toBe('没有活动会话')
    })

    it('有会话 ID 应调用 continue_chat', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: 'test-session-id' })

      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await store.getState().continueChat('Continue prompt')

      expect(invoke).toHaveBeenCalledWith(
        'continue_chat',
        expect.objectContaining({
          sessionId: 'test-session-id',
          message: expect.any(String),
        })
      )
    })

    it('continueChat 失败应设置错误', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: 'test-session-id' })

      vi.mocked(invoke).mockRejectedValueOnce(new Error('Continue failed'))

      await store.getState().continueChat()

      // 统一错误处理返回用户友好消息
      expect(store.getState().error).toBe('AI 处理失败，请稍后重试')
      expect(store.getState().isStreaming).toBe(false)
    })
  })

  // ============================================================
  // interruptChat 测试
  // ============================================================
  describe('interruptChat', () => {
    it('应调用 interrupt_chat', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: 'test-session-id', isStreaming: true })

      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await store.getState().interruptChat()

      expect(invoke).toHaveBeenCalledWith(
        'interrupt_chat',
        expect.objectContaining({
          sessionId: 'test-session-id',
        })
      )
    })

    it('中断后应设置 isStreaming 为 false', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: 'test-session-id', isStreaming: true })

      vi.mocked(invoke).mockResolvedValueOnce(undefined)

      await store.getState().interruptChat()

      expect(store.getState().isStreaming).toBe(false)
    })

    it('无会话 ID 时不应调用 interrupt_chat', async () => {
      const store = createTestStore(mockDeps)
      store.setState({ conversationId: null })

      await store.getState().interruptChat()

      expect(invoke).not.toHaveBeenCalled()
    })
  })

})
