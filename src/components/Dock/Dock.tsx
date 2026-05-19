/**
 * Dock — V2 应用枢纽 (替代 ActivityBar)
 *
 * 与 V1 ActivityBar 的关键区别:
 *   - 顶部 WorkspaceSelector 渐变色块 (从 FileExplorer 迁移)
 *   - 中段按 "已绑定" / "可添加" 两组渲染 (PIN/ADD), 而不是平铺
 *   - 图标双行布局 (icon + 9px label)
 *   - 底段固定 Cmd+K + 主题 + 设置
 *   - 小屏 forceCollapsed 时仍回退到 RadialMenu (复用 V1)
 *
 * 接口与 ActivityBar 等价:
 *   - side: 'left' | 'right'
 *   - onOpenSettings: () => void
 *   - forceCollapsed: boolean (小屏)
 *
 * 拖拽:
 *   - DockItem 内部已包 useDraggable, 数据格式同 V1 (type='activity-bar')
 *   - LayoutDndProvider 接收, 无需额外集成
 *
 * 与 Dock 模式 (dockMode):
 *   - 当前阶段恒走 'expanded' 模式; floating/compact 留给后续 Phase
 */

import {
  Settings,
  PanelRight,
  PanelLeftClose,
  PanelRightClose,
  Command,
  Sun,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLayoutStore } from '@/stores/layoutStore'
import { useDiagnosticsStore } from '@/stores/diagnosticsStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import { RadialMenu, RadialMenuTrigger } from '@/components/Layout/RadialMenu'
import { useCommandPalette } from '@/components/CommandPalette'
import { DockItem } from './DockItem'
import { DockGroup } from './DockGroup'
import { WorkspaceSelector } from './WorkspaceSelector'

export interface DockProps {
  side?: 'left' | 'right'
  onOpenSettings?: () => void
  /** 强制折叠模式 (小屏), 显示半圆悬浮球替代垂直 Dock */
  forceCollapsed?: boolean
}

