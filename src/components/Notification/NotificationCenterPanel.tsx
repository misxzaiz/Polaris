/**
 * 消息中心面板
 *
 * 沉淀展示所有通知历史（来自 toastStore.notifications），支持回看详情、全部已读、清空。
 * 打开瞬间记录未读项用于本次高亮，随后立即清零未读计数；
 * 会话完成类通知保留「切换会话」操作。
 * 面板结构参考 SessionHistoryPanel（header + 可滚动列表 + 空态）。
 */

import { useEffect, useRef, type ElementType } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, XCircle, AlertTriangle, Info, X, Trash2, CheckCheck, Inbox } from 'lucide-react'
import { useToastStore, type ToastType, type NotificationRecord } from '@/stores/toastStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { cn } from '@/utils/cn'

const iconMap: Record<ToastType, ElementType> = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
  session_complete: CheckCircle,
}

const colorMap: Record<ToastType, string> = {
  success: 'text-success',
  error: 'text-danger',
  warning: 'text-warning',
  info: 'text-primary',
  session_complete: 'text-success',
}

interface NotificationCenterPanelProps {
  onClose?: () => void
}

export function NotificationCenterPanel({ onClose }: NotificationCenterPanelProps) {
  const { t } = useTranslation('common')
  const notifications = useToastStore((s) => s.notifications)
  const markAllNotificationsRead = useToastStore((s) => s.markAllNotificationsRead)
  const clearNotifications = useToastStore((s) => s.clearNotifications)

  // 打开瞬间的未读集合：用于本次高亮「新」消息；随后立即清零未读计数（铃铛徽章归零）
  const newIdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const unread = useToastStore.getState().notifications.filter((n) => !n.read)
    newIdsRef.current = new Set(unread.map((n) => n.id))
    if (unread.length > 0) {
      markAllNotificationsRead()
    }
  }, [markAllNotificationsRead])

  const formatTime = (ts: number) => {
    const diffMs = Date.now() - ts
    const mins = Math.floor(diffMs / 60000)
    const hours = Math.floor(diffMs / 3600000)
    const days = Math.floor(diffMs / 86400000)
    if (mins < 1) return t('notificationCenter.justNow')
    if (mins < 60) return t('notificationCenter.minutesAgo', { count: mins })
    if (hours < 24) return t('notificationCenter.hoursAgo', { count: hours })
    return t('notificationCenter.daysAgo', { count: days })
  }

  const handleSwitch = (n: NotificationRecord) => {
    if (n.sessionId) {
      sessionStoreManager.getState().switchSession(n.sessionId)
    }
    onClose?.()
  }

  // 倒序展示（最新在最上）
  const items = [...notifications].reverse()

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text-primary">{t('notificationCenter.title')}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={markAllNotificationsRead}
            disabled={notifications.length === 0}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('notificationCenter.markAllRead')}
          >
            <CheckCheck className="w-4 h-4" />
          </button>
          <button
            onClick={clearNotifications}
            disabled={notifications.length === 0}
            className="p-1.5 rounded-md text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('notificationCenter.clear')}
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
            title={t('toast.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 通知列表 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {items.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-text-tertiary">
            <Inbox className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">{t('notificationCenter.empty')}</p>
          </div>
        ) : (
          <ul>
            {items.map((n, index) => {
              const Icon = iconMap[n.type]
              const isNew = newIdsRef.current.has(n.id)
              return (
                <li
                  key={n.id}
                  className={cn(
                    'flex items-start gap-3 px-4 py-3 transition-colors hover:bg-background-hover',
                    index > 0 && 'border-t border-border-subtle',
                    isNew && 'bg-primary/5'
                  )}
                >
                  <Icon className={cn('w-4 h-4 shrink-0 mt-0.5', colorMap[n.type])} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-text-primary break-words">{n.title}</div>
                    {n.message && (
                      <div className="text-xs text-text-secondary mt-0.5 break-words">{n.message}</div>
                    )}
                    <div className="text-[11px] text-text-tertiary mt-1">{formatTime(n.timestamp)}</div>
                  </div>
                  {n.type === 'session_complete' && n.sessionId && (
                    <button
                      onClick={() => handleSwitch(n)}
                      className="shrink-0 self-center px-2 py-1 text-xs font-medium rounded bg-primary/20 text-primary hover:bg-primary/30 transition-colors"
                    >
                      {t('notificationCenter.switch')}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
