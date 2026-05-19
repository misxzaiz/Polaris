/**
 * LayoutDndProvider - 布局拖拽全局上下文
 *
 * 职责:
 * - 提供 DndContext 包裹整个 LayoutShell + ActivityBar
 * - 配置 sensors: PointerSensor (鼠标/触摸) + KeyboardSensor (a11y)
 * - 渲染 DragOverlay (拖拽时跟随光标的缩略预览)
 * - 监听 DragEndEvent → 调用 handleLayoutDragEnd 触发 store 变更 + toast 反馈
 *
 * 拖拽不影响内容区交互: SlotPanel 的 aside 是 useDroppable 但不阻塞 pointer events,
 * 内部 Virtuoso/CodeMirror 仍可正常滚动/编辑.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { useLayoutStore } from '@/stores/layoutStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { useToastStore } from '@/stores/toastStore'
import { handleLayoutDragEnd, isDragData, type DragData } from './dnd'
import { SpatialDropOverlay } from './SpatialDropOverlay'
import type { ModuleId, SlotId } from '@/types/layout'

interface LayoutDndProviderProps {
  children: React.ReactNode
}

export function LayoutDndProvider({ children }: LayoutDndProviderProps) {
  const { t } = useTranslation('layout')
  const [activeData, setActiveData] = useState<DragData | null>(null)
  const toast = useToastStore()

  // PointerSensor 8px 移动阈值: 防止短点击被误判为拖拽
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragStart = (event: DragStartEvent) => {
    if (isDragData(event.active.data.current)) {
      setActiveData(event.active.data.current)
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveData(null)
    const { active, over } = event
    const slots = useLayoutStore.getState().slots
    const actions = {
      addModuleToSlot: useLayoutStore.getState().addModuleToSlot,
      moveModule: useLayoutStore.getState().moveModule,
      reorderModuleInSlot: useLayoutStore.getState().reorderModuleInSlot,
      setSlotActive: useLayoutStore.getState().setSlotActive,
    }

    // 基于 PluginViewContribution.allowedSlots 校验目标槽位是否允许该模块.
    // 未声明 allowedSlots 的模块视为无约束 (兼容).
    const isSlotAllowed = (moduleId: ModuleId, slot: SlotId): boolean => {
      const contribution = pluginRegistry
        .listViewContributions('activityBar')
        .find((c) => c.moduleId === moduleId)
      if (!contribution?.allowedSlots) return true
      return contribution.allowedSlots.includes(slot)
    }

    // 基于 PluginViewContribution.bareRender 强制独占语义.
    const isModuleBareRender = (moduleId: ModuleId): boolean => {
      const contribution = pluginRegistry
        .listViewContributions('activityBar')
        .find((c) => c.moduleId === moduleId)
      return contribution?.bareRender ?? false
    }

    const result = handleLayoutDragEnd({
      active: { id: String(active.id), data: active.data.current },
      over: over
        ? { id: String(over.id), data: over.data.current }
        : null,
      slots,
      actions,
      isSlotAllowed,
      isModuleBareRender,
    })

    // toast 反馈:
    //   - add/move 提示动作完成
    //   - rejected 显式告知用户为什么没生效 (allowedSlots 拒绝)
    //   - reorder/noop 静默 (太频繁会嘈杂)
    if (result === 'add') {
      toast.success(t('dnd.added'))
    } else if (result === 'move') {
      toast.success(t('dnd.moved'))
    } else if (result === 'rejected') {
      toast.warning(t('dnd.rejected'))
    }
  }

  const handleDragCancel = () => {
    setActiveData(null)
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      {children}
      {/* V2: 全屏 4 落点 ghost overlay, 拖动 200ms 后激活. 仅视觉, 不引入新 droppable. */}
      <SpatialDropOverlay />
      <DragOverlay dropAnimation={null}>
        {activeData ? <DragPreview data={activeData} /> : null}
      </DragOverlay>
    </DndContext>
  )
}

// ============================================================
// DragPreview - 拖拽中显示的浮动模块缩略
// ============================================================
function DragPreview({ data }: { data: DragData }) {
  const { t } = useTranslation('common')
  const contributions = pluginRegistry.listViewContributions('activityBar')
  const contribution = contributions.find((v) => v.moduleId === data.moduleId)
  const Icon = contribution ? pluginIconMap[contribution.icon] : null
  const label = contribution
    ? t(contribution.labelKey, { defaultValue: contribution.labelDefault ?? data.moduleId })
    : data.moduleId

  return (
    <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-primary text-white text-sm font-medium shadow-glow border border-primary/60 cursor-grabbing">
      {Icon && <Icon size={14} />}
      <span>{label}</span>
    </div>
  )
}