export function Dock({ side = 'left', onOpenSettings, forceCollapsed }: DockProps) {
  const { t } = useTranslation('common')
  const slots = useLayoutStore((s) => s.slots)
  const activateModule = useLayoutStore((s) => s.activateModule)
  const toggleModule = useLayoutStore((s) => s.toggleModule)
  const setActivityBarPosition = useLayoutStore((s) => s.setActivityBarPosition)
  const pluginStates = usePluginStore((state) => state.pluginStates)
  const { openPalette } = useCommandPalette()

  // 诊断角标 (problems badge)
  useDiagnosticsStore((s) => s.version) // subscribe 触发 rerender
  const { errors, warnings } = useDiagnosticsStore.getState().summary

  // 小屏: 渲染 RadialMenu
  const [isRadialMenuOpen, setIsRadialMenuOpen] = useState(false)
  const hideTimerRef = useRef<NodeJS.Timeout | null>(null)
  useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current)
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
      hideTimerRef.current = setTimeout(() => setIsRadialMenuOpen(false), 200)
    }
  }, [])

  const isModuleBoundSomewhere = useCallback(
    (moduleId: string) =>
      Object.values(slots).some((s) => s.modules.includes(moduleId)),
    [slots]
  )
  const isModuleActiveNow = useCallback(
    (moduleId: string) => Object.values(slots).some((s) => s.activeModule === moduleId),
    [slots]
  )

  const chatActive = isModuleActiveNow('chat')
  const chatBoundSomewhere = isModuleBoundSomewhere('chat')
  const toggleChat = () => toggleModule('chat')

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

  // 中段: 按"已绑定/未绑定"分组. chat 由底段 PanelRight 按钮单独处理.
  const allViews = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
    .filter((view) => view.moduleId !== 'chat')

  const pinned = allViews.filter((v) => isModuleBoundSomewhere(v.moduleId))
  const available = allViews.filter((v) => !isModuleBoundSomewhere(v.moduleId))

  const HideIcon = side === 'left' ? PanelLeftClose : PanelRightClose
  const totalProblems = errors + warnings

  return (
    <div
      className="flex flex-col items-center shrink-0 py-2 bg-background-elevated ring-1 ring-border/40 overflow-hidden"
      style={{
        width: 'var(--dock-w-expanded)',
        borderRadius: 'var(--slot-radius)',
      }}
      data-dock-side={side}
    >
      {/* 顶段: Workspace */}
      <WorkspaceSelector />

      {/* 隐藏 Dock 按钮 */}
      <button
        type="button"
        onClick={() => setActivityBarPosition('hidden')}
        className="w-9 h-7 rounded-md flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-background-hover transition-colors mb-1"
        title={t('labels.hideActivityBar', { defaultValue: '隐藏 Dock' })}
        aria-label={t('labels.hideActivityBar', { defaultValue: '隐藏 Dock' })}
      >
        <HideIcon size={14} />
      </button>

      {/* 中段: 模块导航 */}
      <div className="flex-1 w-full overflow-y-auto overflow-x-hidden">
        {pinned.length > 0 && (
          <DockGroup label="PIN" divider={false}>
            {pinned.map((view) => {
              const Icon = pluginIconMap[view.icon]
              const label = t(view.labelKey, {
                defaultValue: view.labelDefault ?? view.moduleId,
              })
              const showProblemsBadge = view.badge === 'problems' && totalProblems > 0
              return (
                <DockItem
                  key={view.id}
                  moduleId={view.moduleId}
                  icon={Icon ? <Icon size={18} /> : '◧'}
                  label={view.moduleId.toUpperCase().slice(0, 5)}
                  title={label}
                  active={isModuleActiveNow(view.moduleId)}
                  onClick={() => activateModule(view.moduleId)}
                  badge={showProblemsBadge ? totalProblems : undefined}
                />
              )
            })}
          </DockGroup>
        )}

        {available.length > 0 && (
          <DockGroup label="ADD" divider={pinned.length > 0}>
            {available.map((view) => {
              const Icon = pluginIconMap[view.icon]
              const label = t(view.labelKey, {
                defaultValue: view.labelDefault ?? view.moduleId,
              })
              return (
                <DockItem
                  key={view.id}
                  moduleId={view.moduleId}
                  icon={Icon ? <Icon size={18} /> : '◧'}
                  label={view.moduleId.toUpperCase().slice(0, 5)}
                  title={label}
                  onClick={() => activateModule(view.moduleId)}
                />
              )
            })}
          </DockGroup>
        )}
      </div>

      {/* 底段: 命令面板 + 主题 (未来) + 设置 */}
      <div className="w-full pt-2 mt-1 border-t border-dashed border-border/30 flex flex-col items-center gap-1">
        <DockItem
          icon={<Command size={16} />}
          label="⌘K"
          title={t('commandPalette.title', { defaultValue: '命令面板 (⌘K)' })}
          onClick={openPalette}
          draggable={false}
        />
        {chatBoundSomewhere && (
          <DockItem
            icon={<PanelRight size={18} />}
            active={chatActive}
            title={
              chatActive
                ? t('labels.hideAIPanel', { defaultValue: '隐藏 Chat' })
                : t('labels.showAIPanel', { defaultValue: '显示 Chat' })
            }
            onClick={toggleChat}
            draggable={false}
          />
        )}
        <DockItem
          icon={<Sun size={16} />}
          title={t('labels.theme', { defaultValue: '主题' })}
          onClick={() => {
            /* TODO: Phase 4 主题切换 */
          }}
          draggable={false}
        />
        <DockItem
          icon={<Settings size={16} />}
          title={t('labels.settings', { defaultValue: '设置' })}
          onClick={onOpenSettings ?? (() => {})}
          draggable={false}
        />
      </div>
    </div>
  )
}
