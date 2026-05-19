/**
 * DetachedWindow — V2 Phase 5: 浮动模块窗口
 *
 * 渲染一个 fixed 定位的浮卡, 内容由 ModuleRenderer 提供, 拖动 title-bar
 * 可移动, 右下角 resize handle 可改尺寸. 关闭时 reattach 到指定 slot.
 *
 * 设计:
 *   - 顶部 32px title-bar: 模块图标 + 模块名 + reattach + close
 *   - 内容区充满, overflow hidden 由模块自管
 *   - 右下角 16px×16px resize trigger
 *   - 整个卡片 onMouseDown 时 bringToFront
 *   - SlotContextProvider 包裹内容, slotId=null (告知模块"我处于浮窗")
 *
 * Reattach 策略:
 *   - 用户点 reattach 按钮 → 调用 onReattach(toSlot)
 *   - 默认 reattach 到 'right' 槽 (chat 默认槽位之外的兼容位置)
 *   - 调用方负责: layoutStore.addModuleToSlot + detachedWindowStore.remove
 *   - 本组件不直接动 store, 通过 props 接收 handler, 便于命令面板复用
 */

import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Maximize2 } from 'lucide-react'
import { useDetachedWindowStore } from '@/stores/detachedWindowStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { SlotContextProvider } from '@/hooks/useSlotContext'
import { ModuleRenderer } from './ModuleRenderer'
import type { DetachedWindowState } from '@/stores/detachedWindowStore'
import type { ModuleId } from '@/types/layout'

interface DetachedWindowProps {
  window: DetachedWindowState
  onClose: (moduleId: ModuleId) => void
}

export function DetachedWindow({ window: w, onClose }: DetachedWindowProps) {
  const { t } = useTranslation('common')
  const updatePosition = useDetachedWindowStore((s) => s.updatePosition)
  const updateSize = useDetachedWindowStore((s) => s.updateSize)
  const bringToFront = useDetachedWindowStore((s) => s.bringToFront)
  const cardRef = useRef<HTMLDivElement | null>(null)

  // 拖动 title bar 移动浮窗
  const handleTitleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-titlebar-action]')) return
      e.preventDefault()
      bringToFront(w.moduleId)
      const startX = e.clientX
      const startY = e.clientY
      const startWX = w.x
      const startWY = w.y
      const onMove = (ev: MouseEvent) => {
        updatePosition(w.moduleId, startWX + (ev.clientX - startX), startWY + (ev.clientY - startY))
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [w.moduleId, w.x, w.y, bringToFront, updatePosition]
  )

  // 右下角 resize handle
  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      bringToFront(w.moduleId)
      const startX = e.clientX
      const startY = e.clientY
      const startW = w.width
      const startH = w.height
      const onMove = (ev: MouseEvent) => {
        updateSize(w.moduleId, startW + (ev.clientX - startX), startH + (ev.clientY - startY))
      }
      const onUp = () => {
        document.removeEventListener('mousemove', onMove)
        document.removeEventListener('mouseup', onUp)
      }
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
    },
    [w.moduleId, w.width, w.height, bringToFront, updateSize]
  )

  // Esc 关闭 (聚焦时)
  useEffect(() => {
    const el = cardRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.activeElement === el) {
        onClose(w.moduleId)
      }
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  }, [w.moduleId, onClose])

  const contributions = pluginRegistry.listViewContributions('activityBar')
  const contribution = contributions.find((c) => c.moduleId === w.moduleId)
  const Icon = contribution ? pluginIconMap[contribution.icon] : null
  const label = contribution
    ? t(contribution.labelKey, { defaultValue: contribution.labelDefault ?? w.moduleId })
    : w.moduleId

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label={`${label} (floating)`}
      tabIndex={-1}
      className="fixed bg-background-elevated border border-primary/40 rounded-lg shadow-2xl overflow-hidden flex flex-col ring-1 ring-primary/20"
      style={{
        left: w.x,
        top: w.y,
        width: w.width,
        height: w.height,
        zIndex: w.zIndex,
        boxShadow: '0 20px 50px rgba(0,0,0,0.6), 0 0 24px rgb(var(--c-primary) / 0.25)',
      }}
      onMouseDown={() => bringToFront(w.moduleId)}
    >
      {/* Title bar — 拖动起点 */}
      <header
        onMouseDown={handleTitleMouseDown}
        className="h-8 shrink-0 flex items-center px-3 gap-2 bg-background-surface border-b border-border-subtle cursor-move select-none"
      >
        {Icon && <Icon size={12} className="text-primary shrink-0" />}
        <span className="text-[11px] font-semibold text-text-primary truncate flex-1">
          {label}
          <span className="ml-2 text-text-tertiary font-normal">· {t('window.detached', { defaultValue: 'Floating' })}</span>
        </span>
        <button
          type="button"
          data-titlebar-action="1"
          onClick={() => onClose(w.moduleId)}
          title={t('window.reattach', { defaultValue: '还原到布局' })}
          className="w-5 h-5 rounded text-text-tertiary hover:text-text-primary hover:bg-background-hover flex items-center justify-center transition-colors"
        >
          <Maximize2 size={11} />
        </button>
        <button
          type="button"
          data-titlebar-action="1"
          onClick={() => onClose(w.moduleId)}
          title={t('actions.close', { defaultValue: '关闭' })}
          className="w-5 h-5 rounded text-text-tertiary hover:text-status-danger hover:bg-status-danger/10 flex items-center justify-center transition-colors"
        >
          <X size={12} />
        </button>
      </header>

      {/* Body — 包裹 SlotContextProvider, slotId=null 告诉模块自己在浮窗 */}
      <div ref={(node) => { /* 用 cardRef 测量整体, 不重复挂 ResizeObserver */ void node }} className="flex-1 min-h-0 flex flex-col">
        {/*
         * 浮窗内不传 slotId (传 null 让 useSlotContext 知道"我不在槽位");
         * 但 SlotContextProvider 需要 slotId 为 SlotId 类型, 这里把 floating 视为
         * "center 大舞台" — 大多数模块都按 standard 变体渲染即可.
         */}
        <SlotContextProvider slotId="center" containerRef={cardRef}>
          <ModuleRenderer moduleId={w.moduleId} />
        </SlotContextProvider>
      </div>

      {/* 右下角 resize handle */}
      <div
        onMouseDown={handleResizeMouseDown}
        className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize"
        style={{
          background:
            'linear-gradient(135deg, transparent 50%, rgb(var(--c-text-tertiary) / 0.4) 50%)',
        }}
        title="Resize"
      />
    </div>
  )
}
