/**
 * ActivityBar - 左侧 Activity Bar 组件
 *
 * 简化版：默认 36px 宽度，移除折叠按钮和 AI 面板切换按钮。
 * 图标数量自适应：根据容器高度计算能放多少个图标，放不下的自动进「更多工具」。
 * 小屏模式通过 forceCollapsed 让位给顶部栏。
 */

import { useState, useEffect, useRef } from 'react'
import { Settings, Grid2X2 } from 'lucide-react'
import { useViewStore } from '@/stores/viewStore'
import { ActivityBarIcon } from './ActivityBarIcon'
import {
  ToolSwitcher,
} from './ToolSwitcher'
import { useToolSwitcherItems } from './toolSwitcherData'
import { useTranslation } from 'react-i18next'
import { pluginIconMap } from '@/plugin-system'

/** 每个图标占用的高度：24px 按钮 + 1px margin-bottom */
const ICON_HEIGHT = 25
/** 容器上下 padding: py-2 = 8px * 2 */
const CONTAINER_PADDING = 16
/** 底部固定保留：更多工具(25px) + 设置(25px) */
const BOTTOM_RESERVED = 50

interface ActivityBarProps {
  className?: string
  /** 可选: 打开设置的回调 */
  onOpenSettings?: () => void
  /** 可选: 切换右侧面板的回调 */
  onToggleRightPanel?: () => void
  /** 右侧面板是否折叠 */
  rightPanelCollapsed?: boolean
  /** 强制折叠模式（如小屏模式），入口交给顶部栏 */
  forceCollapsed?: boolean
}

export function ActivityBar({ className, onOpenSettings, onToggleRightPanel, rightPanelCollapsed, forceCollapsed }: ActivityBarProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)

  const [isToolSwitcherOpen, setIsToolSwitcherOpen] = useState(false)
  const [visibleCount, setVisibleCount] = useState(8) // 默认值，实际由 ResizeObserver 计算

  const containerRef = useRef<HTMLDivElement>(null)

  const { panelButtons, toolSwitcherItems, activePanelLabel, closeLeftPanel } = useToolSwitcherItems({
    onOpenSettings,
    onToggleRightPanel,
    rightPanelCollapsed,
  })

  // 自适应计算能显示的图标数量
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const calculate = () => {
      const h = el.clientHeight
      if (h <= 0) return
      // 可用高度 = 总高 - padding - 底部保留(更多工具+设置)
      const available = h - CONTAINER_PADDING - BOTTOM_RESERVED
      const count = Math.max(0, Math.floor(available / ICON_HEIGHT))
      setVisibleCount(Math.min(count, panelButtons.length))
    }

    calculate()

    const ro = new ResizeObserver(() => calculate())
    ro.observe(el)
    return () => ro.disconnect()
  }, [panelButtons.length])

  // 可见按钮和溢出按钮
  const visibleButtons = panelButtons.slice(0, visibleCount)
  const hasActiveOverflow = panelButtons.slice(visibleCount).some(
    (btn) => btn.panelType === leftPanelType
  )
  // 更多工具按钮高亮：有溢出面板被激活，或工具切换器打开
  const moreToolsActive = isToolSwitcherOpen || hasActiveOverflow

  // 小屏模式下不渲染 ActivityBar，入口交给顶部栏
  if (forceCollapsed) {
    return null
  }

  // 展开状态：显示紧凑的垂直图标栏
  return (
    <div
      ref={containerRef}
      data-theme-panel
      className={`flex flex-col items-center shrink-0 w-9 py-2 bg-background-elevated border-r border-border ${className || ''}`}
    >
      {visibleButtons.map((btn) => {
        const Icon = pluginIconMap[btn.icon]
        return (
          <ActivityBarIcon
            key={btn.id}
            icon={Icon}
            label={t(btn.labelKey, { defaultValue: btn.labelDefault ?? btn.panelType })}
            active={leftPanelType === btn.panelType}
            onClick={() => toggleLeftPanel(btn.panelType)}
          />
        )
      })}

      <ActivityBarIcon
        icon={Grid2X2}
        label={t('labels.moreTools', { defaultValue: '更多工具' })}
        active={moreToolsActive}
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

      <ActivityBarIcon
        icon={Settings}
        label={t('labels.settings')}
        active={false}
        onClick={onOpenSettings || (() => {})}
      />
    </div>
  )
}
