/**
 * 快捷键查看面板
 *
 * 展示所有已注册快捷键，支持分类浏览和搜索。
 * 当前阶段：只读展示。后续阶段：支持自定义修改。
 */

import { useEffect, useState, useMemo } from 'react'
import { Search, Keyboard, Monitor, Info } from 'lucide-react'
import {
  useShortcutsStore,
  CATEGORY_META,
  type ShortcutCategory,
  type ShortcutDefinition,
} from '@/stores/shortcutsStore'
import { isTauri } from '@/utils/platform'

const CATEGORY_ORDER: ShortcutCategory[] = [
  'global', 'editor', 'lsp', 'chat', 'fileExplorer', 'diff', 'terminal', 'voice',
]

function ShortcutRow({ shortcut, locale }: { shortcut: ShortcutDefinition; locale: string }) {
  const label = locale === 'en' ? shortcut.labelEn : shortcut.label
  const desc = locale === 'en' ? shortcut.descriptionEn : shortcut.description

  if (shortcut.desktopOnly && !isTauri()) return null

  return (
    <div className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-surface/50 transition-colors group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm text-text-primary">{label}</span>
          {shortcut.customizable && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">
              {locale === 'en' ? 'Configurable' : '可自定义'}
            </span>
          )}
        </div>
        {desc && (
          <div className="text-xs text-text-muted mt-0.5 truncate">{desc}</div>
        )}
      </div>
      <div className="flex items-center gap-1.5 ml-4 flex-shrink-0">
        {shortcut.keys.split('+').map((part, i) => (
          <span key={i}>
            <kbd className="inline-flex items-center justify-center min-w-[24px] h-6 px-1.5 text-xs font-mono font-medium text-text-primary bg-background-elevated border border-border-subtle rounded shadow-sm">
              {part}
            </kbd>
            {i < shortcut.keys.split('+').length - 1 && (
              <span className="text-[10px] text-text-muted mx-0.5">+</span>
            )}
          </span>
        ))}
      </div>
    </div>
  )
}

function CategorySection({
  category,
  shortcuts,
  locale,
}: {
  category: ShortcutCategory
  shortcuts: ShortcutDefinition[]
  locale: string
}) {
  const meta = CATEGORY_META[category]
  const filtered = useMemo(() => {
    return shortcuts.filter(s => {
      if (s.desktopOnly && !isTauri()) return false
      return true
    })
  }, [shortcuts])

  if (filtered.length === 0) return null

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2 px-3">
        <span className="text-base">{meta.icon}</span>
        <h4 className="text-sm font-semibold text-text-primary">
          {locale === 'en' ? meta.labelEn : meta.label}
        </h4>
        <span className="text-xs text-text-muted">({filtered.length})</span>
      </div>
      <div className="space-y-0.5">
        {filtered.map(shortcut => (
          <ShortcutRow key={shortcut.id} shortcut={shortcut} locale={locale} />
        ))}
      </div>
    </div>
  )
}

export function ShortcutsTab() {
  const { shortcuts, locale, refresh, setLocale } = useShortcutsStore()
  const [searchQuery, setSearchQuery] = useState('')

  useEffect(() => {
    refresh()
  }, [refresh])

  const filteredByCategory = useMemo(() => {
    const query = searchQuery.toLowerCase()
    const result: Record<ShortcutCategory, ShortcutDefinition[]> = {
      global: [], editor: [], lsp: [], chat: [], fileExplorer: [], diff: [], terminal: [], voice: [],
    }

    for (const s of shortcuts) {
      if (s.desktopOnly && !isTauri()) continue

      if (query) {
        const label = locale === 'en' ? s.labelEn : s.label
        const desc = locale === 'en' ? s.descriptionEn : s.description
        const match =
          label.toLowerCase().includes(query) ||
          (desc ?? '').toLowerCase().includes(query) ||
          s.keys.toLowerCase().includes(query)
        if (!match) continue
      }

      result[s.category].push(s)
    }

    return result
  }, [shortcuts, searchQuery, locale])

  const hasResults = CATEGORY_ORDER.some(cat => filteredByCategory[cat].length > 0)

  return (
    <div className="space-y-4">
      {/* 说明卡片 */}
      <div className="flex items-start gap-3 p-3 bg-primary/5 border border-primary/20 rounded-lg">
        <Info size={16} className="text-primary flex-shrink-0 mt-0.5" />
        <div className="text-xs text-text-secondary leading-relaxed">
          {locale === 'en'
            ? 'All keyboard shortcuts in the application are listed below. Customizable shortcuts are marked. Modification support will be available in a future update.'
            : '以下列出应用中所有键盘快捷键。标注「可自定义」的快捷键后续支持修改。'}
        </div>
      </div>

      {/* 搜索 + 语言切换 */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={locale === 'en' ? 'Search shortcuts...' : '搜索快捷键...'}
            className="w-full bg-surface border border-border-subtle rounded-lg pl-8 pr-3 py-2 text-sm text-text-primary placeholder-text-muted focus:outline-none focus:border-primary"
          />
        </div>
        <button
          onClick={() => setLocale(locale === 'zh-CN' ? 'en-US' : 'zh-CN')}
          className="flex items-center gap-1.5 px-3 py-2 text-xs rounded-lg border border-border-subtle text-text-secondary hover:border-primary hover:text-primary transition-colors"
        >
          <Monitor size={13} />
          {locale === 'zh-CN' ? 'English' : '中文'}
        </button>
      </div>

      {/* 快捷键列表 */}
      <div className="space-y-2">
        {hasResults ? (
          CATEGORY_ORDER.map(cat => (
            <CategorySection
              key={cat}
              category={cat}
              shortcuts={filteredByCategory[cat]}
              locale={locale}
            />
          ))
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-text-muted">
            <Keyboard size={32} className="mb-3 opacity-50" />
            <span className="text-sm">
              {locale === 'en' ? 'No shortcuts match your search' : '没有匹配的快捷键'}
            </span>
          </div>
        )}
      </div>

      {/* 统计 */}
      <div className="text-xs text-text-muted text-center pt-2 border-t border-border-subtle">
        {locale === 'en'
          ? `Total: ${shortcuts.filter(s => !s.desktopOnly || isTauri()).length} shortcuts`
          : `共 ${shortcuts.filter(s => !s.desktopOnly || isTauri()).length} 个快捷键`}
      </div>
    </div>
  )
}
