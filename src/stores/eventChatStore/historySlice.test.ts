/**
 * historySlice 单元测试
 *
 * 测试历史管理的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Mock claudeCodeHistoryService
vi.mock('../../services/claudeCodeHistoryService', () => ({
  getClaudeCodeHistoryService: () => ({
    listSessions: vi.fn(() => Promise.resolve([])),
    getSessionHistory: vi.fn(() => Promise.resolve([])),
    convertToChatMessages: vi.fn(() => []),
    extractToolCalls: vi.fn(() => []),
  }),
}))

// Mock workspaceStore
vi.mock('../workspaceStore', () => ({
  useWorkspaceStore: {
    getState: () => ({
      workspaces: [],
      currentWorkspaceId: null,
      createWorkspace: vi.fn(async () => {}),
    }),
  },
}))

// Mock sessionStoreManager
vi.mock('../conversationStore/sessionStoreManager', () => ({
  sessionStoreManager: {
    getState: vi.fn(() => ({
      createSessionFromHistory: vi.fn(() => 'test-new-session-id'),
    })),
  },
}))

// Mock useViewStore
vi.mock('../index', () => ({
  useViewStore: {
    getState: () => ({
      setActiveView: vi.fn(),
    }),
  },
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

// Import after mocking
import { createHistorySlice } from './historySlice'
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
    isInitialized: false,
    isLoadingHistory: false,
    isArchiveExpanded: false,
    maxMessages: 500,

    // 需要的方法占位
    clearMessages: vi.fn(),
    setConversationId: vi.fn(),
    setStreaming: vi.fn(),
    setError: vi.fn(),

    // 依赖注入方法
    setDependencies: vi.fn(),
    getGitActions: () => deps?.gitActions,
    getConfigActions: () => deps?.configActions,
    getWorkspaceActions: () => deps?.workspaceActions,

    // 应用 historySlice
    ...createHistorySlice(...args),
  }) as any)
}

describe('historySlice', () => {
  let localStorageMock: Record<string, string> = {}
  let sessionStorageMock: Record<string, string> = {}
  let mockDeps: ReturnType<typeof createMockDependencies>

  beforeEach(() => {
    vi.clearAllMocks()

    // 创建新的 mock 依赖
    mockDeps = createMockDependencies()

    // Mock localStorage
    localStorageMock = {}
    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => localStorageMock[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        localStorageMock[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete localStorageMock[key]
      }),
      clear: vi.fn(() => {
        localStorageMock = {}
      }),
    })

    // Mock sessionStorage
    sessionStorageMock = {}
    vi.stubGlobal('sessionStorage', {
      getItem: vi.fn((key: string) => sessionStorageMock[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        sessionStorageMock[key] = value
      }),
      removeItem: vi.fn((key: string) => {
        delete sessionStorageMock[key]
      }),
      clear: vi.fn(() => {
        sessionStorageMock = {}
      }),
    })

    // Mock console
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})

    // Mock Date
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-18T12:00:00Z'))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('初始状态', () => {
    it('应正确初始化所有状态', () => {
      const store = createTestStore()
      const state = store.getState()

      expect(state.isInitialized).toBe(false)
      expect(state.isLoadingHistory).toBe(false)
      expect(state.isArchiveExpanded).toBe(false)
      expect(state.maxMessages).toBe(500)
    })
  })

  describe('setMaxMessages', () => {
    it('应正确设置最大消息数', () => {
      const store = createTestStore()

      store.getState().setMaxMessages(300)

      expect(store.getState().maxMessages).toBe(300)
    })

    it('应确保最小值为 100', () => {
      const store = createTestStore()

      store.getState().setMaxMessages(50)

      expect(store.getState().maxMessages).toBe(100)
    })

    it('消息超过限制时应归档旧消息', () => {
      const store = createTestStore()

      // 设置初始消息
      const messages = Array.from({ length: 150 }, (_, i) => ({
        id: `msg-${i}`,
        type: 'user' as const,
        content: `Message ${i}`,
        timestamp: new Date().toISOString(),
      }))

      store.setState({ messages, archivedMessages: [] })

      // 设置最大消息数为 100
      store.getState().setMaxMessages(100)

      const state = store.getState()
      expect(state.messages.length).toBe(100)
      expect(state.archivedMessages.length).toBe(50)
      // 验证归档的是旧消息（前 50 条）
      expect(state.archivedMessages[0].id).toBe('msg-0')
      expect(state.messages[0].id).toBe('msg-50')
    })
  })

  describe('toggleArchive', () => {
    it('应切换归档展开状态', () => {
      const store = createTestStore()

      expect(store.getState().isArchiveExpanded).toBe(false)

      store.getState().toggleArchive()
      expect(store.getState().isArchiveExpanded).toBe(true)

      store.getState().toggleArchive()
      expect(store.getState().isArchiveExpanded).toBe(false)
    })
  })

  describe('loadArchivedMessages', () => {
    it('应加载所有归档消息到消息列表开头', () => {
      const store = createTestStore()

      const archivedMessages = [
        { id: 'archived-1', type: 'user' as const, content: 'Old 1', timestamp: '' },
        { id: 'archived-2', type: 'user' as const, content: 'Old 2', timestamp: '' },
      ]
      const currentMessages = [
        { id: 'current-1', type: 'user' as const, content: 'Current', timestamp: '' },
      ]

      store.setState({
        messages: currentMessages,
        archivedMessages,
        isArchiveExpanded: true,
      })

      store.getState().loadArchivedMessages()

      const state = store.getState()
      expect(state.messages.length).toBe(3)
      expect(state.messages[0].id).toBe('archived-1')
      expect(state.archivedMessages.length).toBe(0)
      expect(state.isArchiveExpanded).toBe(false)
    })

    it('无归档消息时不应改变状态', () => {
      const store = createTestStore()
      const messages = [{ id: 'msg-1', type: 'user' as const, content: 'Test', timestamp: '' }]

      store.setState({ messages, archivedMessages: [] })

      store.getState().loadArchivedMessages()

      expect(store.getState().messages.length).toBe(1)
    })
  })

  describe('loadMoreArchivedMessages', () => {
    it('应分批加载指定数量的归档消息', () => {
      const store = createTestStore()

      const archivedMessages = Array.from({ length: 50 }, (_, i) => ({
        id: `archived-${i}`,
        type: 'user' as const,
        content: `Old ${i}`,
        timestamp: '',
      }))
      const currentMessages = [{ id: 'current-1', type: 'user' as const, content: 'Current', timestamp: '' }]

      store.setState({ messages: currentMessages, archivedMessages })

      // 默认加载 20 条
      store.getState().loadMoreArchivedMessages()

      const state = store.getState()
      expect(state.messages.length).toBe(21) // 20 归档 + 1 当前
      expect(state.archivedMessages.length).toBe(30)
      // 验证加载的是最新的归档消息（从末尾取）
      expect(state.messages[0].id).toBe('archived-30')
      expect(state.messages[19].id).toBe('archived-49')
    })

    it('应正确处理自定义加载数量', () => {
      const store = createTestStore()

      const archivedMessages = Array.from({ length: 30 }, (_, i) => ({
        id: `archived-${i}`,
        type: 'user' as const,
        content: `Old ${i}`,
        timestamp: '',
      }))

      store.setState({ messages: [], archivedMessages })

      store.getState().loadMoreArchivedMessages(10)

      expect(store.getState().messages.length).toBe(10)
      expect(store.getState().archivedMessages.length).toBe(20)
    })

    it('归档消息少于请求数量时应全部加载', () => {
      const store = createTestStore()

      const archivedMessages = [
        { id: 'archived-1', type: 'user' as const, content: 'Old 1', timestamp: '' },
        { id: 'archived-2', type: 'user' as const, content: 'Old 2', timestamp: '' },
      ]

      store.setState({ messages: [], archivedMessages })

      store.getState().loadMoreArchivedMessages(20)

      expect(store.getState().messages.length).toBe(2)
      expect(store.getState().archivedMessages.length).toBe(0)
    })

    it('无归档消息时不应改变状态', () => {
      const store = createTestStore()

      store.setState({ messages: [], archivedMessages: [] })

      store.getState().loadMoreArchivedMessages()

      expect(store.getState().messages.length).toBe(0)
    })
  })

  describe('saveToStorage', () => {
    it('saveToStorage 已废弃，应由 persist 中间件处理', () => {
      const store = createTestStore()

      const messages = [{ id: 'msg-1', type: 'user' as const, content: 'Test', timestamp: '' }]
      const archivedMessages = [{ id: 'archived-1', type: 'user' as const, content: 'Old', timestamp: '' }]

      store.setState({
        messages,
        archivedMessages,
        conversationId: 'conv-123',
      })

      // saveToStorage 已废弃，不应再操作 sessionStorage
      store.getState().saveToStorage()

      // 验证 sessionStorage.setItem 没有被调用
      expect(sessionStorage.setItem).not.toHaveBeenCalled()
    })
  })

  describe('restoreFromStorage', () => {
    it('restoreFromStorage 已废弃，应由 persist 中间件处理', () => {
      const store = createTestStore()

      // restoreFromStorage 已废弃，应返回 false
      const result = store.getState().restoreFromStorage()

      expect(result).toBe(false)
    })

    it('无存储数据时应返回 false', () => {
      const store = createTestStore()

      const result = store.getState().restoreFromStorage()

      expect(result).toBe(false)
    })

    it('版本不匹配时应返回 false', () => {
      const store = createTestStore()

      const savedData = {
        version: '4', // 旧版本
        timestamp: new Date().toISOString(),
        messages: [],
        conversationId: null,
      }
      sessionStorageMock['event_chat_state_backup'] = JSON.stringify(savedData)

      // restoreFromStorage 已废弃，总是返回 false
      const result = store.getState().restoreFromStorage()

      expect(result).toBe(false)
    })

    it('超过 1 小时的数据应返回 false', () => {
      const store = createTestStore()

      // 创建超过 1 小时前的时间戳
      const oldTime = new Date(Date.now() - 61 * 60 * 1000)
      const savedData = {
        version: '5',
        timestamp: oldTime.toISOString(),
        messages: [{ id: 'msg-1', type: 'user', content: 'Test', timestamp: '' }],
        conversationId: 'conv-123',
      }
      sessionStorageMock['event_chat_state_backup'] = JSON.stringify(savedData)

      // restoreFromStorage 已废弃，总是返回 false
      const result = store.getState().restoreFromStorage()

      expect(result).toBe(false)
    })
  })

  describe('saveToHistory', () => {
    it('应保存会话到 localStorage 历史', () => {
      const store = createTestStore(mockDeps)

      store.setState({
        conversationId: 'conv-123',
        messages: [
          { id: 'msg-1', type: 'user' as const, content: 'Hello world this is a test', timestamp: '' },
          { id: 'msg-2', type: 'assistant' as const, blocks: [], timestamp: '' },
        ],
      })

      store.getState().saveToHistory()

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'event_chat_session_history',
        expect.any(String)
      )

      const history = JSON.parse(localStorageMock['event_chat_session_history'])
      expect(history.length).toBe(1)
      expect(history[0].id).toBe('conv-123')
      expect(history[0].title).toBe('Hello world this is a test...')
      expect(history[0].messageCount).toBe(2)
      expect(history[0].engineId).toBe('claude-code')
    })

    it('应使用自定义标题', () => {
      const store = createTestStore(mockDeps)

      store.setState({
        conversationId: 'conv-123',
        messages: [{ id: 'msg-1', type: 'user' as const, content: 'Test', timestamp: '' }],
      })

      store.getState().saveToHistory('Custom Title')

      const history = JSON.parse(localStorageMock['event_chat_session_history'])
      expect(history[0].title).toBe('Custom Title')
    })

    it('无 conversationId 时不应保存', () => {
      const store = createTestStore(mockDeps)

      store.setState({
        conversationId: null,
        messages: [{ id: 'msg-1', type: 'user' as const, content: 'Test', timestamp: '' }],
      })

      store.getState().saveToHistory()

      expect(localStorage.setItem).not.toHaveBeenCalled()
    })

    it('无消息时不应保存', () => {
      const store = createTestStore(mockDeps)

      store.setState({
        conversationId: 'conv-123',
        messages: [],
      })

      store.getState().saveToHistory()

      expect(localStorage.setItem).not.toHaveBeenCalled()
    })

    it('应移除同 ID 的旧记录并添加到开头', () => {
      const store = createTestStore(mockDeps)

      // 模拟已有历史
      localStorageMock['event_chat_session_history'] = JSON.stringify([
        { id: 'conv-123', title: 'Old Title', timestamp: '', messageCount: 1, engineId: 'claude-code', data: { messages: [], archivedMessages: [] } },
        { id: 'conv-456', title: 'Other', timestamp: '', messageCount: 1, engineId: 'claude-code', data: { messages: [], archivedMessages: [] } },
      ])

      store.setState({
        conversationId: 'conv-123',
        messages: [
          { id: 'msg-1', type: 'user' as const, content: 'Updated', timestamp: '' },
        ],
      })

      store.getState().saveToHistory('Updated Title')

      const history = JSON.parse(localStorageMock['event_chat_session_history'])
      expect(history.length).toBe(2)
      expect(history[0].id).toBe('conv-123') // 更新后的在开头
      expect(history[0].title).toBe('Updated Title')
      expect(history[1].id).toBe('conv-456') // 其他保持不变
    })
  })

  describe('getUnifiedHistory', () => {
    it('应返回合并后的历史列表', async () => {
      const store = createTestStore(mockDeps)

      // 设置 localStorage 历史
      localStorageMock['event_chat_session_history'] = JSON.stringify([
        { id: 'local-1', title: 'Local Session', timestamp: '2026-03-18T10:00:00Z', messageCount: 5, engineId: 'claude-code' },
      ])

      const history = await store.getState().getUnifiedHistory()

      expect(Array.isArray(history)).toBe(true)
      expect(history.length).toBeGreaterThanOrEqual(1)
      // 验证本地历史被包含
      expect(history.find(h => h.id === 'local-1')).toBeDefined()
    })

    it('应按时间戳降序排列', async () => {
      const store = createTestStore(mockDeps)

      localStorageMock['event_chat_session_history'] = JSON.stringify([
        { id: 'old', title: 'Old', timestamp: '2026-03-17T10:00:00Z', messageCount: 1, engineId: 'claude-code' },
        { id: 'new', title: 'New', timestamp: '2026-03-18T10:00:00Z', messageCount: 1, engineId: 'claude-code' },
      ])

      const history = await store.getState().getUnifiedHistory()

      // 最新应该在前面
      const oldIndex = history.findIndex(h => h.id === 'old')
      const newIndex = history.findIndex(h => h.id === 'new')
      expect(newIndex).toBeLessThan(oldIndex)
    })
  })

  describe('deleteHistorySession', () => {
    it('应从 localStorage 历史中删除会话', () => {
      const store = createTestStore()

      localStorageMock['event_chat_session_history'] = JSON.stringify([
        { id: 'conv-1', title: 'Session 1', timestamp: '', messageCount: 1, engineId: 'claude-code', data: { messages: [], archivedMessages: [] } },
        { id: 'conv-2', title: 'Session 2', timestamp: '', messageCount: 1, engineId: 'claude-code', data: { messages: [], archivedMessages: [] } },
      ])

      store.getState().deleteHistorySession('conv-1')

      const history = JSON.parse(localStorageMock['event_chat_session_history'])
      expect(history.length).toBe(1)
      expect(history[0].id).toBe('conv-2')
    })
  })

  describe('clearHistory', () => {
    it('应清空 localStorage 历史', () => {
      const store = createTestStore()

      localStorageMock['event_chat_session_history'] = JSON.stringify([
        { id: 'conv-1', title: 'Session', timestamp: '', messageCount: 1, engineId: 'claude-code' },
      ])

      store.getState().clearHistory()

      expect(localStorage.removeItem).toHaveBeenCalledWith('event_chat_session_history')
    })
  })
})
