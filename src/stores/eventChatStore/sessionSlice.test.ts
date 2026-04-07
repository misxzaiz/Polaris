/**
 * sessionSlice 单元测试
 *
 * 测试会话状态管理的核心功能
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { create } from 'zustand'

// Import after mocking
import { createSessionSlice } from './sessionSlice'
import type { EventChatState } from './types'

// 创建测试用的 store
function createTestStore() {
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
    isInitialized: true,
    isLoadingHistory: false,
    isArchiveExpanded: false,
    maxMessages: 500,

    // 需要的方法
    saveToStorage: vi.fn(),
    clearMessages: vi.fn(),
    get: () => ({} as any),

    // 应用 sessionSlice
    ...createSessionSlice(...args),
  }) as any)
}

describe('sessionSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('初始状态', () => {
    it('应正确初始化所有状态', () => {
      const store = createTestStore()
      const state = store.getState()

      expect(state.conversationId).toBeNull()
      expect(state.currentConversationSeed).toBeNull()
      expect(state.isStreaming).toBe(false)
      expect(state.error).toBeNull()
      expect(state.progressMessage).toBeNull()
    })
  })

  describe('setConversationId', () => {
    it('应正确设置会话 ID', () => {
      const store = createTestStore()

      store.getState().setConversationId('conv-123')

      expect(store.getState().conversationId).toBe('conv-123')
    })

    it('应能设置为 null', () => {
      const store = createTestStore()

      store.getState().setConversationId('conv-123')
      store.getState().setConversationId(null)

      expect(store.getState().conversationId).toBeNull()
    })

  })

  describe('setStreaming', () => {
    it('应正确设置流式状态为 true', () => {
      const store = createTestStore()

      store.getState().setStreaming(true)

      expect(store.getState().isStreaming).toBe(true)
    })

    it('应正确设置流式状态为 false', () => {
      const store = createTestStore()

      store.setState({ isStreaming: true })
      store.getState().setStreaming(false)

      expect(store.getState().isStreaming).toBe(false)
    })
  })

  describe('setError', () => {
    it('应正确设置错误信息', () => {
      const store = createTestStore()

      store.getState().setError('Something went wrong')

      expect(store.getState().error).toBe('Something went wrong')
    })

    it('应能清除错误信息', () => {
      const store = createTestStore()

      store.setState({ error: 'Error' })
      store.getState().setError(null)

      expect(store.getState().error).toBeNull()
    })
  })

  describe('setProgressMessage', () => {
    it('应正确设置进度消息', () => {
      const store = createTestStore()

      store.getState().setProgressMessage('Processing...')

      expect(store.getState().progressMessage).toBe('Processing...')
    })

    it('应能清除进度消息', () => {
      const store = createTestStore()

      store.setState({ progressMessage: 'Processing...' })
      store.getState().setProgressMessage(null)

      expect(store.getState().progressMessage).toBeNull()
    })
  })

  describe('状态独立性', () => {
    it('多次状态更新应正确反映最新值', () => {
      const store = createTestStore()

      store.getState().setConversationId('conv-1')
      store.getState().setStreaming(true)
      store.getState().setError('Error 1')
      store.getState().setProgressMessage('Progress 1')

      expect(store.getState().conversationId).toBe('conv-1')
      expect(store.getState().isStreaming).toBe(true)
      expect(store.getState().error).toBe('Error 1')
      expect(store.getState().progressMessage).toBe('Progress 1')

      // 再次更新
      store.getState().setStreaming(false)
      store.getState().setError(null)

      expect(store.getState().isStreaming).toBe(false)
      expect(store.getState().error).toBeNull()
      expect(store.getState().progressMessage).toBe('Progress 1') // 保持不变
    })
  })
})
