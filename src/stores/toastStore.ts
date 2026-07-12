/**
 * Toast 通知状态管理
 *
 * 双层通知模型：
 * - toasts：活跃的瞬时提示（不持久化，自动消失）
 * - notifications：沉淀的通知历史（持久化，供「消息中心」回看）
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import i18n from 'i18next'
import { storeEventBus } from './storeEventBus'

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'session_complete'

export interface Toast {
  id: string
  type: ToastType
  title: string
  message?: string
  duration?: number // 毫秒，0 表示不自动关闭
  action?: {
    label: string
    onClick: () => void
  }
  sessionId?: string
}

/** 通知历史记录（可序列化，不含函数；供消息中心持久化回看） */
export interface NotificationRecord {
  id: string
  type: ToastType
  title: string
  message?: string
  timestamp: number
  read: boolean
  sessionId?: string
}

const MAX_TOASTS = 5
const MAX_NOTIFICATIONS = 100

/** 活跃 toast 的自动消失定时器，用于组件卸载时清理防止内存泄漏 */
const toastTimers = new Map<string, ReturnType<typeof setTimeout>>()

interface ToastState {
  toasts: Toast[]
  notifications: NotificationRecord[]

  // 添加 Toast
  addToast: (toast: Omit<Toast, 'id'>) => string
  // 移除 Toast
  removeToast: (id: string) => void
  // 清除所有活跃 Toast
  clearAll: () => void
  // 快捷方法
  success: (title: string, message?: string) => string
  error: (title: string, message?: string) => string
  warning: (title: string, message?: string) => string
  info: (title: string, message?: string) => string
  // 会话完成通知
  sessionComplete: (title: string, sessionId: string, onSwitch: () => void) => string
  // === 通知历史（消息中心）===
  markAllNotificationsRead: () => void
  clearNotifications: () => void
  removeNotification: (id: string) => void
}

let toastId = 0

export const useToastStore = create<ToastState>()(
  persist(
    (set, get) => ({
      toasts: [],
      notifications: [],

      addToast: (toast) => {
        const id = `toast-${++toastId}`
        const newToast: Toast = {
          id,
          duration: 4000, // 默认 4 秒
          ...toast,
        }

        set((state) => {
          const toasts = [...state.toasts, newToast]
          // 超过最大数量时移除最旧的
          if (toasts.length > MAX_TOASTS) {
            toasts.shift()
          }

          // 同步沉淀到通知历史（消息中心可回看，仅存可序列化字段，不含 action 函数）
          const record: NotificationRecord = {
            id,
            type: newToast.type,
            title: newToast.title,
            message: newToast.message,
            timestamp: Date.now(),
            read: false,
            sessionId: newToast.sessionId,
          }
          const notifications = [...state.notifications, record]
          if (notifications.length > MAX_NOTIFICATIONS) {
            notifications.shift()
          }

          return { toasts, notifications }
        })

        // 自动移除（仅清理活跃 Toast，历史记录保留）
        if (newToast.duration && newToast.duration > 0) {
          const timerId = setTimeout(() => {
            get().removeToast(id)
          }, newToast.duration)
          toastTimers.set(id, timerId)
        }

        return id
      },

      removeToast: (id) => {
        const timer = toastTimers.get(id)
        if (timer) {
          clearTimeout(timer)
          toastTimers.delete(id)
        }
        set((state) => ({
          toasts: state.toasts.filter((t) => t.id !== id),
        }))
      },

      clearAll: () => {
        toastTimers.forEach((timer) => clearTimeout(timer))
        toastTimers.clear()
        set({ toasts: [] })
      },

      success: (title, message) => {
        return get().addToast({ type: 'success', title, message, duration: 3000 })
      },

      error: (title, message) => {
        return get().addToast({ type: 'error', title, message, duration: 6000 }) // 错误提示停留更长，且可手动关闭
      },

      warning: (title, message) => {
        return get().addToast({ type: 'warning', title, message, duration: 4000 })
      },

      info: (title, message) => {
        return get().addToast({ type: 'info', title, message, duration: 3000 })
      },

      sessionComplete: (title, sessionId, onSwitch) => {
        return get().addToast({
          type: 'session_complete',
          title: i18n.t('common:toast.sessionComplete', { title }),
          sessionId,
          duration: 30000, // 30 秒（原 2 分钟，缩短以减少占屏）
          action: {
            label: i18n.t('common:toast.switch'),
            onClick: onSwitch,
          },
        })
      },

      markAllNotificationsRead: () => {
        set((state) => ({
          notifications: state.notifications.map((n) => (n.read ? n : { ...n, read: true })),
        }))
      },

      clearNotifications: () => {
        set({ notifications: [] })
      },

      removeNotification: (id) => {
        set((state) => ({
          notifications: state.notifications.filter((n) => n.id !== id),
        }))
      },
    }),
    {
      name: 'toast-store',
      // 仅持久化通知历史；绝不持久化活跃 toasts（避免刷新后重弹并重新计时）
      partialize: (state) => ({ notifications: state.notifications }),
    }
  )
)

// ============================================================================
// EventBus 订阅：监听 TOAST_REQUESTED 事件
// ============================================================================

storeEventBus.on('TOAST_REQUESTED', (payload) => {
  const { message, type, duration } = payload
  useToastStore.getState().addToast({ type, title: message, duration })
})
