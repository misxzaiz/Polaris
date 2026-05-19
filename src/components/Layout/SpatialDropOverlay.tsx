/**
 * SpatialDropOverlay — V2 拖拽 2.0 空间编排模式
 *
 * 在 LayoutDndProvider 范围内 mount, 拖动开始 200ms 后激活, 渲染 4 个落点 ghost
 * 与 1 个跟随光标的"目标提示卡". 视觉指引为主, 不引入新 droppable —
 * 拖放行为仍由 SlotPanel 的 droppable 与 handleLayoutDragEnd 决定.
 *
 * 设计要点:
 *  - pointer-events: none 整体, 让光标穿透到下面的 droppable
 *  - 4 个 ghost (left/right/center/bottom) 用 CSS Grid 占位, 各自标注槽位名 + 当前尺寸
 *  - 200ms 延迟激活避免误触 (Cmd+K-style 短点击不该触发 overlay)
 *  - 光标边出现一个浮动 tip card, 显示当前 over 的目标
 *  - <html data-spatial-drag> 属性可被组件配套 CSS 消费 (例如 SlotPanel 加强高亮)
 *
 * 与现有 V1 的关系:
 *  - V1 已有 SlotPanel.showDropHint (ring + glow), V2 overlay 是其上方的"全屏标签层"
 *  - V1 已有 LayoutDndProvider.DragOverlay (跟随光标的模块缩略), V2 overlay 与之并行不冲突
 */

import { useEffect, useState } from 'react'
import { useDndMonitor } from '@dnd-kit/core'
import { useTranslation } from 'react-i18next'
import { useLayoutStore } from '@/stores/layoutStore'
import { isDragData, type DragData } from './dnd'
import type { SlotId } from '@/types/layout'

const ACTIVATION_DELAY = 200

interface OverSlot {
  slotId: SlotId
}

function parseOverId(overId: string | null): OverSlot | null {
  if (!overId) return null
  if (overId.startsWith('slot:')) {
    const slotId = overId.slice(5) as SlotId
    if (['left', 'right', 'center', 'bottom'].includes(slotId)) {
      return { slotId }
    }
  }
  if (overId.startsWith('tab:')) {
    // 'tab:<slot>:<moduleId>'
    const parts = overId.split(':')
    if (parts.length >= 2) {
      const slotId = parts[1] as SlotId
      if (['left', 'right', 'center', 'bottom'].includes(slotId)) {
        return { slotId }
      }
    }
  }
  return null
}

/**
 * 4 落点 ghost overlay. 在 LayoutDndProvider 内部使用 (能访问到 DndContext).
 *
 * 注意: 必须放在 DndContext 子树中, 才能用 useDndMonitor.
 */
export function SpatialDropOverlay() {
  const { t } = useTranslation('layout')
  const [activeDrag, setActiveDrag] = useState<DragData | null>(null)
  const [visible, setVisible] = useState(false)
  const [overSlotId, setOverSlotId] = useState<SlotId | null>(null)
  const slots = useLayoutStore((s) => s.slots)

  useDndMonitor({
    onDragStart: (event) => {
      if (isDragData(event.active.data.current)) {
        setActiveDrag(event.active.data.current)
      }
    },
    onDragMove: (event) => {
      const over = parseOverId(event.over ? String(event.over.id) : null)
      setOverSlotId(over?.slotId ?? null)
    },
    onDragEnd: () => {
      setActiveDrag(null)
      setVisible(false)
      setOverSlotId(null)
    },
    onDragCancel: () => {
      setActiveDrag(null)
      setVisible(false)
      setOverSlotId(null)
    },
  })

  // 200ms 延迟激活, 避免短点击/滑动误触
  useEffect(() => {
    if (!activeDrag) {
      setVisible(false)
      return
    }
    const timer = window.setTimeout(() => setVisible(true), ACTIVATION_DELAY)
    return () => window.clearTimeout(timer)
  }, [activeDrag])

  // 同步 html data 属性 (供 CSS 消费, 例如可以让 SlotPanel 整体降低对比度)
  useEffect(() => {
    if (typeof document === 'undefined') return
    if (visible) {
      document.documentElement.setAttribute('data-spatial-drag', '1')
    } else {
      document.documentElement.removeAttribute('data-spatial-drag')
    }
  }, [visible])

  if (!visible || !activeDrag) return null

  return (
    <div
      className="fixed inset-0 z-[60] pointer-events-none"
      role="presentation"
      aria-hidden="true"
    >
      {/* 4 落点 ghost label, 用 fixed 定位贴在屏幕 4 个区域中央 */}
      <SlotLabel
        position="left"
        active={overSlotId === 'left'}
        title={t('overlay.slotLabel.left', { defaultValue: '左侧槽位' })}
        size={slots.left.size}
      />
      <SlotLabel
        position="right"
        active={overSlotId === 'right'}
        title={t('overlay.slotLabel.right', { defaultValue: '右侧槽位' })}
        size={slots.right.size}
      />
      <SlotLabel
        position="center"
        active={overSlotId === 'center'}
        title={t('overlay.slotLabel.center', { defaultValue: '主舞台' })}
      />
      <SlotLabel
        position="bottom"
        active={overSlotId === 'bottom'}
        title={t('overlay.slotLabel.bottom', { defaultValue: '底部槽位' })}
        size={slots.bottom.size}
      />
    </div>
  )
}

interface SlotLabelProps {
  position: 'left' | 'right' | 'center' | 'bottom'
  active: boolean
  title: string
  /** 显示的尺寸 (px); 不传 (center) 则不显示 */
  size?: number
}

function SlotLabel({ position, active, title, size }: SlotLabelProps) {
  const positionStyle = (() => {
    switch (position) {
      case 'left':
        return { left: 24, top: '50%', transform: 'translateY(-50%)' as const }
      case 'right':
        return { right: 24, top: '50%', transform: 'translateY(-50%)' as const }
      case 'center':
        return { left: '50%', top: '20%', transform: 'translateX(-50%)' as const }
      case 'bottom':
        return { left: '50%', bottom: 24, transform: 'translateX(-50%)' as const }
    }
  })()

  return (
    <div
      className={`absolute pointer-events-none select-none px-3 py-1.5 rounded-md text-[11px] font-semibold tracking-wider uppercase border-2 transition-all duration-150 ${
        active
          ? 'bg-primary/20 border-primary text-primary shadow-glow scale-110'
          : 'bg-background-elevated/80 border-border-strong text-text-tertiary'
      }`}
      style={{
        ...positionStyle,
        backdropFilter: 'blur(8px)',
      }}
    >
      {title}
      {size !== undefined && size > 0 && (
        <span className="ml-2 text-text-tertiary/80 font-normal normal-case tracking-normal">
          {size}px
        </span>
      )}
    </div>
  )
}
