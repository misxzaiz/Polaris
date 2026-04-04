/**
 * SessionListItem - 会话列表项组件
 */

import { cn } from '@/utils/cn'
import { StatusDot } from './StatusDot'
import type { ChatSession } from '@/types/session'

interface SessionListItemProps {
  session: ChatSession
  workspaceName?: string
  isActive?: boolean
  onClick: () => void
}

/**
 * 格式化时间为相对时间
 */
function formatTimeAgo(dateStr: string | null): string {
  if (!dateStr) return ''

  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMinutes = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffMinutes < 1) return '刚刚'
  if (diffMinutes < 60) return `${diffMinutes}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays < 7) return `${diffDays}天前`

  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}

export function SessionListItem({
  session,
  workspaceName,
  isActive = false,
  onClick,
}: SessionListItemProps) {
  const timeAgo = formatTimeAgo(session.lastMessageAt || session.updatedAt)

  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full px-3 py-2 rounded-lg text-left transition-colors',
        'flex items-center gap-2.5',
        isActive
          ? 'bg-primary/10 text-primary border border-primary/20'
          : 'hover:bg-background-hover text-text-secondary hover:text-text-primary'
      )}
    >
      {/* 状态指示器 */}
      <StatusDot status={session.status} size="sm" />

      {/* 会话信息 */}
      <div className="flex-1 min-w-0">
        {/* 标题 */}
        <div className={cn(
          'text-sm font-medium truncate',
          isActive ? 'text-primary' : 'text-text-primary'
        )}>
          {session.title}
        </div>

        {/* 元信息：工作区 + 时间 */}
        <div className="flex items-center gap-2 mt-0.5 text-xs text-text-tertiary">
          {workspaceName && (
            <span className="truncate max-w-[100px]">
              {workspaceName}
            </span>
          )}
          {timeAgo && (
            <span className="shrink-0">
              {timeAgo}
            </span>
          )}
        </div>
      </div>

      {/* 消息数量 */}
      {session.messageCount > 0 && (
        <span className={cn(
          'text-xs px-1.5 py-0.5 rounded-full shrink-0',
          isActive
            ? 'bg-primary/20 text-primary'
            : 'bg-background-surface text-text-tertiary'
        )}>
          {session.messageCount}
        </span>
      )}
    </button>
  )
}