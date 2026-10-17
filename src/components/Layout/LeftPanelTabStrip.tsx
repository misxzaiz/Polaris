/**
 * LeftPanelTabStrip —— 左侧面板高密度顶部 Tab strip（方案 A²）
 *
 * 高信息密度设计：32px 高、11px 字、tab 贴合内容宽度（flex:none + 白字宽度
 * 由内容撑开）零多余空白；固定核心 tab（files/git/browser/terminal，PINNED）
 * + MRU 追加 tab（从 ⋯ 溢出打开，可关闭）+ 溢出 ⋯ 分组网格 popover。
 *
 * 折叠：左侧按钮彻底关闭侧栏（closeLeftPanel，隐藏侧栏，无半开 rail）；
 * 重新展开走 leftActivityBar / ToolSwitcher 图标点击（现有 toggle 语义）。
 * tab 溢出：容器 overflow-x-auto，极细 3px 滚动条（hover 淡入）+ 可横向拖动。
 * tab 右键菜单：MRU 可关闭标签（含激活期折叠侧栏）；固定核心只提供隐藏侧栏。
 * 权威状态全部走 viewStore（leftPanelType / leftPanelMru…），本组件无内部 useState 竞争。
 */

import { useState, useRef, useEffect } from 'react'
import { Ellipsis, X, PanelLeftClose, EyeOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useViewStore, LeftPanelType } from '@/stores/viewStore'
import { pluginIconMap, pluginRegistry } from '@/plugin-system'
import { isPluginUiEnabled, usePluginStore } from '@/stores/pluginStore'
import { PINNED_LEFT_PANEL_TYPES, getToolGroup, type ToolGroupId } from './ToolSwitcher'

interface LeftPanelTabStripProps {
  /** 当前激活面板类型，由 App 用归一化后的权威值传入 */
  activePanelType: LeftPanelType
}

/** 溢出分组（与 ToolSwitcher.getToolGroup 语义一致，取其 group 展示） */
const GROUP_LABEL: Record<ToolGroupId, string> = {
  context: '上下文',
  changes: '变更',
  run: '运行',
  automation: '自动化',
  integrations: '集成',
  developer: '开发者',
  system: '系统',
}

