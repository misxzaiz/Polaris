/**
 * Toast 通知组件
 */

import { useTranslation } from 'react-i18next'
import { CheckCircle, XCircle, AlertTriangle, Info, X } from 'lucide-react'
import { useToastStore, ToastType } from '@/stores/toastStore'

const iconMap: Record<ToastType, React.ElementType> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
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
}

export function ToastContainer() {
  const { toasts, removeToast } = useToastStore()

  if (toasts.length === 0) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onClose={() => removeToast(toast.id)} />
      ))}
    </div>
  )
}

interface ToastItemProps {
  toast: {
    id: string
    type: ToastType
    title: string
    message?: string
  }
  onClose: () => void
}

function ToastItem({ toast, onClose }: ToastItemProps) {
  const { t } = useTranslation('common')
  const Icon = iconMap[toast.type]
  const colors = colorMap[toast.type]

  return (
    <div
      className={`
        flex items-start gap-3 p-3 rounded-lg border shadow-lg
        ${colors.bg} ${colors.border}
        animate-slide-in-right
      `}
      role="alert"
    >
      <Icon size={18} className={`shrink-0 mt-0.5 ${colors.icon}`} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-text-primary">{toast.title}</div>
        {toast.message && (
          <div className="text-xs text-text-secondary mt-0.5 break-all">{toast.message}</div>
        )}
      </div>
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
