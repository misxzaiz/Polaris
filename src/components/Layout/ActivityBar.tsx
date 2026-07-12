/**
 * ActivityBar - 左侧 Activity Bar 组件
 *
 * 支持折叠隐藏，折叠态通过工具切换器访问所有侧边栏功能。
 * 展开态保留高频入口，其他工具收纳到分组工具切换器。
 */

import { useState } from 'react'
import { Settings, PanelRight, Grid2X2 } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import {
  PINNED_LEFT_PANEL_TYPES,
  ToolSwitcher,
} from './ToolSwitcher'
import { ProblemsCountBadge, useToolSwitcherItems } from './toolSwitcherData'
import { useTranslation } from 'react-i18next'
import { pluginIconMap } from '@/plugin-system'

interface ActivityBarProps {
  className?: string
  /** 可选: 打开设置的回调 */
  onOpenSettings?: () => void
  /** 可选: 切换右侧面板的回调 */
  onToggleRightPanel?: () => void
  /** 右侧面板是否折叠 */
  rightPanelCollapsed?: boolean
  /** 强制折叠模式（如小屏模式），忽略 activityBarCollapsed 状态，入口交给顶部栏 */
  forceCollapsed?: boolean
}

export function ActivityBar({ className, onOpenSettings, onToggleRightPanel, rightPanelCollapsed, forceCollapsed }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const activityBarCollapsed = useViewStore((state) => state.activityBarCollapsed)
  const toggleActivityBar = useViewStore((state) => state.toggleActivityBar)

  const [isToolSwitcherOpen, setIsToolSwitcherOpen] = useState(false)

  const { panelButtons, toolSwitcherItems, activePanelLabel, closeLeftPanel } = useToolSwitcherItems({
    onOpenSettings,
    onToggleRightPanel,
    rightPanelCollapsed,
  })

  const pinnedPanelButtons = panelButtons.filter((btn) => PINNED_LEFT_PANEL_TYPES.has(btn.panelType))
  const hasActiveOverflowPanel = panelButtons.some(
    (btn) => !PINNED_LEFT_PANEL_TYPES.has(btn.panelType) && btn.panelType === leftPanelType
  )

  // 折叠状态下入口迁移到顶部栏，左侧完全让位。
  if (activityBarCollapsed || forceCollapsed) {
    return null
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

      {pinnedPanelButtons.map((btn) => {
        const Icon = pluginIconMap[btn.icon]
        return (
          <ActivityBarIcon
            key={btn.id}
            icon={Icon}
            label={t(btn.labelKey, { defaultValue: btn.labelDefault ?? btn.panelType })}
            active={leftPanelType === btn.panelType}
            onClick={() => toggleLeftPanel(btn.panelType)}
          >
            {btn.badge === 'problems' && <ProblemsCountBadge />}
          </ActivityBarIcon>
        )
      })}

      <ActivityBarIcon
        icon={Grid2X2}
        label={t('labels.moreTools', { defaultValue: '更多工具' })}
        active={isToolSwitcherOpen || hasActiveOverflowPanel}
        onClick={() => setIsToolSwitcherOpen((open) => !open)}
      />

      <ToolSwitcher
        isOpen={isToolSwitcherOpen}
        items={toolSwitcherItems}
        activePanelLabel={activePanelLabel}
        onCloseActivePanel={closeLeftPanel}
        onClose={() => setIsToolSwitcherOpen(false)}
      />

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
