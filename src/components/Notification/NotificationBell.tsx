/**
 * 消息中心入口：铃铛图标 + 未读徽章
 *
 * 徽章样式复刻 ActivityBar 的 ProblemsBadge（红点 + 计数，>99 显示 99+）。
 * 点击开关消息中心面板。
 */

import { Bell } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useToastStore } from '@/stores/toastStore'
import { useViewStore } from '@/stores/viewStore'

export function NotificationBell() {
  const { t } = useTranslation('common')
  const unreadCount = useToastStore((s) =>
    s.notifications.reduce((acc, n) => (n.read ? acc : acc + 1), 0)
  )
  const showNotificationCenter = useViewStore((s) => s.showNotificationCenter)
  const toggleNotificationCenter = useViewStore((s) => s.toggleNotificationCenter)

  return (
    <button
      onClick={toggleNotificationCenter}
      className={`relative p-1.5 rounded-md transition-colors ${
        showNotificationCenter
          ? 'text-primary bg-primary/10 hover:bg-primary/20'
          : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
      }`}
      title={t('notificationCenter.bell')}
      data-tauri-drag-region={false}
    >
      <Bell className="w-4 h-4" />
      {unreadCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white bg-danger">
          {unreadCount > 99 ? '99+' : unreadCount}
        </span>
      )}
    </button>
  )
}
