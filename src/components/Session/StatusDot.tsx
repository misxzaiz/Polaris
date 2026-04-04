/**
 * StatusDot - 会话状态指示器
 */

import { cn } from '@/utils/cn'
import type { SessionStatus } from '@/types/session'

interface StatusDotProps {
  status: SessionStatus
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const sizeClasses = {
  sm: 'w-2 h-2',
  md: 'w-2.5 h-2.5',
  lg: 'w-3 h-3',
}

const statusClasses: Record<SessionStatus, string> = {
  idle: 'bg-muted-foreground',
  running: 'bg-green-500 animate-pulse',
  waiting: 'bg-sky-500',
  error: 'bg-red-500',
}

export function StatusDot({ status, size = 'md', className }: StatusDotProps) {
  return (
    <span
      className={cn(
        'rounded-full shrink-0',
        sizeClasses[size],
        statusClasses[status],
        className
      )}
      title={status === 'idle' ? '空闲' : status === 'running' ? '运行中' : status === 'waiting' ? '等待输入' : '错误'}
    />
  )
}
