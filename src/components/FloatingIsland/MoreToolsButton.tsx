/**
 * MoreToolsButton - 更多工具按钮组件（预留）
 *
 * 用于展开更多工具菜单（导出、历史等）
 */

import { memo } from 'react'
import { cn } from '@/utils/cn'
import { MoreHorizontal } from 'lucide-react'

interface MoreToolsButtonProps {
  disabled?: boolean
  onClick?: () => void
}

export const MoreToolsButton = memo(function MoreToolsButton({
  disabled = true,
  onClick,
}: MoreToolsButtonProps) {
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
      title="更多工具"
    >
      <MoreHorizontal className="w-4 h-4" />
    </button>
  )
})