import { describe, it, expect, vi, beforeEach } from 'vitest'
import { storeEventBus, type WorkspaceChangedPayload, type ToastRequestedPayload } from './storeEventBus'

describe('storeEventBus', () => {
  beforeEach(() => {
    storeEventBus.removeAllListeners()
  })

  describe('on', () => {
    it('应该订阅事件', () => {
      const handler = vi.fn()
      storeEventBus.on('WORKSPACE_CHANGED', handler)

      const payload: WorkspaceChangedPayload = { workspaceId: 'ws1', action: 'switched' }
      storeEventBus.emit('WORKSPACE_CHANGED', payload)

      expect(handler).toHaveBeenCalledWith(payload)
    })

    it('应该返回取消订阅函数', () => {
      const handler = vi.fn()
      const unsub = storeEventBus.on('WORKSPACE_CHANGED', handler)

      unsub()

      const payload: WorkspaceChangedPayload = { workspaceId: 'ws1', action: 'switched' }
      storeEventBus.emit('WORKSPACE_CHANGED', payload)

      expect(handler).not.toHaveBeenCalled()
    })

    it('应该支持多个监听器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      storeEventBus.on('WORKSPACE_CHANGED', handler1)
      storeEventBus.on('WORKSPACE_CHANGED', handler2)

      const payload: WorkspaceChangedPayload = { workspaceId: 'ws1', action: 'switched' }
      storeEventBus.emit('WORKSPACE_CHANGED', payload)

      expect(handler1).toHaveBeenCalledWith(payload)
      expect(handler2).toHaveBeenCalledWith(payload)
    })
  })

  describe('emit', () => {
    it('应该触发所有监听器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      storeEventBus.on('TOAST_REQUESTED', handler1)
      storeEventBus.on('TOAST_REQUESTED', handler2)

      const payload: ToastRequestedPayload = { message: 'Test', type: 'info' }
      storeEventBus.emit('TOAST_REQUESTED', payload)

      expect(handler1).toHaveBeenCalledTimes(1)
      expect(handler2).toHaveBeenCalledTimes(1)
    })

    it('应该处理监听器中的错误', () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const handler1 = vi.fn(() => { throw new Error('Test error') })
      const handler2 = vi.fn()
      storeEventBus.on('TOAST_REQUESTED', handler1)
      storeEventBus.on('TOAST_REQUESTED', handler2)

      const payload: ToastRequestedPayload = { message: 'Test', type: 'info' }
      storeEventBus.emit('TOAST_REQUESTED', payload)

      expect(handler1).toHaveBeenCalled()
      expect(handler2).toHaveBeenCalled()
      consoleSpy.mockRestore()
    })

    it('应该忽略没有监听器的事件', () => {
      const payload: ToastRequestedPayload = { message: 'Test', type: 'info' }
      expect(() => storeEventBus.emit('TOAST_REQUESTED', payload)).not.toThrow()
    })
  })

  describe('removeAllListeners', () => {
    it('应该移除指定事件的所有监听器', () => {
      const handler1 = vi.fn()
      const handler2 = vi.fn()
      storeEventBus.on('WORKSPACE_CHANGED', handler1)
      storeEventBus.on('WORKSPACE_CHANGED', handler2)
      storeEventBus.on('TOAST_REQUESTED', vi.fn())

      storeEventBus.removeAllListeners('WORKSPACE_CHANGED')

      const payload: WorkspaceChangedPayload = { workspaceId: 'ws1', action: 'switched' }
      storeEventBus.emit('WORKSPACE_CHANGED', payload)

      expect(handler1).not.toHaveBeenCalled()
      expect(handler2).not.toHaveBeenCalled()
    })

    it('应该移除所有事件的监听器', () => {
      storeEventBus.on('WORKSPACE_CHANGED', vi.fn())
      storeEventBus.on('TOAST_REQUESTED', vi.fn())

      storeEventBus.removeAllListeners()

      const wsPayload: WorkspaceChangedPayload = { workspaceId: 'ws1', action: 'switched' }
      const toastPayload: ToastRequestedPayload = { message: 'Test', type: 'info' }

      storeEventBus.emit('WORKSPACE_CHANGED', wsPayload)
      storeEventBus.emit('TOAST_REQUESTED', toastPayload)
    })
  })
})
