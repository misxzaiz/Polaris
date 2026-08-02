/**
 * QuickSwitchTrigger - 快速切换触发器组件
 *
 * 右侧贴边的控制面板触发器 - 太空舱拨片开关风格
 */

import { memo } from 'react'
import { cn } from '@/utils/cn'
import { StatusSymbol } from './StatusSymbol'
import type { SessionStatus } from '@/types/session'

interface QuickSwitchTriggerProps {
  /** 当前会话状态 */
  status: SessionStatus
  /** 是否悬停中 */
  isHovering: boolean
  /** 悬停进入回调 */
  onMouseEnter: () => void
  /** 悬停离开回调 */
  onMouseLeave: () => void
}

export const QuickSwitchTrigger = memo(function QuickSwitchTrigger({
  status,
  isHovering,
  onMouseEnter,
  onMouseLeave,
}: QuickSwitchTriggerProps) {
  return (
    <div
      className={cn(
        // 尺寸：贴边胶囊，与其他导航一致
        'w-7 h-12 -mr-3',
        // 位置
        'relative',
        // 交互
        'cursor-pointer',
        // 过渡动画
        'transition-all duration-200 ease-out'
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 贴边玻璃风格主体 */}
      <div
        className={cn(
          'absolute inset-0',
          // 玻璃风格，与其他导航统一
          'rounded-l-xl',
          'bg-background-elevated/85 backdrop-blur-xl',
          'border border-border/50 border-r-0',
          'shadow-lg shadow-black/5',
          // 过渡
          'transition-all duration-200',
          // 悬停效果
          isHovering && 'bg-background-elevated/95 shadow-xl'
        )}
      />

      {/* 状态边缘发光线 */}
      <div
        className={cn(
          'absolute left-0 top-2 bottom-2 w-0.5 rounded-l',
          'transition-all duration-300',
          // 根据状态显示不同颜色
          status === 'running' && 'bg-success shadow-[0_0_6px_rgba(52,211,153,0.5)]',
          status === 'waiting' && 'bg-info shadow-[0_0_6px_rgba(96,165,250,0.5)]',
          status === 'error' && 'bg-danger shadow-[0_0_6px_rgba(248,113,113,0.5)]',
          status === 'idle' && 'bg-text-muted',
          status === 'background-running' && 'bg-text-tertiary shadow-[0_0_4px_rgba(142,142,147,0.3)]'
        )}
      />

      {/* 内容区域 - 切换图标 */}
      <div
        className={cn(
          'absolute inset-0',
          'flex flex-col items-center justify-center gap-1',
          'transition-transform duration-200',
          isHovering && 'scale-110'
        )}
      >
        {/* 状态几何符号 */}
        <StatusSymbol status={status} size="sm" />

        {/* 切换指示图标 - 双箭头样式 */}
        <div className="flex items-center gap-0.5">
          <div className="w-0 h-0 border-t-[3px] border-t-transparent border-r-[3px] border-r-text-muted border-b-[3px] border-b-transparent" />
          <div className="w-0 h-0 border-t-[3px] border-t-transparent border-l-[3px] border-l-text-muted border-b-[3px] border-b-transparent" />
        </div>
      </div>
    </div>
  )
})
