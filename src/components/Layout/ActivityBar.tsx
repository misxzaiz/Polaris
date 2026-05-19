/**
 * ActivityBar - 应用左/右侧的模块导航栏
 *
 * 由 layoutStore.activityBarPosition 决定显示位置 (left/right/hidden)。
 * - 展开状态: 显示垂直图标栏,点击模块图标激活对应槽位
 * - 折叠状态 (small-screen forceCollapsed): 显示贴边半圆悬浮球 + 扇形菜单
 * - hidden 模式: LayoutShell 不渲染此组件 (本组件无需自己 return null)
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Settings, PanelRight, PanelLeftClose, PanelRightClose } from 'lucide-react'
import { useDraggable } from '@dnd-kit/core'
import { useLayoutStore } from '@/stores/layoutStore'
import { useDiagnosticsStore } from '@/stores/diagnosticsStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import { RadialMenu, RadialMenuTrigger } from './RadialMenu'
import { useTranslation } from 'react-i18next'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import { activityBarDraggableId, type DragData } from './dnd'
import type { ModuleId } from '@/types/layout'

interface ActivityBarProps {
  className?: string
  /** 在主布局中的位置;LayoutShell 根据 layoutStore.activityBarPosition 传入 */
  side?: 'left' | 'right'
  /** 打开设置的回调 */
  onOpenSettings?: () => void
  /** 强制折叠模式 (小屏),忽略布局位置,始终显示半球触发器 */
  forceCollapsed?: boolean
}

function ProblemsBadge() {
  useDiagnosticsStore((s) => s.version)
  const { errors, warnings } = useDiagnosticsStore.getState().summary
  const total = errors + warnings
  if (total === 0) return null
  return (
    <span
      className={`absolute -right-0.5 -bottom-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-bold flex items-center justify-center text-white ${
        errors > 0 ? 'bg-red-500' : 'bg-yellow-500'
      }`}
    >
      {total > 99 ? '99+' : total}
    </span>
  )
}

export function ActivityBar({ className, side = 'left', onOpenSettings, forceCollapsed }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const slots = useLayoutStore((s) => s.slots)
  const activateModule = useLayoutStore((s) => s.activateModule)
  const toggleModule = useLayoutStore((s) => s.toggleModule)
  const setActivityBarPosition = useLayoutStore((s) => s.setActivityBarPosition)
  const pluginStates = usePluginStore((state) => state.pluginStates)

  const [isRadialMenuOpen, setIsRadialMenuOpen] = useState(false)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)

  useEffect(() => {
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
    }
  }, [])

  const handleTriggerHover = useCallback((isHovering: boolean) => {
    if (isHovering) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      setIsRadialMenuOpen(true)
    }
  }, [])

  const handleMenuHover = useCallback((isHovering: boolean) => {
    if (isHovering) {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    } else {
      hideTimerRef.current = setTimeout(() => {
        setIsRadialMenuOpen(false)
      }, 200)
    }
  }, [])

  const panelButtons = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
    // chat 模块的入口由 right slot 的折叠按钮专门处理,不重复在 ActivityBar 中显示
    .filter((view) => view.moduleId !== 'chat')

  const isModuleActiveNow = (moduleId: string) =>
    Object.values(slots).some((s) => s.activeModule === moduleId)

  const chatActive = isModuleActiveNow('chat')
  const chatBoundSomewhere = Object.values(slots).some((s) => s.modules.includes('chat'))
  const toggleChat = () => toggleModule('chat')

  // 强制折叠 (小屏 / hidden 位置已由 LayoutShell 阻止渲染)
  if (forceCollapsed) {
    return (
      <>
        <RadialMenuTrigger
          side={side}
          onHover={handleTriggerHover}
          onClick={() => setIsRadialMenuOpen(!isRadialMenuOpen)}
          isOpen={isRadialMenuOpen}
        />
        <RadialMenu
          side={side}
          isOpen={isRadialMenuOpen}
          onClose={() => setIsRadialMenuOpen(false)}
          onOpenSettings={onOpenSettings}
          onToggleRightPanel={chatBoundSomewhere ? toggleChat : undefined}
          rightPanelCollapsed={!chatActive}
          onHover={handleMenuHover}
        />
      </>
    )
  }

  const borderClass = side === 'left' ? 'border-r' : 'border-l'
  const HideIcon = side === 'left' ? PanelLeftClose : PanelRightClose

  return (
    <div
      className={`flex flex-col items-center shrink-0 w-12 py-2 bg-background-elevated border-border ${borderClass} ${className || ''}`}
    >
      <button
        type="button"
        onClick={() => setActivityBarPosition('hidden')}
        className="w-10 h-10 mx-1 mb-2 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
        title={t('labels.hideActivityBar')}
      >
        <HideIcon className="w-5 h-5" />
      </button>

      {panelButtons.map((btn) => {
        const Icon = pluginIconMap[btn.icon]
        return (
          <DraggableActivityIcon
            key={btn.id}
            moduleId={btn.moduleId}
            icon={Icon}
            label={t(btn.labelKey, { defaultValue: btn.labelDefault ?? btn.moduleId })}
            active={isModuleActiveNow(btn.moduleId)}
            onClick={() => activateModule(btn.moduleId)}
            badge={btn.badge === 'problems' ? <ProblemsBadge /> : undefined}
          />
        )
      })}

      <div className="flex-1" />

      {chatBoundSomewhere && (
        <ActivityBarIcon
          icon={PanelRight}
          label={chatActive ? t('labels.hideAIPanel') : t('labels.showAIPanel')}
          active={chatActive}
          onClick={toggleChat}
        />
      )}

      <ActivityBarIcon
        icon={Settings}
        label={t('labels.settings')}
        active={false}
        onClick={onOpenSettings || (() => {})}
      />
    </div>
  )
}

// ============================================================
// DraggableActivityIcon - 包装 ActivityBarIcon, 让它可被拖到槽位
// ============================================================
interface DraggableActivityIconProps {
  moduleId: ModuleId
  icon: React.ComponentType<{ size?: number; className?: string }>
  label: string
  active: boolean
  onClick: () => void
  badge?: React.ReactNode
}

function DraggableActivityIcon({
  moduleId,
  icon,
  label,
  active,
  onClick,
  badge,
}: DraggableActivityIconProps) {
  const dragData: DragData = { type: 'activity-bar', moduleId }
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: activityBarDraggableId(moduleId),
    data: dragData,
  })

  return (
    <div
      ref={setNodeRef}
      className={`relative ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
    >
      <ActivityBarIcon icon={icon} label={label} active={active} onClick={onClick}>
        {badge}
      </ActivityBarIcon>
    </div>
  )
}
