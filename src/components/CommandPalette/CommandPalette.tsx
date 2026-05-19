/**
 * CommandPalette — V2 命令面板 UI
 *
 * 设计:
 *   - Modal 风格, fixed 居中偏上 (top 12vh)
 *   - 640px 宽, 毛玻璃半透明
 *   - 顶部输入框 (autoFocus, ESC 关闭)
 *   - 列表分组 (Recent / Navigate / Layout / Action)
 *   - 键盘导航: ↑↓ 移动焦点, Enter 执行, ESC 关闭
 *   - 鼠标点击直接执行
 *
 * 唤出:
 *   - 由 CommandPaletteProvider 全局监听 Cmd+K / Ctrl+K
 *   - open 状态由 dockStore 持有 (Phase 2 第二段会拆出 dockStore;
 *     当前先用本地 useState, dockStore 加入后再切)
 *
 * a11y:
 *   - role=dialog + aria-modal
 *   - 输入框 aria-controls 关联列表
 *   - 列表 role=listbox + 每项 role=option + aria-selected
 */

import { useEffect, useRef, useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  commandRegistry,
  filterAndRank,
  type Command,
  type CommandCategory,
} from '@/services/commandRegistry'
import { useCommands } from '@/hooks/useCommands'
import { createLogger } from '@/utils/logger'

const log = createLogger('CommandPalette')

interface CommandPaletteProps {
  open: boolean
  onClose: () => void
}

