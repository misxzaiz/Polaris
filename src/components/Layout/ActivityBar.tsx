/**
 * ActivityBar - 左侧 Activity Bar 组件
 *
 * 支持折叠隐藏，悬停悬浮球展开扇形菜单
 * 扇形菜单从悬浮球位置向右展开，包含所有侧边栏功能
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Settings, PanelRight } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { useDiagnosticsStore } from '@/stores/diagnosticsStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import { RadialMenu, RadialMenuTrigger } from './RadialMenu'
import { useTranslation } from 'react-i18next'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'

interface ActivityBarProps {
  className?: string
  /** 可选: 打开设置的回调 */
  onOpenSettings?: () => void
  /** 可选: 切换右侧面板的回调 */
  onToggleRightPanel?: () => void
  /** 右侧面板是否折叠 */
  rightPanelCollapsed?: boolean
  /** 强制折叠模式（如小屏模式），忽略 activityBarCollapsed 状态，始终显示半球触发器 */
  forceCollapsed?: boolean
}

/** Problems 按钮右下角的错误计数徽章 */
function ProblemsBadge() {
  // 订阅 version 以在诊断变化时重渲染
  useDiagnosticsStore((s) => s.version)
  // Use getState() to avoid creating new object in selector (causes infinite re-render)
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

export function ActivityBar({ className, onOpenSettings, onToggleRightPanel, rightPanelCollapsed, forceCollapsed }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const activityBarCollapsed = useViewStore((state) => state.activityBarCollapsed)
  const toggleActivityBar = useViewStore((state) => state.toggleActivityBar)
  const pluginStates = usePluginStore((state) => state.pluginStates)

  // 扇形菜单状态 - 支持悬停和点击
  const [isRadialMenuOpen, setIsRadialMenuOpen] = useState(false)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)
  // 按下瞬间（pointerdown）的菜单开关状态：触屏 tap 会先合成 mouseenter（hover 打开菜单）
  // 再触发 click，若 click 直接 toggle 会把刚打开的菜单立即关闭，导致触屏无法打开菜单
  const pressOpenRef = useRef(false)

  // 清理定时器
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
      }
    }
  }, [])

  // 悬停处理
  const handleTriggerHover = useCallback((isHovering: boolean) => {
    if (isHovering) {
      // 鼠标进入触发器，取消隐藏定时器并显示菜单
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
      setIsRadialMenuOpen(true)
    }
    // 鼠标离开触发器时不立即隐藏，等待菜单区域的处理
  }, [])

  // 菜单区域悬停处理
  const handleMenuHover = useCallback((isHovering: boolean) => {
    if (isHovering) {
      // 鼠标进入菜单，取消隐藏定时器
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current)
        hideTimerRef.current = null
      }
    } else {
      // 鼠标离开菜单，延迟隐藏
      hideTimerRef.current = setTimeout(() => {
        setIsRadialMenuOpen(false)
      }, 200)
    }
  }, [])

  const panelButtons = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))

  // 折叠状态下的渲染（或强制折叠模式）：显示贴边半圆悬浮球 + 扇形菜单
  if (activityBarCollapsed || forceCollapsed) {
    return (
      <>
        {/* 贴边半圆悬浮触发器 */}
        <RadialMenuTrigger
          onHover={handleTriggerHover}
          onPressStart={() => { pressOpenRef.current = isRadialMenuOpen }}
          onClick={() => setIsRadialMenuOpen(!pressOpenRef.current)}
          isOpen={isRadialMenuOpen}
        />

        {/* 扇形菜单 */}
        <RadialMenu
          isOpen={isRadialMenuOpen}
          onClose={() => setIsRadialMenuOpen(false)}
          onOpenSettings={onOpenSettings}
          onToggleRightPanel={onToggleRightPanel}
          rightPanelCollapsed={rightPanelCollapsed}
          onHover={handleMenuHover}
        />
      </>
    )
  }

  // 展开状态：显示传统的垂直图标栏
  return (
    <div
      className={`flex flex-col items-center shrink-0 w-12 py-2 bg-background-elevated border-r border-border ${className || ''}`}
    >
      {/* 折叠按钮 */}
      <button
        onClick={toggleActivityBar}
        className="w-10 h-10 mx-1 mb-2 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors"
        title={t('labels.hideActivityBar')}
      >
        <PanelRight className="w-5 h-5" />
      </button>

      {panelButtons.map((btn) => {
        const Icon = pluginIconMap[btn.icon]
        return (
          <ActivityBarIcon
            key={btn.id}
            icon={Icon}
            label={t(btn.labelKey, { defaultValue: btn.labelDefault ?? btn.panelType })}
            active={leftPanelType === btn.panelType}
            onClick={() => toggleLeftPanel(btn.panelType)}
          >
            {btn.badge === 'problems' && <ProblemsBadge />}
          </ActivityBarIcon>
        )
      })}

      <div className="flex-1" />

      {/* 右侧 AI 面板切换按钮 */}
      <ActivityBarIcon
        icon={PanelRight}
        label={rightPanelCollapsed ? t('labels.showAIPanel') : t('labels.hideAIPanel')}
        active={!rightPanelCollapsed}
        onClick={onToggleRightPanel || (() => {})}
      />

      <ActivityBarIcon
        icon={Settings}
        label={t('labels.settings')}
        active={false}
        onClick={onOpenSettings || (() => {})}
      />
    </div>
  )
}
