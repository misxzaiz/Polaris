/**
 * NavigationButton - 导航按钮组件（预留）
 *
 * 用于切换上一个/下一个会话
 */

import { memo } from 'react'
import { cn } from '@/utils/cn'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface NavigationButtonProps {
  direction: 'prev' | 'next'
  disabled?: boolean
  onClick?: () => void
}

export const NavigationButton = memo(function NavigationButton({
  direction,
  disabled = true,
  onClick,
}: NavigationButtonProps) {
  const Icon = direction === 'prev' ? ChevronLeft : ChevronRight

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-center justify-center w-7 h-7 rounded-full',
        'text-text-muted transition-colors',
        disabled
          ? 'opacity-40 cursor-not-allowed'
          : 'hover:bg-background-hover hover:text-text-secondary'
      )}
      title={direction === 'prev' ? '上一个会话' : '下一个会话'}
    >
      <Icon className="w-4 h-4" />
    </button>
  )
})