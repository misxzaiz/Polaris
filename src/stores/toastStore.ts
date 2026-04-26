/**
 * Toast 通知状态管理
 */

import { create } from 'zustand'
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

const MAX_TOASTS = 5

interface ToastState {
  toasts: Toast[]

  // 添加 Toast
  addToast: (toast: Omit<Toast, 'id'>) => string
  // 移除 Toast
  removeToast: (id: string) => void
  // 清除所有 Toast
  clearAll: () => void
  // 快捷方法
  success: (title: string, message?: string) => string
  error: (title: string, message?: string) => string
  warning: (title: string, message?: string) => string
  info: (title: string, message?: string) => string
  // 会话完成通知
  sessionComplete: (title: string, sessionId: string, onSwitch: () => void) => string
}

let toastId = 0

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

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
      return { toasts }
    })

    // 自动移除
    if (newToast.duration && newToast.duration > 0) {
      setTimeout(() => {
        get().removeToast(id)
      }, newToast.duration)
    }

    return id
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((t) => t.id !== id),
    }))
  },

  clearAll: () => {
    set({ toasts: [] })
  },

  success: (title, message) => {
    return get().addToast({ type: 'success', title, message })
  },

  error: (title, message) => {
    return get().addToast({ type: 'error', title, message, duration: 6000 }) // 错误提示更长
  },

  warning: (title, message) => {
    return get().addToast({ type: 'warning', title, message })
  },

  info: (title, message) => {
    return get().addToast({ type: 'info', title, message })
  },

  sessionComplete: (title, sessionId, onSwitch) => {
    return get().addToast({
      type: 'session_complete',
      title: i18n.t('common:toast.sessionComplete', { title }),
      sessionId,
      duration: 120000, // 2 分钟
      action: {
        label: i18n.t('common:toast.switch'),
        onClick: onSwitch,
      },
    })
  },
}))

// ============================================================================
// EventBus 订阅：监听 TOAST_REQUESTED 事件
// ============================================================================

storeEventBus.on('TOAST_REQUESTED', (payload) => {
  const { message, type, duration } = payload
  useToastStore.getState().addToast({ type, title: message, duration })
})
