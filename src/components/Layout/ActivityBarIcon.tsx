/**
 * ActivityBarIcon - Activity Bar 图标按钮组件
 *
 * 单个图标按钮,支持 active 状态和 hover 效果
 * 尺寸: 24×24px, 图标 14px
 */

import { ReactNode, forwardRef } from 'react'

interface ActivityBarIconProps {
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  active?: boolean
  onClick: () => void
  className?: string
  children?: ReactNode
}

export const ActivityBarIcon = forwardRef<HTMLButtonElement, ActivityBarIconProps>(
  ({ icon: Icon, label, active = false, onClick, className, children }, ref) => {
    // 构建 class 字符串
    const buttonClasses = [
      // 基础样式: 24x24 超紧凑尺寸
      'relative w-6 h-6 mx-1 mb-px rounded-md flex items-center justify-center',
      'transition-all duration-150',
      // Hover 效果
      'hover:bg-background-hover',
      // Active 状态
      active ? 'bg-background-surface' : '',
      // Active 状态的左侧指示条
      active ? 'before:absolute before:left-0 before:top-0.5 before:bottom-0.5 before:w-0.5 before:bg-primary before:rounded-l' : '',
      // 自定义类名
      className,
    ]
      .filter(Boolean)
      .join(' ')

    const iconClasses = [
      'transition-colors duration-150',
      active ? 'text-primary' : 'text-text-secondary',
      'hover:text-text-primary',
    ].join(' ')

    return (
      <button
        ref={ref}
        onClick={onClick}
        className={buttonClasses}
        title={label}
        aria-label={label}
        aria-pressed={active}
      >
        {/* 图标 14px */}
        <Icon size={14} className={iconClasses} />

        {/* 可选的子元素 (如徽章等) */}
        {children}
      </button>
    )
  }
)

ActivityBarIcon.displayName = 'ActivityBarIcon'
