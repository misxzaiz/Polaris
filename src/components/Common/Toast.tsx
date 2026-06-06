/**
 * Toast 通知组件
 */

import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import { useToastStore, ToastType } from '@/stores/toastStore'
import { cn } from '@/utils/cn'

const iconMap: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  session_complete: CheckCircle,
}

const colorMap: Record<ToastType, { bg: string; border: string; icon: string }> = {
  success: {
    bg: 'bg-success/10',
    border: 'border-success/30',
    icon: 'text-success',
  },
  error: {
    bg: 'bg-danger/10',
    border: 'border-danger/30',
    icon: 'text-danger',
  },
  warning: {
    bg: 'bg-warning/10',
    border: 'border-warning/30',
    icon: 'text-warning',
  },
  info: {
    bg: 'bg-primary/10',
    border: 'border-primary/30',
    icon: 'text-primary',
  },
  session_complete: {
    bg: 'bg-success/10',
    border: 'border-success/30',
    icon: 'text-success',
  },
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  // 通过 Portal 渲染到 body，使用 fixed + 最高层级 z-[10000]，
  // 确保 Toast 浮于设置页、各类 Modal 之上，且不受视图切换（如打开设置页）影响而被卸载。
  // 容器本身 pointer-events-none，仅 Toast 卡片可交互，避免遮挡下方 UI 点击。
  return createPortal(
    <div className="fixed top-4 right-4 z-[10000] flex flex-col gap-2 max-w-sm w-max pointer-events-none [&>*]:pointer-events-auto">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>,
    document.body
  )
}

interface ToastItemProps {
  toast: {
    id: string
    type: ToastType
    title: string
    message?: string
    action?: {
      label: string
      onClick: () => void
    }
  }
  onClose: () => void
}

function ToastItem({ toast, onClose }: ToastItemProps) {
  const { t } = useTranslation('common')
  const Icon = iconMap[toast.type]
  const colors = colorMap[toast.type]

  return (
    <div
      className={cn(
        'flex items-start gap-3 p-3 rounded-lg border shadow-lg',
        colors.bg,
        colors.border,
        'animate-slide-in-right',
        toast.type === 'session_complete' && 'min-w-[280px]'
      )}
      role="alert"
    >
      <Icon size={18} className={cn('shrink-0 mt-0.5', colors.icon)} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{toast.title}</div>
        {toast.message && (
          <div className="text-xs text-text-secondary mt-0.5 break-all">{toast.message}</div>
        )}
      </div>
      {toast.action && (
        <button
          onClick={() => {
            toast.action?.onClick()
            onClose()
          }}
          className="shrink-0 px-2 py-1 text-xs font-medium rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
        >
          {toast.action.label}
        </button>
      )}
      <button
        onClick={onClose}
        className="shrink-0 p-1 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-colors"
        aria-label={t('toast.close')}
      >
        <X size={14} />
      </button>
    </div>
  )
}
