/**
 * StatusSymbol - 状态几何符号
 *
 * 使用几何图形表示会话状态，而非简单的圆点
 * 太空舱控制面板风格
 */

import { cn } from '@/utils/cn'
import type { SessionStatus } from '@/types/session'

interface StatusSymbolProps {
  status: SessionStatus
  size?: 'sm' | 'md'
  className?: string
}

const sizeConfig = {
  sm: {
    container: 'w-3 h-3',
    lineWidth: 'w-1.5 h-0.5',
    ringSize: 'w-2 h-2',
    dotSize: 'w-1 h-1',
    rectSize: 'w-2 h-1',
  },
  md: {
    container: 'w-4 h-4',
    lineWidth: 'w-2.5 h-0.5',
    ringSize: 'w-3 h-3',
    dotSize: 'w-1.5 h-1.5',
    rectSize: 'w-3 h-1.5',
  },
}

const statusConfig: Record<SessionStatus, { color: string; glow?: string }> = {
  idle: { color: 'bg-text-muted' },
  running: { color: 'bg-success', glow: 'shadow-[0_0_6px_rgba(52,211,153,0.5)]' },
  waiting: { color: 'bg-info', glow: 'shadow-[0_0_6px_rgba(96,165,250,0.5)]' },
  error: { color: 'bg-danger', glow: 'shadow-[0_0_6px_rgba(248,113,113,0.5)]' },
  'background-running': { color: 'bg-text-tertiary', glow: 'shadow-[0_0_4px_rgba(142,142,147,0.3)]' },
}

export function StatusSymbol({ status, size = 'sm', className }: StatusSymbolProps) {
  const config = sizeConfig[size]
  const { glow } = statusConfig[status]

  // 不同状态使用不同几何形状
  switch (status) {
    case 'running':
      // 旋转中的圆环（带脉冲效果）
      return (
        <div className={cn(config.container, 'relative flex items-center justify-center', className)}>
          <div
            className={cn(
              config.ringSize,
              'rounded-full',
              'border-2 border-success',
              'animate-spin',
              glow
            )}
            style={{ animationDuration: '2s' }}
          />
          {/* 中心发光点 */}
          <div className={cn(config.dotSize, 'rounded-full bg-success absolute', glow)} />
        </div>
      )

    case 'waiting':
      // 等待中的脉冲点（呼吸灯效果）
      return (
        <div className={cn(config.container, 'relative flex items-center justify-center', className)}>
          <div
            className={cn(
              config.dotSize,
              'rounded-full bg-info',
              'animate-pulse',
              glow
            )}
          />
          {/* 外圈 */}
          <div
            className={cn(
              config.ringSize,
              'rounded-full',
              'border border-info/30',
              'absolute'
            )}
          />
        </div>
      )

    case 'error':
      // 错误：菱形警告符号
      return (
        <div className={cn(config.container, 'relative flex items-center justify-center', className)}>
          <div
            className={cn(
              config.dotSize,
              'bg-danger',
              '[clip-path:polygon(50%_0%,_100%_50%,_50%_100%,_0%_50%)]',
              glow
            )}
          />
        </div>
      )

    case 'background-running':
      // 后台运行：虚线圆环
      return (
        <div className={cn(config.container, 'relative flex items-center justify-center', className)}>
          <div
            className={cn(
              config.ringSize,
              'rounded-full',
              'border border-text-tertiary/60',
              'border-dashed',
              glow
            )}
          />
        </div>
      )

    case 'idle':
    default:
      // 空闲：简单横线（休眠状态）
      return (
        <div className={cn(config.container, 'flex items-center justify-center', className)}>
          <div className={cn(config.lineWidth, 'rounded-full bg-text-muted')} />
        </div>
      )
  }
}