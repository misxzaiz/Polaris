/**
 * ActivityBar - 左侧 Activity Bar 组件
 *
 * 支持折叠隐藏，悬停悬浮球展开扇形菜单
 * 扇形菜单从悬浮球位置向右展开，包含所有侧边栏功能
 */

import { useState, useRef, useEffect, useCallback } from 'react'
import { Files, GitPullRequest, CheckSquare, Settings, Languages, Clock, ClipboardList, Terminal, Code2, PanelRight } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import { RadialMenu, RadialMenuTrigger } from './RadialMenu'
import { useTranslation } from 'react-i18next'

interface ActivityBarProps {
  className?: string
  /** 可选: 打开设置的回调 */
  onOpenSettings?: () => void
  /** 可选: 切换右侧面板的回调 */
  onToggleRightPanel?: () => void
  /** 右侧面板是否折叠 */
  rightPanelCollapsed?: boolean
}

export function ActivityBar({ className, onOpenSettings, onToggleRightPanel, rightPanelCollapsed }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const activityBarCollapsed = useViewStore((state) => state.activityBarCollapsed)
  const toggleActivityBar = useViewStore((state) => state.toggleActivityBar)

  // 扇形菜单状态 - 支持悬停和点击
  const [isRadialMenuOpen, setIsRadialMenuOpen] = useState(false)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)

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

  const panelButtons = [
    {
      id: 'files' as const,
      icon: Files,
      label: t('labels.fileExplorer'),
    },
    {
      id: 'git' as const,
      icon: GitPullRequest,
      label: t('labels.gitPanel'),
    },
    {
      id: 'todo' as const,
      icon: CheckSquare,
      label: t('labels.todoPanel'),
    },
    {
      id: 'translate' as const,
      icon: Languages,
      label: t('labels.translatePanel'),
    },
    {
      id: 'scheduler' as const,
      icon: Clock,
      label: t('labels.schedulerPanel'),
    },
    {
      id: 'requirement' as const,
      icon: ClipboardList,
      label: t('labels.requirementPanel'),
    },
    {
      id: 'terminal' as const,
      icon: Terminal,
      label: t('labels.terminalPanel'),
    },
    {
      id: 'developer' as const,
      icon: Code2,
      label: t('labels.developerPanel'),
    },
  ]

  // 折叠状态下的渲染：显示贴边半圆悬浮球 + 扇形菜单
  if (activityBarCollapsed) {
    return (
      <>
        {/* 贴边半圆悬浮触发器 */}
        <RadialMenuTrigger
          onHover={handleTriggerHover}
          onClick={() => setIsRadialMenuOpen(!isRadialMenuOpen)}
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

      {panelButtons.map((btn) => (
        <ActivityBarIcon
          key={btn.id}
          icon={btn.icon}
          label={btn.label}
          active={leftPanelType === btn.id}
          onClick={() => toggleLeftPanel(btn.id)}
        />
      ))}

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
