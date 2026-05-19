/**
 * ModuleTabBar - 槽位内的模块切换 Tab (含拖拽)
 *
 * 与 CenterStage 的 TabBar 不同:
 * - 这是"模块级"Tab(静态绑定到槽位,无 close/dirty/right-click)
 * - CenterStage 的 TabBar 是"文件级"Tab(动态打开/关闭,有未保存指示)
 *
 * 拖拽:
 * - 每个 Tab 同时是 useSortable (同槽位拖拽排序) 和被 LayoutDndProvider 接收
 *   (跨槽位移动)。
 * - SortableContext 仅在该 slot 范围内有效,DragEndEvent 由全局 DndContext 处理.
 * - 内容区不参与拖拽,确保 Virtuoso/CodeMirror 不受干扰.
 *
 * V2 升级:
 * - 加 trailing prop, 接收右侧工具按钮区 (设置/分离窗口/更多等)
 * - 高度对齐 var(--module-header-h) (36px), 跟 ModuleShell.ModuleHeader 一致
 * - 单模块仍返回 null (由 SlotPanel/ModuleShell.ModuleHeader 接管标题)
 */

import { useTranslation } from 'react-i18next'
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { ReactNode } from 'react'
import { useLayoutStore } from '@/stores/layoutStore'
import { pluginRegistry, pluginIconMap } from '@/plugin-system'
import type { ModuleId, SlotId } from '@/types/layout'
import { tabDraggableId, type DragData } from './dnd'

interface ModuleTabBarProps {
  slot: SlotId
  /** V2: 右侧 trailing actions 区 (悬浮工具按钮组) */
  trailing?: ReactNode
  className?: string
}

export function ModuleTabBar({ slot, trailing, className = '' }: ModuleTabBarProps) {
  const slotState = useLayoutStore((s) => s.slots[slot])

  if (slotState.modules.length <= 1) return null

  const sortableIds = slotState.modules.map((m) => tabDraggableId(slot, m))

  return (
    <div
      className={`flex items-center gap-0.5 px-2 bg-background-surface border-b border-border-subtle overflow-x-auto shrink-0 ${className}`}
      style={{ height: 'var(--module-header-h)' }}
    >
      <SortableContext items={sortableIds} strategy={horizontalListSortingStrategy}>
        {slotState.modules.map((moduleId) => (
          <SortableTab key={moduleId} slot={slot} moduleId={moduleId} />
        ))}
      </SortableContext>
      {trailing && <div className="ml-auto flex items-center gap-0.5 shrink-0">{trailing}</div>}
    </div>
  )
}

// ============================================================
// SortableTab - 单个可拖拽的 Tab
// ============================================================
interface SortableTabProps {
  slot: SlotId
  moduleId: ModuleId
}

function SortableTab({ slot, moduleId }: SortableTabProps) {
  const { t } = useTranslation('common')
  const slotState = useLayoutStore((s) => s.slots[slot])
  const setSlotActive = useLayoutStore((s) => s.setSlotActive)

  const dragData: DragData = { type: 'tab', slotId: slot, moduleId }
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: tabDraggableId(slot, moduleId),
    data: dragData,
  })

  const isActive = moduleId === slotState.activeModule
  const contributions = pluginRegistry.listViewContributions('activityBar')
  const contribution = contributions.find((v) => v.moduleId === moduleId)
  const Icon = contribution ? pluginIconMap[contribution.icon] : null
  const label = contribution
    ? t(contribution.labelKey, { defaultValue: contribution.labelDefault ?? moduleId })
    : moduleId

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }

  return (
    <button
      ref={setNodeRef}
      style={style}
      type="button"
      onClick={() => setSlotActive(slot, moduleId)}
      {...attributes}
      {...listeners}
      className={`flex items-center gap-1.5 h-7 px-2.5 rounded text-xs font-medium transition-colors whitespace-nowrap touch-none select-none ${
        isActive
          ? 'bg-background-base text-text-primary border-t-2 border-primary -mt-px'
          : 'text-text-secondary hover:text-text-primary hover:bg-background-hover'
      } ${isDragging ? 'cursor-grabbing' : 'cursor-grab'}`}
    >
      {Icon && <Icon size={14} className="shrink-0 pointer-events-none" />}
      <span className="pointer-events-none">{label}</span>
    </button>
  )
}
