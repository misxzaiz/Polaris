import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AssistantEngine, resetAssistantEngine } from './AssistantEngine'

// Mock dependencies
vi.mock('../../engines/openai-protocol', () => ({
  OpenAIProtocolEngine: vi.fn().mockImplementation(function() {
    return {
      setTools: vi.fn(),
      createSession: vi.fn(() => ({
        run: vi.fn(async function* () {
          yield { type: 'assistant_message', content: 'Hello', isDelta: true }
          yield { type: 'session_end', sessionId: 'test' }
        }),
      })),
      cleanup: vi.fn(),
    }
  }),
}))

vi.mock('../../ai-runtime', () => ({
  getEventBus: () => ({
    onAny: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('../store/assistantStore', () => ({
  useAssistantStore: {
    getState: () => ({
      addMessage: vi.fn(),
      createClaudeCodeSession: vi.fn(() => 'test-session'),
      getClaudeCodeSession: vi.fn(() => ({ id: 'test-session', status: 'idle' })),
      executeInSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      setError: vi.fn(),
    }),
  },
}))

describe('AssistantEngine', () => {
  let engine: AssistantEngine

  beforeEach(() => {
    resetAssistantEngine()
    engine = new AssistantEngine()
  })

  it('should initialize with config', () => {
    engine.initialize({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    })
    // 无错误即通过
  })

  it('should throw error when not initialized', async () => {
    await expect(async () => {
      for await (const _ of engine.processMessage('Hello')) {
        // empty
      }
    }).rejects.toThrow('not initialized')
  })

  it('should cleanup resources', () => {
    engine.initialize({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    })
    engine.cleanup()
    // 无错误即通过
  })
})