export function LeftPanelTabStrip({ activePanelType }: LeftPanelTabStripProps) {
  const { t } = useTranslation('common')
  const leftPanelType = useViewStore((state) => state.leftPanelType)
  const toggleLeftPanel = useViewStore((state) => state.toggleLeftPanel)
  const closeLeftPanel = useViewStore((state) => state.closeLeftPanel)
  const leftPanelMru = useViewStore((state) => state.leftPanelMru)
  const openMruTab = useViewStore((state) => state.openMruTab)
  const closeMruTab = useViewStore((state) => state.closeMruTab)
  const pluginStates = usePluginStore((state) => state.pluginStates)

  const [moreOpen, setMoreOpen] = useState(false)
  const moreWrapRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // tab 右键菜单：{ x, y, panelType, isPinned } | null
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; panelType: LeftPanelType; isPinned: boolean } | null>(null)

  // 全部可用面板（注册表序），过滤被插件禁用者。与 ActivityBar 同源。
  const availablePanels = pluginRegistry
    .listViewContributions('activityBar')
    .filter((view) => isPluginUiEnabled(pluginStates, view.pluginId))
    .map((view) => ({
      panelType: view.panelType as LeftPanelType,
      icon: view.icon,
      labelKey: view.labelKey,
      labelDefault: view.labelDefault ?? view.panelType,
    }))

  // strip 固定核心（PINNED，序固定、不可关因信息密度最高）
  const pinnedTypes = availablePanels
    .map((a) => a.panelType)
    .filter((p) => PINNED_LEFT_PANEL_TYPES.has(p))

  // strip MRU 追加（从 ⋯ 打开过、未固定）：始终显示在固定核心之后
  const mruTypes = leftPanelMru.filter((p) =>
    availablePanels.some((a) => a.panelType === p)
  )
  const stripTypes = [...pinnedTypes, ...mruTypes]

  // 溢出：注册表中既非固定核心又未在 MRU 的面板
  const overflowPanels = availablePanels.filter((a) => !stripTypes.includes(a.panelType))

  const activeHidden = leftPanelType === 'none'

  // 点外部关闭 popover（mousedown 优先于 click，防点击穿透）
  useEffect(() => {
    if (!moreOpen) return
    const handle = (e: MouseEvent) => {
      if (!moreWrapRef.current?.contains(e.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [moreOpen])

  // tab 右键菜单：点击外部 / Esc 关闭（与 more popover 独立，二选一显示）
  useEffect(() => {
    if (!ctxMenu) return
    const handle = (e: MouseEvent) => {
      const target = e.target as Element | null
      if (!target || !target.closest('[data-panel-ctx-menu]')) setCtxMenu(null)
    }
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    const handleScroll = () => setCtxMenu(null)
    document.addEventListener('mousedown', handle)
    document.addEventListener('keydown', handleEsc)
    document.addEventListener('wheel', handleScroll, { passive: true })
    return () => {
      document.removeEventListener('mousedown', handle)
      document.removeEventListener('keydown', handleEsc)
      document.removeEventListener('wheel', handleScroll)
    }
  }, [ctxMenu])

  return (
    <div
      data-theme-panel
      className="flex h-8 shrink-0 items-stretch border-b border-border bg-background-elevated select-none"
    >
      {/* 关闭侧栏按钮（彻底隐藏，无半开 rail）；重新展开走 ActivityBar / 工具切换器 */}
      <button
        type="button"
        onClick={() => closeLeftPanel()}
        title={t('buttons.collapseSidebar', { defaultValue: '折叠侧栏' })}
        className="flex w-7 shrink-0 items-center justify-center border-r border-border text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
        aria-label={t('buttons.collapseSidebar', { defaultValue: '折叠侧栏' })}
      >
        <PanelLeftClose className="h-3.5 w-3.5" />
      </button>

      {/* 固定核心 + MRU tabs：溢出时水平滚动（极细 3px 滚动条，hover 淡入） */}
      <div className="left-panel-tabstrip-scroll flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
        {stripTypes.map((panelType) => {
          const panel = availablePanels.find((a) => a.panelType === panelType)
          const Icon = panel && panel.icon ? pluginIconMap[panel.icon] : undefined
          const isActive = !activeHidden && activePanelType === panelType
          const isPinned = PINNED_LEFT_PANEL_TYPES.has(panelType)
          return (
            <div
              key={panelType}
              data-panel-tab={panelType}
              onClick={() => toggleLeftPanel(panelType)}
              onContextMenu={(e) => {
                e.preventDefault()
                setCtxMenu({ x: e.clientX, y: e.clientY, panelType, isPinned })
              }}
              className={`relative flex shrink-0 cursor-pointer items-center gap-1 px-2.5 text-[11px] transition-colors ${
                isActive
                  ? 'bg-background-hover text-text-primary'
                  : 'text-text-tertiary hover:bg-background-hover/60 hover:text-text-secondary'
              }`}
            >
              {/* 激活下划线（方案 A 的 tab 语义） */}
              {isActive && (
                <span className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" />
              )}
              {Icon && <Icon size={13} className="shrink-0" />}
              <span className="whitespace-nowrap">
                {panel ? t(panel.labelKey, { defaultValue: panel.labelDefault }) : panelType}
              </span>
              {/* 非 pinned tab 显示关闭（点击关闭 MRU） */}
              {!isPinned && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeMruTab(panelType)
                    if (leftPanelType === panelType) closeLeftPanel()
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                  className="ml-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded text-text-tertiary opacity-0 transition-opacity hover:bg-background-surface hover:text-text-primary"
                  aria-label={t('buttons.closePanelTab', { defaultValue: '关闭面板' })}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          )
        })}

        {/* 溢出 ⋯（始终渲染，有溢出才展示 grid） */}
        <div ref={moreWrapRef} className="relative flex">
          <button
            type="button"
            onClick={() => setMoreOpen((o) => !o)}
            className="flex w-7 shrink-0 items-center justify-center border-l border-border text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
            aria-label={t('labels.morePanels', { defaultValue: '更多面板' })}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
          {moreOpen && overflowPanels.length > 0 && (
            <div
              ref={popRef}
              className="fixed z-popover mt-1 grid min-w-[190px] max-w-[240px] gap-0.5 rounded-xl border border-border bg-background-elevated p-1 shadow-medium animate-panel-in"
              style={{ top: 'auto', right: 'auto', bottom: 'auto' }}
            >
              {overflowPanels.map((p) => {
                const Icon = p.icon ? pluginIconMap[p.icon] : undefined
                return (
                  <button
                    key={p.panelType}
                    type="button"
                    onClick={() => {
                      setMoreOpen(false)
                      openMruTab(p.panelType)
                    }}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-[11.5px] text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
                  >
                    {Icon && <Icon size={14} className="shrink-0" />}
                    <span className="truncate">{t(p.labelKey, { defaultValue: p.labelDefault })}</span>
                    <span className="ml-auto text-[10px] text-text-tertiary">{GROUP_LABEL[getToolGroup(p.panelType)]}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* tab 右键菜单：MRU 可「关闭标签」；固定核心只提供「隐藏侧栏」 */}
      {ctxMenu && (
        <div
          data-panel-ctx-menu
          className="fixed z-popover min-w-[160px] bg-background-elevated border border-border rounded-md shadow-lg py-1"
          style={{ left: `${ctxMenu.x}px`, top: `${ctxMenu.y}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {!ctxMenu.isPinned && (
            <>
              <button
                type="button"
                onClick={() => {
                  const { panelType } = ctxMenu
                  setCtxMenu(null)
                  closeMruTab(panelType)
                  if (leftPanelType === panelType) closeLeftPanel()
                }}
                className="w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-background-hover transition-colors flex items-center gap-2"
              >
                <X size={12} />
                <span>{t('buttons.closePanelTab', { defaultValue: '关闭标签' })}</span>
              </button>
              <div className="my-1 border-t border-border-subtle" />
            </>
          )}
          <button
            type="button"
            onClick={() => {
              setCtxMenu(null)
              closeLeftPanel()
            }}
            className="w-full px-3 py-1.5 text-left text-sm text-text-primary hover:bg-background-hover transition-colors flex items-center gap-2"
          >
            <EyeOff size={12} />
            <span>{t('buttons.collapseSidebar', { defaultValue: '隐藏侧栏' })}</span>
          </button>
        </div>
      )}
    </div>
  )
}