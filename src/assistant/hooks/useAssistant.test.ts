/**
 * useAssistant Hook 测试
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAssistant } from './useAssistant'

// Mock store
const mockStore = {
  messages: [],
  isLoading: false,
  error: null,
  executionPanelExpanded: false,
  setLoading: vi.fn(),
  setError: vi.fn(),
  clearMessages: vi.fn(),
  addMessage: vi.fn(),
  getAllClaudeCodeSessions: vi.fn(() => []),
  getRunningSessions: vi.fn(() => []),
  abortAllSessions: vi.fn(),
  toggleExecutionPanel: vi.fn(),
}

vi.mock('../store/assistantStore', () => ({
  useAssistantStore: vi.fn(() => mockStore),
}))

// Mock engine
const mockEngine = {
  processMessage: vi.fn(async function* () {
    yield { type: 'message_start' }
    yield { type: 'content_delta', content: 'Hello' }
    yield { type: 'message_complete' }
  }),
}

vi.mock('../core/AssistantEngine', () => ({
  getAssistantEngine: () => mockEngine,
}))

describe('useAssistant', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockStore.messages = []
    mockStore.isLoading = false
    mockStore.error = null
  })

  describe('initial state', () => {
    it('should return correct initial state', () => {
      const { result } = renderHook(() => useAssistant())

      expect(result.current.messages).toEqual([])
      expect(result.current.isLoading).toBe(false)
      expect(result.current.error).toBeNull()
    })
  })

  describe('sendMessage', () => {
    it('should not send empty message', async () => {
      const { result } = renderHook(() => useAssistant())

      await act(async () => {
        await result.current.sendMessage('')
      })

      expect(mockEngine.processMessage).not.toHaveBeenCalled()
    })

    it('should not send when loading', async () => {
      mockStore.isLoading = true
      const { result } = renderHook(() => useAssistant())

      await act(async () => {
        await result.current.sendMessage('test')
      })

      expect(mockEngine.processMessage).not.toHaveBeenCalled()
    })

    it('should set loading and call engine', async () => {
      const { result } = renderHook(() => useAssistant())

      await act(async () => {
        await result.current.sendMessage('Hello')
      })

      expect(mockStore.setLoading).toHaveBeenCalledWith(true)
      expect(mockEngine.processMessage).toHaveBeenCalledWith('Hello')
      expect(mockStore.setLoading).toHaveBeenCalledTimes(2) // true then false
    })

    it('should handle errors', async () => {
      mockEngine.processMessage.mockImplementationOnce(async function* () {
        yield 'error'
        throw new Error('Test error')
      })

      const { result } = renderHook(() => useAssistant())

      await act(async () => {
        await result.current.sendMessage('Hello')
      })

      expect(mockStore.setError).toHaveBeenCalledWith('Test error')
    })
  })

  describe('abort', () => {
    it('should abort all sessions', async () => {
      const { result } = renderHook(() => useAssistant())

      await act(async () => {
        await result.current.abort()
      })

      expect(mockStore.abortAllSessions).toHaveBeenCalled()
      expect(mockStore.setLoading).toHaveBeenCalledWith(false)
    })
  })

  describe('UI controls', () => {
    it('should toggle execution panel', () => {
      const { result } = renderHook(() => useAssistant())

      act(() => {
        result.current.toggleExecutionPanel()
      })

      expect(mockStore.toggleExecutionPanel).toHaveBeenCalled()
    })

    it('should clear messages', () => {
      const { result } = renderHook(() => useAssistant())

      act(() => {
        result.current.clearMessages()
      })

      expect(mockStore.clearMessages).toHaveBeenCalled()
    })
  })
})
