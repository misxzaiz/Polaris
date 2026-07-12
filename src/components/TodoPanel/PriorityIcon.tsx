/**
 * PriorityIcon - 优先级图标组件
 *
 * 使用 Lucide 图标替换 emoji
 * 颜色统一接入语义化 token（与 RequirementPanel 共享 priority-* 调色板）
 */

import { AlertCircle, AlertTriangle, Circle, MinusCircle } from 'lucide-react'
import type { TodoPriority } from '@/types'

interface PriorityIconProps {
  priority: TodoPriority
  size?: number
  className?: string
}

export function PriorityIcon({ priority, size = 14, className = '' }: PriorityIconProps) {
  const iconMap = {
    urgent: (
      <AlertCircle
        size={size}
        className={`text-priority-urgent ${className}`}
      />
    ),
    high: (
      <AlertTriangle
        size={size}
        className={`text-priority-high ${className}`}
      />
    ),
    normal: (
      <Circle
        size={size}
        className={`text-priority-normal ${className}`}
      />
    ),
    low: (
      <MinusCircle
        size={size}
        className={`text-priority-low ${className}`}
      />
    ),
  }

  return iconMap[priority] || iconMap.normal
}
