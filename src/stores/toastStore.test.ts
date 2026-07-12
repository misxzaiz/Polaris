import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useToastStore } from './toastStore'

// Mock i18n
vi.mock('i18next', () => ({
  default: {
    t: (key: string, params?: Record<string, unknown>) => {
      if (params?.title) return `${key}:${params.title}`
      return key
    },
  },
}))

describe('toastStore', () => {
  beforeEach(() => {
    useToastStore.getState().clearAll()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('addToast', () => {
    it('应该添加 toast', () => {
      const id = useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
      })

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].id).toBe(id)
      expect(toasts[0].type).toBe('info')
      expect(toasts[0].title).toBe('Test')
    })

    it('应该设置默认 duration 为 4000ms', () => {
      useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
      })

      const { toasts } = useToastStore.getState()
      expect(toasts[0].duration).toBe(4000)
    })

    it('应该使用自定义 duration', () => {
      useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
        duration: 1000,
      })

      const { toasts } = useToastStore.getState()
      expect(toasts[0].duration).toBe(1000)
    })

    it('应该限制最大 toast 数量为 5', () => {
      for (let i = 0; i < 7; i++) {
        useToastStore.getState().addToast({
          type: 'info',
          title: `Toast ${i}`,
        })
      }

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(5)
      expect(toasts[0].title).toBe('Toast 2') // 最旧的被移除
    })
  })

  describe('removeToast', () => {
    it('应该移除指定 toast', () => {
      const id = useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
      })

      useToastStore.getState().removeToast(id)

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(0)
    })

    it('应该只移除指定的 toast', () => {
      const id1 = useToastStore.getState().addToast({
        type: 'info',
        title: 'Test 1',
      })
      const id2 = useToastStore.getState().addToast({
        type: 'info',
        title: 'Test 2',
      })

      useToastStore.getState().removeToast(id1)

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].id).toBe(id2)
    })
  })

  describe('clearAll', () => {
    it('应该清除所有 toast', () => {
      useToastStore.getState().addToast({ type: 'info', title: 'Test 1' })
      useToastStore.getState().addToast({ type: 'info', title: 'Test 2' })

      useToastStore.getState().clearAll()

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(0)
    })
  })

  describe('快捷方法', () => {
    it('success 应该添加成功 toast', () => {
      useToastStore.getState().success('Success', 'Message')

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('success')
      expect(toasts[0].title).toBe('Success')
      expect(toasts[0].message).toBe('Message')
    })

    it('error 应该添加错误 toast，duration 为 6000ms', () => {
      useToastStore.getState().error('Error', 'Message')

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('error')
      expect(toasts[0].duration).toBe(6000)
    })

    it('warning 应该添加警告 toast', () => {
      useToastStore.getState().warning('Warning')

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('warning')
    })

    it('info 应该添加信息 toast', () => {
      useToastStore.getState().info('Info')

      const { toasts } = useToastStore.getState()
      expect(toasts).toHaveLength(1)
      expect(toasts[0].type).toBe('info')
    })
  })

  describe('自动移除', () => {
    it('应该在 duration 后自动移除 toast', () => {
      useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
        duration: 1000,
      })

      expect(useToastStore.getState().toasts).toHaveLength(1)

      vi.advanceTimersByTime(1000)

      expect(useToastStore.getState().toasts).toHaveLength(0)
    })

    it('不应该自动移除 duration 为 0 的 toast', () => {
      useToastStore.getState().addToast({
        type: 'info',
        title: 'Test',
        duration: 0,
      })

      vi.advanceTimersByTime(10000)

      expect(useToastStore.getState().toasts).toHaveLength(1)
    })
  })

  describe('通知历史（消息中心）', () => {
    beforeEach(() => {
      useToastStore.getState().clearNotifications()
    })

    it('addToast 应同步沉淀一条通知历史', () => {
      useToastStore.getState().addToast({ type: 'success', title: 'Saved', message: 'ok' })

      const { notifications } = useToastStore.getState()
      expect(notifications).toHaveLength(1)
      expect(notifications[0].type).toBe('success')
      expect(notifications[0].title).toBe('Saved')
      expect(notifications[0].message).toBe('ok')
      expect(notifications[0].read).toBe(false)
      expect(typeof notifications[0].timestamp).toBe('number')
    })

    it('clearAll 清理活跃 toast 但保留通知历史', () => {
      useToastStore.getState().addToast({ type: 'info', title: 'Keep me' })
      useToastStore.getState().clearAll()

      expect(useToastStore.getState().toasts).toHaveLength(0)
      expect(useToastStore.getState().notifications).toHaveLength(1)
    })

    it('markAllNotificationsRead 应将所有通知标为已读', () => {
      useToastStore.getState().addToast({ type: 'info', title: 'A' })
      useToastStore.getState().addToast({ type: 'error', title: 'B' })

      useToastStore.getState().markAllNotificationsRead()

      const { notifications } = useToastStore.getState()
      expect(notifications.every((n) => n.read)).toBe(true)
    })

    it('removeNotification 应移除指定通知', () => {
      const id = useToastStore.getState().addToast({ type: 'info', title: 'A' })
      useToastStore.getState().addToast({ type: 'info', title: 'B' })

      useToastStore.getState().removeNotification(id)

      const { notifications } = useToastStore.getState()
      expect(notifications).toHaveLength(1)
      expect(notifications[0].title).toBe('B')
    })

    it('clearNotifications 应清空通知历史', () => {
      useToastStore.getState().addToast({ type: 'info', title: 'A' })
      useToastStore.getState().clearNotifications()

      expect(useToastStore.getState().notifications).toHaveLength(0)
    })

    it('通知历史上限为 100（FIFO 移除最旧）', () => {
      for (let i = 0; i < 105; i++) {
        useToastStore.getState().addToast({ type: 'info', title: `N${i}` })
      }

      const { notifications } = useToastStore.getState()
      expect(notifications).toHaveLength(100)
      expect(notifications[0].title).toBe('N5') // 最旧 5 条被移除
    })
  })
})
