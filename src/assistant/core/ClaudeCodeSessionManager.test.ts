import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClaudeCodeSessionManager, resetClaudeCodeSessionManager } from './ClaudeCodeSessionManager'

// Mock sessionStoreManager
vi.mock('../../stores/conversationStore', () => ({
  sessionStoreManager: {
    getState: () => ({
      createSession: vi.fn(),
      getStore: vi.fn(() => ({ sendMessage: vi.fn() })),
      deleteSession: vi.fn(),
      interruptSession: vi.fn(),
    }),
  },
}))

describe('ClaudeCodeSessionManager', () => {
  let manager: ClaudeCodeSessionManager

  beforeEach(() => {
    resetClaudeCodeSessionManager()
    manager = new ClaudeCodeSessionManager()
  })

  it('should create primary session with fixed id', () => {
    const id = manager.createSession('primary', '主会话')
    expect(id).toBe('primary')
  })

  it('should create analysis session with unique id', () => {
    const id = manager.createSession('analysis', '分析任务')
    expect(id).toMatch(/^analysis-\d+$/)
  })

  it('should track session state', () => {
    manager.createSession('primary', '主会话')
    const state = manager.getSession('primary')
    expect(state).toBeDefined()
    expect(state?.type).toBe('primary')
    expect(state?.label).toBe('主会话')
  })

  it('should return all sessions', () => {
    manager.createSession('primary', '主会话')
    manager.createSession('analysis', '分析任务')
    const sessions = manager.getAllSessions()
    expect(sessions).toHaveLength(2)
  })

  it('should not delete primary session', () => {
    manager.createSession('primary', '主会话')
    manager.deleteSession('primary')
    expect(manager.getSession('primary')).toBeDefined()
  })

  it('should delete non-primary sessions', () => {
    const id = manager.createSession('analysis', '分析任务')
    manager.deleteSession(id)
    expect(manager.getSession(id)).toBeUndefined()
  })

  it('should update session status', () => {
    manager.createSession('primary', '主会话')
    manager.updateSessionStatus('primary', 'running')
    expect(manager.getSession('primary')?.status).toBe('running')
  })
})
