/**
 * SessionCommandRouter 测试（S4 · 统一仲裁命令层）
 *
 * 用 mock aiChatDispatch/Stream 验证：
 * 1. sessionSend accepted=true → 返回 ticketId + requestId
 * 2. sessionSend accepted=false → already_running / reason
 * 3. sessionInterrupt accepted + not_owner
 * 4. requestId 每次唯一
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/services/aiChatDispatch', () => ({
  aiChatDispatch: vi.fn(),
  aiChatDispatchStream: vi.fn(),
}))

import { aiChatDispatch, aiChatDispatchStream } from '@/services/aiChatDispatch'
import { sessionSend, sessionInterrupt, sessionResume } from './sessionCommandRouter'

const mockedStream = aiChatDispatchStream as ReturnType<typeof vi.fn>
const mockedDispatch = aiChatDispatch as ReturnType<typeof vi.fn>

describe('SessionCommandRouter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  describe('sessionSend', () => {
    it('accepted=true 返回 ticketId + requestId', async () => {
      mockedStream.mockResolvedValue({ msgId: 'ticket-1', trace: '' })

      const result = await sessionSend({
        sessionId: 's1',
        message: 'hello',
      })

      expect(result.accepted).toBe(true)
      expect(result.ticketId).toBe('ticket-1')
      expect(result.requestId).toMatch(/^[\da-f-]+$/)
      expect(mockedStream).toHaveBeenCalledWith(expect.objectContaining({
        action: 'start',
        message: 'hello',
        sessionId: 's1',
      }))
    })

    it('continue=true 走 continue action', async () => {
      mockedStream.mockResolvedValue({ msgId: 't2', trace: '' })

      await sessionSend({ sessionId: 's1', message: 'more', continue: true })

      expect(mockedStream).toHaveBeenCalledWith(expect.objectContaining({
        action: 'continue',
      }))
    })

    it('accepted=false 识别 already_running', async () => {
      mockedStream.mockRejectedValue(new Error('already_running: 会话正在运行'))

      const result = await sessionSend({ sessionId: 's1', message: 'hi' })

      expect(result.accepted).toBe(false)
      expect(result.reason).toBe('already_running')
      expect(result.requestId).toMatch(/^[\da-f-]+$/)
    })

    it('requestId 每次唯一', async () => {
      mockedStream.mockResolvedValue({ msgId: 't', trace: '' })

      const r1 = await sessionSend({ sessionId: 's1', message: 'a' })
      const r2 = await sessionSend({ sessionId: 's1', message: 'b' })

      expect(r1.requestId).not.toBe(r2.requestId)
    })
  })

  describe('sessionInterrupt', () => {
    it('accepted=true', async () => {
      mockedDispatch.mockResolvedValue({ interrupted: true })

      const result = await sessionInterrupt({ sessionId: 's1' })

      expect(result.accepted).toBe(true)
      expect(mockedDispatch).toHaveBeenCalledWith(expect.objectContaining({
        action: 'interrupt',
        sessionId: 's1',
      }))
    })

    it('not_owner 识别', async () => {
      mockedDispatch.mockRejectedValue(new Error('not_owner: 无权限中断'))

      const result = await sessionInterrupt({ sessionId: 's1' })

      expect(result.accepted).toBe(false)
      expect(result.reason).toBe('not_owner')
    })

    it('not_running 识别', async () => {
      mockedDispatch.mockRejectedValue(new Error('not_running: 未运行'))

      const result = await sessionInterrupt({ sessionId: 's1' })

      expect(result.accepted).toBe(false)
      expect(result.reason).toBe('not_running')
    })
  })

  describe('sessionResume', () => {
    it('accepted=true 带 resumeFromSeq', async () => {
      mockedStream.mockResolvedValue({ msgId: 't3', trace: '' })

      const result = await sessionResume({
        sessionId: 's1',
        message: 'resume',
        resumeFromSeq: 42,
      })

      expect(result.accepted).toBe(true)
      expect(mockedStream).toHaveBeenCalledWith(expect.objectContaining({
        action: 'continue',
        resumeFromSeq: 42,
      }))
    })
  })
})
