import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, RefObject } from 'react'
import { Grid2X2, PanelLeftClose, Search, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'

export type ToolGroupId =
  | 'context'
  | 'changes'
  | 'run'
  | 'automation'
  | 'integrations'
  | 'developer'
  | 'system'

export interface ToolSwitcherItem {
  id: string
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  description?: string
  group: ToolGroupId
  active?: boolean
  onSelect: () => void
}

interface ToolSwitcherProps {
  isOpen: boolean
  items: ToolSwitcherItem[]
  onClose: () => void
  placement?: 'activityBar' | 'top'
  /** 本次打开的来源：hover 打开不 focus 搜索框（避免吞正在输入的字符）；click 打开 focus。默认 'click' */
  openMode?: 'click' | 'hover'
  /** hover 触发模式下触发按钮的引用，用于把浮层锚定到按钮正下方；click 模式用预留的固定定位 */
  anchorRef?: RefObject<HTMLElement | null>
  activePanelLabel?: string
  onCloseActivePanel?: () => void
  onMouseEnter?: () => void
  onMouseLeave?: () => void
}

export const PINNED_LEFT_PANEL_TYPES = new Set(['files', 'git', 'browser', 'terminal'])

export function getToolGroup(panelType: string): ToolGroupId {
  switch (panelType) {
    case 'files':
    case 'browser':
    case 'requirement':
    case 'personalHub':
      return 'context'
    case 'git':
      return 'changes'
    case 'terminal':
    case 'scheduler':
    case 'aiConsole':
      return 'run'
    case 'todo':
      return 'automation'
    case 'translate':
    case 'integration':
      return 'integrations'
    case 'developer':
    case 'demoPlugin':
      return 'developer'
    default:
      return 'system'
  }
}

function getPlacementClass(placement: ToolSwitcherProps['placement']) {
  if (placement === 'top') {
    return 'left-2 top-11 w-[min(360px,calc(100vw-16px))]'
  }

  return 'left-10 top-12 w-[min(360px,calc(100vw-72px))]'
}

export function ToolSwitcher({
  isOpen,
  items,
  onClose,
  placement = 'activityBar',
  openMode = 'click',
  anchorRef,
  activePanelLabel,
  onCloseActivePanel,
  onMouseEnter,
  onMouseLeave,
}: ToolSwitcherProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 锚定触发按钮定位：浮层左缘对齐触发按钮、下缘 +6px；窄窗 clamp 兜底不做横向溢出。
  useEffect(() => {
    if (!isOpen) return

    const btn = anchorRef?.current
    const menu = menuRef.current
    if (!btn || !menu) return

    const rect = btn.getBoundingClientRect()
    const width = menu.offsetWidth
    const height = menu.offsetHeight
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))
    const top = Math.min(rect.bottom + 6, window.innerHeight - height - 8)
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }, [isOpen, anchorRef])

  useEffect(() => {
    if (!isOpen) return

    setQuery('')
    // 仅 click 打开时自动聚焦搜索框；hover 打开不抢焦点（用户注意力可能在编辑器/终端，
    // 自动 focus 会吞正在输入的字符——数据丢失级问题，v5 设计确认保留该语义）
    let focusTimer: number | undefined
    if (openMode === 'click') {
      focusTimer = window.setTimeout(() => inputRef.current?.focus(), 30)
    }

    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      if (focusTimer !== undefined) window.clearTimeout(focusTimer)
      document.removeEventListener('mousedown', handleMouseDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isOpen, onClose, openMode])

  const filteredItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return items

    return items.filter((item) => {
      const haystack = `${item.label} ${item.description ?? ''} ${item.group}`.toLowerCase()
      return haystack.includes(normalizedQuery)
    })
  }, [items, query])

  if (!isOpen) return null

  // pinned 常用项（文件/变更/浏览器/终端）置顶 icon 大按钮；其余溢出 3 列紧凑网格。
  const pinnedItems = filteredItems.filter((item) => PINNED_LEFT_PANEL_TYPES.has(item.id))
  const overflowItems = filteredItems.filter((item) => !PINNED_LEFT_PANEL_TYPES.has(item.id))

  // z-popover（--z-popover）：作为全局导航浮层须高于内容区覆盖层（NarrowTabOverlay/Artifact 预览等 z-overlay），
  // 低于全屏接管层（VoiceCompanion z-modal、Dialog z-modal）。z-popover 会被窄窗口
  // 编辑器覆盖层 z-overlay 盖住（覆盖层挂在 DOM 靠后，同层级按 DOM 序反压）。
  return (
    <div
      ref={menuRef}
      className={`fixed z-popover ${getPlacementClass(placement)} rounded-xl border border-border bg-background-elevated shadow-medium animate-panel-in flex flex-col`}
      style={{ maxHeight: 'min(70dvh, calc(100dvh - 64px))' }}
      role="listbox"
      aria-label={t('labels.toolSwitcher', { defaultValue: '工具切换器' })}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {/* 头部：单行 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-3 py-2">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Grid2X2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {t('labels.toolSwitcher', { defaultValue: '工具切换器' })}
        </div>
        {activePanelLabel && (
          <span className="shrink-0 rounded-full border border-border-subtle bg-background-surface px-2 py-0.5 text-[11px] text-text-tertiary">
            {activePanelLabel}
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
          aria-label={t('buttons.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 搜索行 */}
      <div className="shrink-0 border-b border-border-subtle px-3 py-2">
        <div className="flex h-8 items-center gap-2 rounded-lg border border-border-subtle bg-background-surface px-2 text-text-tertiary focus-within:border-border-focus focus-within:text-text-secondary">
          <Search className="h-4 w-4 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('labels.searchTools', { defaultValue: '搜索工具' })}
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-tertiary"
          />
        </div>
      </div>

      {/* 滚动区：flex-1 min-h-0，唯一高度源是外层 max-height，消灭双魔数 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {pinnedItems.length > 0 && (
          <div className="mb-2 grid grid-cols-4 gap-1">
            {pinnedItems.map((item) => {
              const Icon = item.icon
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={item.active}
                  onClick={() => {
                    item.onSelect()
                    onClose()
                  }}
                  title={item.label}
                  className={`flex flex-col items-center justify-center gap-0.5 rounded-md py-1.5 transition-colors ${
                    item.active
                      ? 'bg-primary/10 text-primary'
                      : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
                  }`}
                >
                  <Icon size={17} />
                  <span className="text-[10.5px] leading-tight">{item.label}</span>
                </button>
              )
            })}
          </div>
        )}

        {pinnedItems.length > 0 && overflowItems.length > 0 && (
          <div className="mb-2 mx-1 h-px bg-border-subtle" />
        )}

        {overflowItems.length === 0 && pinnedItems.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-text-tertiary">
            {t('status.noResults', { defaultValue: '没有匹配结果' })}
          </div>
        ) : (
          overflowItems.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {overflowItems.map((item) => {
                const Icon = item.icon
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="option"
                    aria-selected={item.active}
                    onClick={() => {
                      item.onSelect()
                      onClose()
                    }}
                    title={item.description ? `${item.label} · ${item.description}` : item.label}
                    className={`flex items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left transition-colors ${
                      item.active
                        ? 'bg-primary/10 text-primary'
                        : 'text-text-secondary hover:bg-background-hover hover:text-text-primary'
                    }`}
                  >
                    <Icon size={15} className="shrink-0" />
                    <span className="truncate text-xs">{item.label}</span>
                  </button>
                )
              })}
            </div>
          )
        )}
      </div>

      {/* 底部：当前侧栏 + 关闭侧栏（沉到面板底，不再挤头部） */}
      {(activePanelLabel || onCloseActivePanel) && (
        <div className="flex shrink-0 items-center gap-2 border-t border-border-subtle px-3 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px] text-text-tertiary">
            {activePanelLabel
              ? `${t('labels.activeSidebar', { defaultValue: '当前侧栏' })}: ${activePanelLabel}`
              : t('labels.activeSidebar', { defaultValue: '当前侧栏' })}
          </span>
          {onCloseActivePanel && (
            <button
              type="button"
              onClick={() => {
                onCloseActivePanel()
                onClose()
              }}
              className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
            >
              <PanelLeftClose className="h-3 w-3" />
              <span>{t('buttons.close', { defaultValue: '关闭' })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