const CATEGORY_ORDER: CommandCategory[] = ['navigate', 'layout', 'action']
const CATEGORY_LABEL: Record<CommandCategory, string> = {
  navigate: '导航',
  layout: '布局',
  action: '操作',
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [focusIdx, setFocusIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { commands, recentIds } = useCommands()

  // 计算过滤+排序后的命令列表 (扁平, 用 focusIdx 索引)
  const filtered = useMemo(() => filterAndRank(commands, query, recentIds), [
    commands,
    query,
    recentIds,
  ])

  // 按类别分组 (空 query 时显示 recent 分组在最上)
  const grouped = useMemo(() => {
    const groups: Array<{ key: string; label: string; items: Command[] }> = []
    if (query.trim() === '' && recentIds.length > 0) {
      const recentCmds = recentIds
        .map((id) => commands.find((c) => c.id === id))
        .filter((c): c is Command => Boolean(c))
      if (recentCmds.length > 0) {
        groups.push({ key: 'recent', label: '最近使用', items: recentCmds })
      }
    }
    for (const cat of CATEGORY_ORDER) {
      const items = filtered.filter((c) => c.category === cat)
      // 在 recent 分组里出现的命令不在此重复 (空 query 时)
      const dedup =
        query.trim() === '' && recentIds.length > 0
          ? items.filter((c) => !recentIds.includes(c.id))
          : items
      if (dedup.length > 0) {
        groups.push({ key: cat, label: CATEGORY_LABEL[cat], items: dedup })
      }
    }
    return groups
  }, [filtered, query, recentIds, commands])

  // 扁平索引: 用于 ↑↓ 在分组间连续导航
  const flatItems = useMemo(() => grouped.flatMap((g) => g.items), [grouped])

  // open 状态变化时重置
  useEffect(() => {
    if (open) {
      setQuery('')
      setFocusIdx(0)
      // 下一帧 focus, 避免与 portal 渲染抢
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // query 变化时重置 focus
  useEffect(() => {
    setFocusIdx(0)
  }, [query])

  // 滚动到聚焦项
  useEffect(() => {
    if (!open) return
    const node = listRef.current?.querySelector<HTMLElement>(
      `[data-cmd-idx="${focusIdx}"]`
    )
    node?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx, open])

  // 键盘导航
  const handleKey = useCallback(
    async (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, flatItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = flatItems[focusIdx]
        if (cmd) {
          try {
            await commandRegistry.execute(cmd.id)
          } catch (err) {
            log.error('Command failed', { id: cmd.id, err })
          }
          onClose()
        }
      }
    },
    [flatItems, focusIdx, onClose]
  )

  const handleClick = useCallback(
    async (cmd: Command) => {
      try {
        await commandRegistry.execute(cmd.id)
      } catch (err) {
        log.error('Command failed', { id: cmd.id, err })
      }
      onClose()
    },
    [onClose]
  )

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center"
      onMouseDown={(e) => {
        // 点击 backdrop 关闭
        if (e.target === e.currentTarget) onClose()
      }}
      role="presentation"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/40"
        style={{ backdropFilter: 'blur(4px)' }}
        aria-hidden="true"
      />

      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('commandPalette.title', { defaultValue: '命令面板' })}
        className="relative mt-[12vh] w-[640px] max-w-[92vw] bg-background-elevated/95 border border-border-strong rounded-xl shadow-2xl overflow-hidden"
        style={{ backdropFilter: 'blur(24px) saturate(180%)' }}
        onKeyDown={handleKey}
      >
        {/* Input row */}
        <div
          className="flex items-center border-b border-border gap-3"
          style={{
            height: '48px',
            paddingLeft: 'var(--module-padding-x)',
            paddingRight: 'var(--module-padding-x)',
          }}
        >
          <span className="text-text-tertiary shrink-0" aria-hidden="true">⌘</span>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette.placeholder', {
              defaultValue: '输入命令或搜索…',
            })}
            className="flex-1 bg-transparent border-0 outline-none text-text-primary placeholder:text-text-tertiary"
            aria-controls="cmd-palette-listbox"
            aria-autocomplete="list"
          />
          <kbd className="text-[10px] px-1.5 py-0.5 bg-background-surface rounded text-text-tertiary shrink-0">
            esc
          </kbd>
        </div>

        {/* List */}
        <div
          ref={listRef}
          id="cmd-palette-listbox"
          role="listbox"
          className="overflow-auto"
          style={{ maxHeight: '360px' }}
        >
          {flatItems.length === 0 ? (
            <div className="text-center text-text-tertiary text-sm py-12">
              {t('commandPalette.empty', { defaultValue: '无匹配命令' })}
            </div>
          ) : (
            grouped.map((g) => (
              <div key={g.key}>
                <div className="px-4 pt-2 pb-1 text-[10px] font-semibold text-text-tertiary tracking-wider uppercase">
                  {g.label}
                </div>
                {g.items.map((cmd) => {
                  // 扁平索引: 注意要算上之前组的 items
                  const idx = flatItems.indexOf(cmd)
                  const active = idx === focusIdx
                  return (
                    <CommandRow
                      key={cmd.id}
                      cmd={cmd}
                      active={active}
                      idx={idx}
                      onMouseEnter={() => setFocusIdx(idx)}
                      onClick={() => handleClick(cmd)}
                    />
                  )
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

interface CommandRowProps {
  cmd: Command
  active: boolean
  idx: number
  onMouseEnter: () => void
  onClick: () => void
}

function CommandRow({ cmd, active, idx, onMouseEnter, onClick }: CommandRowProps) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      data-cmd-idx={idx}
      onMouseEnter={onMouseEnter}
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2 text-left text-sm transition-colors ${
        active ? 'bg-primary/15 text-text-primary' : 'text-text-secondary hover:bg-background-hover'
      }`}
    >
      <span
        className={`w-6 h-6 rounded flex items-center justify-center text-[12px] shrink-0 ${
          active ? 'bg-primary text-white' : 'bg-background-surface text-text-secondary'
        }`}
        aria-hidden="true"
      >
        {cmd.icon ?? '•'}
      </span>
      <span className="flex-1 truncate text-text-primary">{cmd.title}</span>
      {cmd.description && (
        <span className="text-[11px] text-text-tertiary truncate max-w-[40%]">
          {cmd.description}
        </span>
      )}
      {cmd.shortcut && (
        <span className="flex gap-1 shrink-0">
          {cmd.shortcut.map((k, i) => (
            <kbd
              key={i}
              className="text-[10px] px-1.5 py-0.5 bg-background-surface rounded text-text-tertiary"
            >
              {k}
            </kbd>
          ))}
        </span>
      )}
    </button>
  )
}
