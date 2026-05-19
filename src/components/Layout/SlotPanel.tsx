/**
 * SlotPanel - 单槽位通用容器
 *
 * 职责:
 * - 根据 slot id 决定方向 (left/right=horizontal, bottom=vertical)
 * - 渲染 ResizeHandle (位置随槽位)
 * - 渲染 ModuleTabBar (当 modules > 1)
 * - 仅渲染当前 activeModule (非 keep-alive)
 *
 * 当 slotState.activeModule === null 或 modules.length === 0 时返回 null,
 * 让父级 Layout 不为该槽位预留空间。
 *
 * Center 槽位不走此组件,由 LayoutShell 直接编排 CenterStage / ChatModule。
 *
 * 拖拽:
 * - 整个 aside 作为 useDroppable 接收 ActivityBar/Tab 拖拽
 * - hover 时显示 ring 高亮
 * - 内容区 pointerEvents 不阻塞 (Virtuoso/CodeMirror 仍可交互)
 *
 * 性能/状态说明 (未来工作):
 *   切换 Tab 会 unmount 上一个模块。对 Terminal/Editor 这类重资源/状态敏感的模块,
 *   未来可在 PluginViewContribution 增加 keepAlive: true 标志,SlotPanel 根据此
 *   标志改用 display:none + 稳定 key 的 keep-alive 策略。本期不实现以避免引入
 *   xterm/Virtuoso 在零尺寸容器中的副作用。
 */

import { useCallback } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { useLayoutStore } from '@/stores/layoutStore'
import { ResizeHandle } from '@/components/Common'
import { ModuleRenderer } from './ModuleRenderer'
import { ModuleTabBar } from './ModuleTabBar'
import { pluginRegistry } from '@/plugin-system'
import { slotDroppableId, type DropData } from './dnd'
import type { ModuleId, SlotId } from '@/types/layout'

interface SlotPanelProps {
  slot: Exclude<SlotId, 'center'>
  className?: string
}

/** ResizeHandle 在槽位中的位置:
 *
 *   ResizeHandle 的 `position` 字段语义见 @/components/Common/ResizeHandle.tsx,
 *   简言之: 'left' = "手柄贴 panel 左边/顶部",拖拽 delta 会被取反,
 *           让 "向手柄移动" = "面板收缩"。
 *
 *   Slot 视觉 (顶层 row + center column):
 *
 *      ┌─ ActivityBar ─┐ ┌──── left ────┐ ┌─── center ───┐ ┌── right ──┐
 *      │       │       │ │       │     ││ │              │ │     │      │
 *      │       │       │ │       │  H→ ││ │              │ │ H←  │      │
 *      │       │       │ │       │     ││ │              │ │     │      │
 *      └───────┘       │ └───────┘     ││ │   bottom ↑   │ │ ────┘      │
 *                      │               ││ │ H 在顶部边    │ │            │
 *                      │               ││ │              │ │            │
 *                                       └──────────────┘
 *
 *   - left 槽位: 手柄在 panel 右边 → position='right' (delta 不取反)
 *   - right 槽位: 手柄在 panel 左边 → position='left' (delta 取反)
 *   - bottom 槽位: 手柄在 panel 顶部 → position='left' (vertical+'left' = 顶部, delta 取反)
 *
 *   这三种组合在 SlotPanel.test.tsx 的 ResizeHandle 行为部分被锁定.
 */
const HANDLE_POSITION: Record<Exclude<SlotId, 'center'>, 'left' | 'right'> = {
  left: 'right',  // 左槽位手柄贴右边
  right: 'left',  // 右槽位手柄贴左边
  bottom: 'left', // 底槽位手柄贴顶部 (vertical + 'left' = top)
}

function isModuleBareRender(moduleId: ModuleId): boolean {
  const c = pluginRegistry.listViewContributions('activityBar').find((v) => v.moduleId === moduleId)
  return c?.bareRender ?? false
}

function isModuleKeepAlive(moduleId: ModuleId): boolean {
  const c = pluginRegistry.listViewContributions('activityBar').find((v) => v.moduleId === moduleId)
  return c?.keepAlive ?? false
}

