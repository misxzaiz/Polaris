/**
 * DockItem — V2 Dock 中的单个图标按钮
 *
 * 与 V1 ActivityBarIcon 的区别:
 *   - 双行布局: 上方图标 (26px) + 下方微标签 (9px)
 *   - 角标 (badge) + 状态点 (status dot) 内置在图标右侧
 *   - 拖拽支持 (复用 @dnd-kit useDraggable)
 *   - active 指示条左侧 3px (V1 是 2px), 视觉更突出
 *
 * 视觉规范:
 *   - 宽度 var(--dock-w-expanded) - 2*4 = 48px
 *   - 高度 var(--dock-item-h) = 44px (含图标 + 标签 + padding)
 *   - 圆角 8px
 *   - active: bg-primary-soft + 左侧 3px 高亮条 + icon/label 着色为 primary
 */

import { forwardRef } from 'react'
import type { ReactNode } from 'react'
import { useDraggable } from '@dnd-kit/core'
import type { ModuleId } from '@/types/layout'
import { activityBarDraggableId, type DragData } from '@/components/Layout/dnd'

export interface DockItemProps {
  /** 模块 id, 用于 dnd 标识与 activate */
  moduleId?: ModuleId
  /** 图标 (lucide component 或 ReactNode) */
  icon: ReactNode
  /** 标签 (大写英文短词, 9px); 不传 = 不显示标签 (低段工具按钮场景) */
  label?: string
  /** active 高亮 */
  active?: boolean
  /** 点击 */
  onClick?: () => void
  /** 数字角标 (右上) */
  badge?: number | string
  /** 状态点 (右下), 颜色 token */
  statusDot?: 'online' | 'sync' | 'warning' | 'error'
  /** 可访问性提示 */
  title?: string
  /** 是否启用拖拽 (默认 true 当 moduleId 存在) */
  draggable?: boolean
}

export const DockItem = forwardRef<HTMLButtonElement, DockItemProps>(
  function DockItem(
    {
      moduleId,
      icon,
      label,
      active = false,
      onClick,
      badge,
      statusDot,
      title,
      draggable,
    },
    ref
  ) {
    const enableDrag = draggable ?? Boolean(moduleId)
    const inner = (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        title={title ?? label}
        aria-pressed={active}
        aria-label={title ?? label ?? moduleId}
        className={`group relative flex flex-col items-center justify-center w-[48px] rounded-lg select-none transition-colors duration-150 ${
          active ? 'bg-primary/15' : 'hover:bg-background-hover'
        }`}
        style={{ height: 'var(--dock-item-h)', padding: '4px 0' }}
      >
        {active && (
          <span
            aria-hidden="true"
            className="absolute left-[-7px] top-[22%] h-[56%] w-[3px] rounded-r bg-primary"
          />
        )}
        <span
          className={`relative flex items-center justify-center w-[26px] h-[26px] rounded-md transition-colors ${
            active ? 'text-primary' : 'text-text-secondary group-hover:text-text-primary'
          }`}
        >
          {icon}
          {badge !== undefined && badge !== 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white bg-status-danger ring-2 ring-background-elevated"
              aria-hidden="true"
            >
              {typeof badge === 'number' && badge > 99 ? '99+' : badge}
            </span>
          )}
          {statusDot && (
            <span
              className={`absolute -bottom-0.5 -right-0.5 w-[8px] h-[8px] rounded-full ring-2 ring-background-elevated ${
                statusDot === 'online'
                  ? 'bg-status-success'
                  : statusDot === 'sync'
                    ? 'bg-status-warning'
                    : statusDot === 'warning'
                      ? 'bg-status-warning'
                      : 'bg-status-danger'
              }`}
              aria-label={`status-${statusDot}`}
            />
          )}
        </span>
        {label && (
          <span
            className={`mt-0.5 text-[9px] font-semibold tracking-[0.3px] truncate max-w-full px-1 ${
              active ? 'text-primary' : 'text-text-tertiary'
            }`}
          >
            {label}
          </span>
        )}
      </button>
    )

    if (!enableDrag || !moduleId) return inner
    return <DraggableWrapper moduleId={moduleId}>{inner}</DraggableWrapper>
  }
)

interface DraggableWrapperProps {
  moduleId: ModuleId
  children: ReactNode
}

/**
 * DraggableWrapper - 用 useDraggable 包裹 DockItem.
 * 拖拽数据格式与 V1 ActivityBar 一致, 复用 LayoutDndProvider 的处理.
 */
function DraggableWrapper({ moduleId, children }: DraggableWrapperProps) {
  const dragData: DragData = { type: 'activity-bar', moduleId }
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: activityBarDraggableId(moduleId),
    data: dragData,
  })

  return (
    <div
      ref={setNodeRef}
      className={isDragging ? 'opacity-40' : ''}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  )
}