export function SlotPanel({ slot, className = '' }: SlotPanelProps) {
  const slotState = useLayoutStore((s) => s.slots[slot])
  const setSlotSize = useLayoutStore((s) => s.setSlotSize)

  const handleResize = useCallback(
    (delta: number) => setSlotSize(slot, slotState.size + delta),
    [slot, slotState.size, setSlotSize]
  )

  const dropData: DropData = { type: 'slot', slotId: slot }
  const { setNodeRef, isOver, active } = useDroppable({
    id: slotDroppableId(slot),
    data: dropData,
  })
  // 仅在有拖拽中时显示视觉反馈,避免静态时也有 ring
  const isDragging = active !== null
  const showDropHint = isOver && isDragging

  // 空槽位 ghost: 拖拽进行中且槽位无可见模块时,渲染一个占位 drop zone
  // 让用户可以把模块拖到目前折叠/为空的槽位激活它
  const isSlotEmpty = !slotState.activeModule || slotState.modules.length === 0
  if (isSlotEmpty) {
    if (!isDragging) return null
    return <GhostDropZone slot={slot} setNodeRef={setNodeRef} isOver={isOver} />
  }

  const isHorizontal = slot === 'left' || slot === 'right'
  // V2: 给 size 维度加 transition, 让 applyPreset / setSlotActive 等"非用户拖动"
  // 触发的尺寸变化走 200ms 过渡. 用户拖 ResizeHandle 期间, ResizeHandle 会给
  // <html> 挂 .layout-resizing 类, layout-tokens.css 全局 disable transition,
  // 所以实时拖动不会被过渡拖泥带水. 见 layout-tokens.css 的 html.layout-resizing 规则.
  const sizeStyle: React.CSSProperties = isHorizontal
    ? {
        width: `${slotState.size}px`,
        transition: 'width var(--motion-base) var(--ease-spatial)',
      }
    : {
        height: `${slotState.size}px`,
        transition: 'height var(--motion-base) var(--ease-spatial)',
      }

  // V2: 槽位卡片化 — 圆角 + 微差色阶, 不再用 border 区分槽位.
  // 槽位之间由 LayoutShell 的 gap 制造视觉间距, 因此各槽位都用相同的边描.
  // 早期 V1 用 border-r/border-l/border-t 在槽位毗邻处画分隔线, V2 改为整圈 ring-1.
  // 这是 V2 空间美学的核心: 模块如卡片浮在桌面.

  // 此处 slotState.activeModule 非 null (上方 isSlotEmpty 已 early return)
  const activeModule = slotState.activeModule as ModuleId
  const activeIsBare = isModuleBareRender(activeModule)

  const handleEl = (
    <ResizeHandle
      direction={isHorizontal ? 'horizontal' : 'vertical'}
      position={HANDLE_POSITION[slot]}
      onDrag={handleResize}
    />
  )

  return (
    <>
      {(slot === 'right' || slot === 'bottom') && handleEl}

      <aside
        ref={setNodeRef}
        className={`flex flex-col bg-background-elevated overflow-hidden ring-1 ring-border/40 shrink-0 relative min-w-0 min-h-0 transition-shadow ${
          showDropHint ? 'ring-2 ring-primary/60 shadow-glow' : ''
        } ${className}`}
        style={{
          ...sizeStyle,
          borderRadius: 'var(--slot-radius)',
        }}
      >
        {!activeIsBare && slotState.modules.length > 1 && <ModuleTabBar slot={slot} />}

        {/*
         * Keep-alive 策略:
         * - 非 active 且非 keepAlive 模块: 完全不渲染 (释放内存)
         * - 非 active 且 keepAlive 模块: 保持 mount, display:none (保留 xterm/编辑器状态)
         * - active 模块: display:flex 占满槽位
         * 注意: display:none 元素在 flex 容器中不占位,所以多个 keepAlive 模块叠加不影响 active 占空间
         */}
        {slotState.modules.map((moduleId) => {
          const isActive = moduleId === activeModule
          const keepAlive = isModuleKeepAlive(moduleId)
          if (!isActive && !keepAlive) return null
          return (
            <div
              key={moduleId}
              className="flex-1 min-h-0 flex flex-col transition-opacity duration-150"
              style={{ display: isActive ? 'flex' : 'none', opacity: isActive ? 1 : 0 }}
              data-module-id={moduleId}
              data-keep-alive={keepAlive ? '1' : undefined}
              aria-hidden={!isActive}
            >
              <ModuleRenderer moduleId={moduleId} />
            </div>
          )
        })}
      </aside>

      {slot === 'left' && handleEl}
    </>
  )
}

// ============================================================
// GhostDropZone - 拖拽中渲染的空槽位占位 drop zone
// ============================================================
interface GhostDropZoneProps {
  slot: Exclude<SlotId, 'center'>
  setNodeRef: (node: HTMLElement | null) => void
  isOver: boolean
}

function GhostDropZone({ slot, setNodeRef, isOver }: GhostDropZoneProps) {
  const isHorizontal = slot === 'left' || slot === 'right'
  // ghost 默认大小 (横向 80px 宽,纵向 60px 高)
  const sizeStyle: React.CSSProperties = isHorizontal
    ? { width: '80px' }
    : { height: '60px' }

  return (
    <aside
      ref={setNodeRef}
      className={`flex items-center justify-center shrink-0 border-2 border-dashed transition-colors ${
        isOver
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border-subtle bg-background-surface/50 text-text-tertiary'
      }`}
      style={{
        ...sizeStyle,
        borderRadius: 'var(--slot-radius)',
      }}
      aria-label={`Drop zone for ${slot} slot`}
    >
      <span className="text-[10px] font-medium opacity-70 select-none pointer-events-none">
        {slot}
      </span>
    </aside>
  )
}
