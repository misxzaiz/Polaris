/**
 * BrowserSidebarPanel - 浏览器管理中心（左侧边栏面板）
 *
 * 替代原有的 BrowserLauncherPanel，提供：
 *   - 快捷访问（可编辑网格）
 *   - 历史记录（自动追踪，按时间线分组）
 *   - AI 信息源（一键发送给 AI + 项目信息源预设）
 *   - 底部状态栏（当前浏览器标签联动）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import {
  Globe2,
  Plus,
  History,
  Bookmark,
  Sparkles,
  Send,
  Copy,
  X,
  Star,
  Search,
  Loader2,
  Camera,
  MessageSquare,
  Check,
  Target,
  ChevronDown,
} from 'lucide-react'
import { useTabStore, type TabStore } from '@/stores/tabStore'
import { useViewStore } from '@/stores/viewStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useToastStore } from '@/stores/toastStore'
import { useBrowserSidebarStore, type SidebarTabName, type ShortcutItem } from '@/stores/browserSidebarStore'
import { useMarqueeStore } from '@/stores/marqueeStore'
import { normalizeBrowserUrl, type BrowserNetworkInfo, type MarqueeContextBlock } from '@/services/tauri/browserService'

// ─── 常量 ───────────────────────────────────────────

const MAX_HISTORY_PER_GROUP = 20

// ─── 工具函数 ───────────────────────────────────────

function formatTimeAgo(timestamp: number): string {
  const diff = Date.now() - timestamp
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天前`
  return new Date(timestamp).toLocaleDateString()
}

function getHostname(url: string): string {
  try { return new URL(url).hostname || url } catch { return url }
}

function groupHistoryByDate(history: { id: string; timestamp: number; title: string; url: string }[]) {
  const groups: { label: string; items: typeof history }[] = []
  const today = new Date()
  const todayStr = today.toDateString()
  const yesterdayStr = new Date(today.getTime() - 86400000).toDateString()

  let currentGroup: { label: string; items: typeof history } | null = null

  for (const item of history) {
    const itemDate = new Date(item.timestamp).toDateString()
    let label: string
    if (itemDate === todayStr) label = '今天'
    else if (itemDate === yesterdayStr) label = '昨天'
    else label = new Date(item.timestamp).toLocaleDateString()

    if (!currentGroup || currentGroup.label !== label) {
      currentGroup = { label, items: [] }
      groups.push(currentGroup)
    }
    currentGroup.items.push(item)
  }

  return groups
}

// ─── 稳定 selector 引用（定义在组件外，避免 inline 函数导致 useSyncExternalStore 反复重建） ──

const selectActiveBrowserUrl = (s: TabStore) => {
  const tab = s.tabs.find((t) => t.type === 'browser' && t.id === s.activeTabId)
  return tab?.metadata?.currentUrl as string | undefined
}

const selectActiveBrowserTitle = (s: TabStore) => {
  const tab = s.tabs.find((t) => t.type === 'browser' && t.id === s.activeTabId)
  return tab?.title
}

// 当前浏览器标签的网络信息（BrowserPanel 轮询写入 tabStore.metadata.networkInfo）
const selectActiveBrowserNetworkInfo = (s: TabStore) => {
  const tab = s.tabs.find((t) => t.type === 'browser' && t.id === s.activeTabId)
  return tab?.metadata?.networkInfo as BrowserNetworkInfo | undefined
}

// 注意：不能返回对象字面量，否则 useSyncExternalStore 的 Object.is 比较会认为每次都是新值，触发无限循环
// 改为返回原始值或 null，由组件内部组合

// ─── Tab 按钮组件 ──────────────────────────────────

function TabButton({ label, icon, active, count, onClick }: {
  label: string
  icon: React.ReactNode
  active: boolean
  count?: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex flex-1 min-w-0 items-center justify-center gap-1 px-1 py-2 text-xs font-medium border-b-2 transition-colors whitespace-nowrap',
        active
          ? 'text-primary border-primary'
          : 'text-text-tertiary border-transparent hover:text-text-secondary'
      )}
      title={label}
    >
      <span className="shrink-0">{icon}</span>
      <span className="truncate hidden sm:inline">{label}</span>
      {count !== undefined && count > 0 && (
        <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-primary">
          {count}
        </span>
      )}
    </button>
  )
}

// ─── 快捷访问 Tab ──────────────────────────────────

function QuickAccessTab({ onNavigate }: { onNavigate: (url: string) => void }) {
  const { t } = useTranslation('common')
  const shortcuts = useBrowserSidebarStore((s) => s.shortcuts)
  const addShortcut = useBrowserSidebarStore((s) => s.addShortcut)
  const removeShortcut = useBrowserSidebarStore((s) => s.removeShortcut)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editLabel, setEditLabel] = useState('')
  const [editUrl, setEditUrl] = useState('')
  const [showAddForm, setShowAddForm] = useState(false)
  const [addUrl, setAddUrl] = useState('')
  const [addLabel, setAddLabel] = useState('')

  const sorted = useMemo(
    () => [...shortcuts].sort((a, b) => a.order - b.order),
    [shortcuts]
  )

  const handleStartEdit = (item: ShortcutItem) => {
    setEditingId(item.id)
    setEditLabel(item.label)
    setEditUrl(item.url)
  }

  const handleSaveEdit = () => {
    if (!editingId) return
    const store = useBrowserSidebarStore.getState()
    store.updateShortcut(editingId, { label: editLabel || editUrl, url: editUrl })
    setEditingId(null)
  }

  const handleAdd = () => {
    if (!addUrl.trim()) return
    addShortcut(normalizeBrowserUrl(addUrl), addLabel.trim() || undefined)
    setAddUrl('')
    setAddLabel('')
    setShowAddForm(false)
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-1.5">
        {sorted.map((item) => (
          <div key={item.id} className="relative group">
            {editingId === item.id ? (
              <div className="flex flex-col gap-1 rounded-md border border-primary/60 bg-background-surface p-1.5">
                <input
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  className="h-6 rounded bg-background-base px-1.5 text-xs text-text-primary outline-none"
                  placeholder="标签"
                  autoFocus
                />
                <input
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  className="h-6 rounded bg-background-base px-1.5 text-xs text-text-primary outline-none"
                  placeholder="网址"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveEdit(); if (e.key === 'Escape') setEditingId(null) }}
                />
                <div className="flex gap-1">
                  <button onClick={handleSaveEdit} className="flex-1 rounded bg-primary/20 py-0.5 text-[10px] text-primary">保存</button>
                  <button onClick={() => setEditingId(null)} className="flex-1 rounded bg-background-hover py-0.5 text-[10px] text-text-tertiary">取消</button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => onNavigate(item.url)}
                onContextMenu={(e) => { e.preventDefault(); handleStartEdit(item) }}
                className="flex w-full items-center gap-1.5 rounded-md border border-border-subtle bg-background-surface px-2 py-1.5 text-left text-xs text-text-secondary transition-colors hover:border-primary/40 hover:bg-background-hover hover:text-text-primary"
                title={`${item.label}\n${item.url}\n${t('browser.sidebar.rightClickEdit', { defaultValue: '右键编辑' })}`}
              >
                <Globe2 size={12} className="shrink-0 text-text-tertiary" />
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.pinned && <Star size={10} className="shrink-0 text-warning" />}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); removeShortcut(item.id) }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); removeShortcut(item.id) } }}
                  className="shrink-0 cursor-pointer rounded p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger"
                  title={t('buttons.remove')}
                >
                  <X size={10} />
                </span>
              </button>
            )}
          </div>
        ))}
        {showAddForm ? (
          <div className="flex flex-col gap-1 rounded-md border border-primary/60 bg-background-surface p-1.5">
            <input
              value={addUrl}
              onChange={(e) => setAddUrl(e.target.value)}
              className="h-6 rounded bg-background-base px-1.5 text-xs text-text-primary outline-none"
              placeholder={t('browser.sidebar.enterUrl', { defaultValue: '网址' })}
              autoFocus
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowAddForm(false) }}
            />
            <input
              value={addLabel}
              onChange={(e) => setAddLabel(e.target.value)}
              className="h-6 rounded bg-background-base px-1.5 text-xs text-text-primary outline-none"
              placeholder={t('browser.sidebar.enterLabel', { defaultValue: '标签（可选）' })}
              onKeyDown={(e) => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setShowAddForm(false) }}
            />
            <div className="flex gap-1">
              <button onClick={handleAdd} className="flex-1 rounded bg-primary/20 py-0.5 text-[10px] text-primary"><Check size={10} className="inline mr-0.5" />{t('buttons.confirm', { defaultValue: '确认' })}</button>
              <button onClick={() => setShowAddForm(false)} className="flex-1 rounded bg-background-hover py-0.5 text-[10px] text-text-tertiary">{t('buttons.cancel', { defaultValue: '取消' })}</button>
            </div>
          </div>
        ) : (
          <button
            onClick={() => setShowAddForm(true)}
            className="flex items-center justify-center gap-1 rounded-md border border-dashed border-border-subtle bg-background-surface/50 px-2 py-1.5 text-xs text-text-tertiary transition-colors hover:border-primary/40 hover:text-primary"
          >
            <Plus size={12} />
            <span>{t('browser.sidebar.addShortcut', { defaultValue: '新增' })}</span>
          </button>
        )}
      </div>
    </div>
  )
}

// ─── 历史记录 Tab ──────────────────────────────────

function HistoryTab({ onNavigate }: { onNavigate: (url: string) => void }) {
  const { t } = useTranslation('common')
  const history = useBrowserSidebarStore((s) => s.history)
  const clearHistory = useBrowserSidebarStore((s) => s.clearHistory)
  const removeHistoryEntry = useBrowserSidebarStore((s) => s.removeHistoryEntry)

  const groups = useMemo(() => groupHistoryByDate(history), [history])

  return (
    <div className="flex flex-col gap-1">
      {groups.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <History size={24} className="text-text-tertiary" />
          <div className="text-xs text-text-tertiary">
            {t('browser.sidebar.noHistory', { defaultValue: '打开网页后，历史将在此显示' })}
          </div>
        </div>
      ) : (
        groups.slice(0, 3).map((group) => (
          <div key={group.label}>
            <div className="px-1 py-1 text-[11px] font-medium text-text-tertiary">
              ▸ {group.label}
            </div>
            {group.items.slice(0, MAX_HISTORY_PER_GROUP).map((item) => (
              <div
                key={item.id}
                className="group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-background-hover"
                onClick={() => onNavigate(item.url)}
              >
                <Globe2 size={12} className="shrink-0 text-text-tertiary" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-text-primary">{item.title}</div>
                  <div className="flex gap-2 text-[10px] text-text-tertiary">
                    <span className="max-w-[100px] truncate">{getHostname(item.url)}</span>
                    <span>{formatTimeAgo(item.timestamp)}</span>
                  </div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); removeHistoryEntry(item.id) }}
                  className="shrink-0 rounded p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger"
                  title={t('buttons.remove')}
                >
                  <X size={10} />
                </button>
              </div>
            ))}
          </div>
        ))
      )}
      {groups.length > 0 && (
        <button
          onClick={clearHistory}
          className="mt-1 rounded px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:bg-background-hover hover:text-danger"
        >
          {t('browser.sidebar.clearHistory', { defaultValue: '🗑️ 清除全部历史' })}
        </button>
      )}
    </div>
  )
}

// ─── AI 信息源 Tab ─────────────────────────────────

function AiSourceTab({ onNavigate }: { onNavigate: (url: string) => void }) {
  const { t } = useTranslation('common')
  const aiSources = useBrowserSidebarStore((s) => s.aiSources)
  const injectedHistory = useBrowserSidebarStore((s) => s.injectedHistory)
  const addAiSource = useBrowserSidebarStore((s) => s.addAiSource)
  const removeAiSource = useBrowserSidebarStore((s) => s.removeAiSource)
  const toggleAutoReference = useBrowserSidebarStore((s) => s.toggleAutoReference)
  const addInjectedEntry = useBrowserSidebarStore((s) => s.addInjectedEntry)
  const toast = useToastStore()
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
  const [note, setNote] = useState('')
  const [sendMethod, setSendMethod] = useState<'full' | 'screenshot'>('full')
  const [sending, setSending] = useState(false)
  const marqueeBlocks = useMarqueeStore((s) => s.blocks)
  const removeMarqueeBlock = useMarqueeStore((s) => s.removeBlock)

  // 从左侧边栏移除圈选块：同步清空活跃会话输入框中的上下文块（统一走 removeContextBlock）
  const handleRemoveMarquee = useCallback(async (id: string) => {
    removeMarqueeBlock(id)
    const { useActiveSessionActions } = await import('@/stores/conversationStore/useActiveSession')
    const { removeContextBlock } = useActiveSessionActions()
    removeContextBlock(id)
  }, [removeMarqueeBlock])

  // 从 tabStore 获取当前浏览器标签信息
  // 使用原始值 selector，避免对象引用变化导致 useSyncExternalStore 无限循环
  const currentUrl = useTabStore(selectActiveBrowserUrl)
  const currentTitle = useTabStore(selectActiveBrowserTitle)
  const currentTab = useMemo(() => {
    if (!currentUrl) return null
    return { url: currentUrl, title: currentTitle || 'Browser' }
  }, [currentUrl, currentTitle])

  const handleSendToAi = useCallback(async () => {
    // 惰性获取 sendMessage，避免组件初始化时调用 useActiveSessionActions
    const { useActiveSessionActions } = await import('@/stores/conversationStore/useActiveSession')
    const { sendMessage } = useActiveSessionActions()

    if (!currentTab?.url) {
      toast.error(t('browser.sidebar.noBrowserTab', { defaultValue: '没有打开的浏览器标签' }))
      return
    }
    if (!currentWorkspace) {
      toast.error(t('messages.noWorkspace'))
      return
    }

    setSending(true)
    try {
      const header = `📤 来自浏览器：${currentTab.title}`
      const urlLine = currentTab.url
      const noteLine = note.trim() ? `\n\n📝 ${note.trim()}` : ''
      const methodLabel = sendMethod === 'full' ? '📋 全文模式' : '📸 截图模式'
      const message = `${header}\n${urlLine}\n\`\`\`\n${methodLabel}\n\`\`\`${noteLine}`

      await sendMessage(message, currentWorkspace.path)

      // 记录注入历史
      addInjectedEntry({
        url: currentTab.url,
        title: currentTab.title,
        method: sendMethod,
        note: note.trim() || undefined,
      })

      setNote('')
      toast.success(t('browser.sidebar.sentToAi', { defaultValue: '已发送给 AI' }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSending(false)
    }
  }, [currentTab, currentWorkspace, note, sendMethod, addInjectedEntry, toast, t])

  const handleAddSource = useCallback(() => {
    if (!currentTab?.url) {
      toast.error(t('browser.sidebar.noBrowserTab', { defaultValue: '没有打开的浏览器标签' }))
      return
    }
    addAiSource(currentTab.url, currentTab.title, false)
    toast.success(t('browser.sidebar.sourceAdded', { defaultValue: '已添加到信息源' }))
  }, [currentTab, addAiSource, toast, t])

  return (
    <div className="flex flex-col gap-3">
      {/* 圈选区域（浏览器圈选，供发送前/后复核） */}
      {marqueeBlocks.length > 0 && <MarqueeSection blocks={marqueeBlocks} onRemove={handleRemoveMarquee} />}

      {/* 发送当前页面卡片 */}
      <div className="rounded-md border border-border-subtle bg-background-surface p-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text-primary">
          <Send size={13} className="text-primary" />
          <span>{t('browser.sidebar.sendCurrentPage', { defaultValue: '发送当前页面给 AI' })}</span>
        </div>
        {currentTab ? (
          <>
            <div className="mb-1.5 truncate text-[11px] text-text-tertiary" title={currentTab.url}>
              {currentTab.title} — {getHostname(currentTab.url)}
            </div>
            <div className="mb-2 flex gap-1.5">
              <button
                onClick={() => setSendMethod('full')}
                className={clsx(
                  'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
                  sendMethod === 'full'
                    ? 'bg-primary/20 text-primary'
                    : 'border border-border-subtle text-text-tertiary hover:text-text-secondary'
                )}
              >
                <MessageSquare size={11} className="inline mr-0.5" />
                {t('browser.sidebar.fullText', { defaultValue: '全文' })}
              </button>
              <button
                onClick={() => setSendMethod('screenshot')}
                className={clsx(
                  'rounded-full px-2.5 py-0.5 text-[11px] transition-colors',
                  sendMethod === 'screenshot'
                    ? 'bg-primary/20 text-primary'
                    : 'border border-border-subtle text-text-tertiary hover:text-text-secondary'
                )}
              >
                <Camera size={11} className="inline mr-0.5" />
                {t('browser.sidebar.screenshot', { defaultValue: '截图' })}
              </button>
            </div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('browser.sidebar.sendNotePlaceholder', { defaultValue: '📝 附言：想对当前页面做什么？' })}
              className="mb-2 w-full rounded-md border border-border-subtle bg-background-base px-2.5 py-1.5 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-primary/70"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendToAi() } }}
            />
            <button
              onClick={handleSendToAi}
              disabled={sending}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {sending ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
              {t('browser.sidebar.sendToAi', { defaultValue: '发送给 AI' })}
            </button>
          </>
        ) : (
          <div className="py-2 text-[11px] text-text-tertiary">
            {t('browser.sidebar.noBrowserTabHint', { defaultValue: '打开浏览器标签后，可在此发送页面给 AI' })}
          </div>
        )}
      </div>

      {/* 项目信息源 */}
      <div>
        <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-medium text-text-tertiary">
          <Bookmark size={11} />
          <span>{t('browser.sidebar.projectSources', { defaultValue: '项目信息源' })}</span>
        </div>
        {aiSources.length === 0 ? (
          <div className="px-1 text-[11px] text-text-tertiary">
            {t('browser.sidebar.noSources', { defaultValue: '添加常用页面作为 AI 的参考信息源' })}
          </div>
        ) : (
          aiSources.map((source) => (
            <div
              key={source.id}
              className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-text-secondary transition-colors hover:bg-background-hover"
            >
              <button
                onClick={() => toggleAutoReference(source.id)}
                className={clsx(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors',
                  source.autoReference
                    ? 'border-primary bg-primary text-white'
                    : 'border-border-subtle text-transparent'
                )}
                title={source.autoReference
                  ? t('browser.sidebar.disableAutoRef', { defaultValue: '关闭自动参考' })
                  : t('browser.sidebar.enableAutoRef', { defaultValue: '开启自动参考' })
                }
              >
                {source.autoReference && '✓'}
              </button>
              <span
                className="min-w-0 flex-1 cursor-pointer truncate hover:text-text-primary"
                onClick={() => onNavigate(source.url)}
                title={source.url}
              >
                {source.title}
              </span>
              <button
                onClick={() => removeAiSource(source.id)}
                className="shrink-0 rounded p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger"
              >
                <X size={10} />
              </button>
            </div>
          ))
        )}
        <button
          onClick={handleAddSource}
          className="mt-1 flex w-full items-center justify-center gap-1 rounded border border-dashed border-border-subtle px-2 py-1 text-[11px] text-text-tertiary transition-colors hover:border-primary/40 hover:text-primary"
        >
          <Plus size={10} />
          {t('browser.sidebar.addSource', { defaultValue: '添加当前页面' })}
        </button>
      </div>

      {/* 最近注入 */}
      {injectedHistory.length > 0 && (
        <div>
          <div className="mb-1 flex items-center gap-1 px-1 text-[11px] font-medium text-text-tertiary">
            <Sparkles size={11} />
            <span>{t('browser.sidebar.recentInjected', { defaultValue: '最近注入' })}</span>
          </div>
          {injectedHistory.slice(0, 5).map((entry) => (
            <div key={entry.id} className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-text-tertiary">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
              <span className="min-w-0 flex-1 truncate">
                {entry.title} — {entry.method === 'full' ? '全文' : '截图'}
                {entry.note ? `: ${entry.note}` : ''}
              </span>
              <span className="shrink-0">{formatTimeAgo(entry.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 圈选区域区块（AI 信息源 tab 顶部） ─────────────────

function MarqueeSection({
  blocks,
  onRemove,
}: {
  blocks: MarqueeContextBlock[]
  onRemove: (id: string) => void
}) {
  const { t } = useTranslation('common')
  const [expandedMap, setExpandedMap] = useState<Record<string, boolean>>({})

  return (
    <div className="rounded-md border border-primary/25 bg-primary/5 p-2">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-primary">
        <Target size={12} />
        <span>{t('browser.sidebar.marqueeTitle', { defaultValue: '圈选区域' })}</span>
        <span className="ml-auto rounded-full bg-primary/15 px-1.5 py-px text-[10px]">
          {blocks.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        {blocks.map((block) => {
          const expanded = expandedMap[block.id]
          return (
            <div key={block.id} className="rounded-md border border-border-subtle bg-background-surface">
              <div className="flex items-center gap-1.5 px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => setExpandedMap((m) => ({ ...m, [block.id]: !expanded }))}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  <ChevronDown size={11} className={`shrink-0 text-text-tertiary transition-transform ${expanded ? 'rotate-180' : ''}`} />
                  <span className="shrink-0 text-[11px] font-medium text-text-primary">
                    {block.regions.length} 个区域
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-text-tertiary">
                    {block.regions.map((r) => `${Math.round(r.rect.width)}×${Math.round(r.rect.height)}`).join(' · ')}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(block.id)}
                  className="shrink-0 rounded p-0.5 text-text-tertiary hover:text-danger"
                  title={t('browser.sidebar.marqueeRemove', { defaultValue: '移除' })}
                >
                  <X size={11} />
                </button>
              </div>
              {expanded && (
                <div className="border-t border-border-subtle px-2 py-1.5">
                  <div className="truncate text-[10px] text-text-tertiary" title={block.url}>
                    {block.title || 'Browser'} · {block.url}
                  </div>
                  <div className="mt-1 flex flex-col gap-1">
                    {block.regions.map((region, idx) => (
                      <div key={idx} className="rounded bg-background-elevated px-1.5 py-1">
                        <div className="flex items-center gap-1 text-[10px] font-mono text-text-tertiary">
                          <span className="rounded bg-primary/15 px-1 font-medium text-primary">{idx + 1}</span>
                          <span>({Math.round(region.rect.x)},{Math.round(region.rect.y)})</span>
                          <span>{Math.round(region.rect.width)}×{Math.round(region.rect.height)}</span>
                          <span>· {region.count} 元素</span>
                        </div>
                        {region.elements.length > 0 && (
                          <div className="mt-0.5 line-clamp-1 text-[10px] text-text-secondary">
                            {region.elements.slice(0, 3).map((e) => `${e.kind} "${e.text}"`).join(' · ')}
                          </div>
                        )}
                        {region.textSnippet && (
                          <div className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-[10px] text-text-secondary">
                            {region.textSnippet}
                          </div>
                        )}
                        {region.htmlSnippet && (
                          <pre className="mt-1 max-h-12 overflow-auto rounded bg-background-surface px-1 py-0.5 text-[9px] font-mono text-text-tertiary whitespace-pre-wrap break-all">
                            {region.htmlSnippet}
                          </pre>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <div className="mt-1.5 text-[9.5px] text-text-tertiary">
        {t('browser.sidebar.marqueeHint', {
          defaultValue: '圈选区已挂到 AI 输入框，发送时作为上下文附带给 AI',
        })}
      </div>
    </div>
  )
}

// ─── 底部状态栏 ────────────────────────────────────

function BottomStatusBar({ onSendToAi }: { onSendToAi: () => void }) {
  const { t } = useTranslation('common')
  // 使用原始值 selector，避免对象引用变化导致 useSyncExternalStore 无限循环
  const currentUrl = useTabStore(selectActiveBrowserUrl)
  const currentTitle = useTabStore(selectActiveBrowserTitle)
  const networkInfo = useTabStore(selectActiveBrowserNetworkInfo)
  const currentTab = useMemo(() => {
    if (!currentUrl) return null
    return { url: currentUrl, title: currentTitle || 'Browser' }
  }, [currentUrl, currentTitle])
  const toast = useToastStore()

  const handleCopyUrl = useCallback(async () => {
    if (!currentTab?.url) return
    try {
      await navigator.clipboard.writeText(currentTab.url)
      toast.success(t('buttons.copied'))
    } catch {
      toast.error(t('browser.copyFailed', { defaultValue: '复制地址失败' }))
    }
  }, [currentTab, toast, t])

  // 网络信息内联展示（不弹窗），字段缺失时返回 '-' 占位
  const netFields = useMemo(() => {
    const n = networkInfo
    return [
      { key: 'load', label: t('browser.net.load', { defaultValue: '加载' }), value: n ? `${(n.loadTime / 1000).toFixed(2)}s` : '-' },
      { key: 'size', label: t('browser.net.size', { defaultValue: '大小' }), value: n ? `${n.totalSizeKB.toFixed(1)}KB` : '-' },
      { key: 'res', label: t('browser.net.resources', { defaultValue: '资源' }), value: n ? String(n.resourceCount) : '-' },
      { key: 'fail', label: t('browser.net.failed', { defaultValue: '失败' }), value: n ? String(n.failedResources) : '-' },
    ]
  }, [networkInfo, t])

  return (
    <div className="flex shrink-0 flex-col border-t border-border-subtle bg-background-elevated px-3 py-2">
      {/* 第一行：标签 + 操作 */}
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            currentTab ? 'bg-success' : 'bg-text-tertiary'
          )}
          title={currentTab
            ? t('status.ready', { defaultValue: '已就绪' })
            : t('browser.sidebar.noTab', { defaultValue: '无浏览器标签' })
          }
        />
        <div className="min-w-0 flex-1">
          {currentTab ? (
            <>
              <div className="truncate text-xs font-medium text-text-primary">{currentTab.title}</div>
              <div className="truncate text-[10px] text-text-tertiary">{getHostname(currentTab.url)}</div>
            </>
          ) : (
            <div className="text-xs text-text-tertiary">
              {t('browser.sidebar.noTab', { defaultValue: '暂无打开的浏览器标签' })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 gap-1">
          <button
            onClick={handleCopyUrl}
            disabled={!currentTab}
            className="flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
            title={t('browser.copyUrl', { defaultValue: '复制地址' })}
          >
            <Copy size={13} />
          </button>
          <button
            onClick={onSendToAi}
            disabled={!currentTab}
            className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-2 text-[11px] font-medium text-white transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-40"
            title={t('browser.sidebar.sendToAi', { defaultValue: '发送给 AI' })}
          >
            <Send size={11} />
            <span className="hidden sm:inline">{t('browser.sidebar.sendToAi', { defaultValue: '发送给 AI' })}</span>
          </button>
        </div>
      </div>
      {/* 第二行：网络信息（内联展示，不弹窗） */}
      {currentTab && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border-subtle pt-1.5 text-[10px] text-text-tertiary">
          {netFields.map((f) => (
            <span key={f.key} className="flex items-center gap-1">
              <span>{f.label}</span>
              <span className={clsx('font-mono', f.key === 'fail' && Number(f.value) > 0 && 'text-warning')}>{f.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── 搜索组件 ──────────────────────────────────────

function SearchBar({ onSearch }: { onSearch: (query: string) => void }) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')

  return (
    <div className="shrink-0 border-b border-border-subtle px-3 py-2">
      <div className="flex items-center gap-1.5 rounded-md border border-border-subtle bg-background-surface px-2 transition-colors focus-within:border-primary/70">
        <Search size={13} className="shrink-0 text-text-tertiary" />
        <input
          value={query}
          onChange={(e) => { setQuery(e.target.value); onSearch(e.target.value) }}
          className="h-7 min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-tertiary"
          placeholder={t('browser.sidebar.searchPlaceholder', { defaultValue: '搜索网址、历史...' })}
        />
        {query && (
          <button
            onClick={() => { setQuery(''); onSearch('') }}
            className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:text-text-primary"
          >
            <X size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── 主面板 ────────────────────────────────────────

export function BrowserSidebarPanel() {
  const { t } = useTranslation('common')
  const activeTabName = useBrowserSidebarStore((s) => s.activeTabName)
  const setActiveTabName = useBrowserSidebarStore((s) => s.setActiveTabName)
  const addHistory = useBrowserSidebarStore((s) => s.addHistory)
  const openBrowserTab = useTabStore((s) => s.openBrowserTab)
  const closeLeftPanel = useViewStore((s) => s.closeLeftPanel)
  const toast = useToastStore()
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
  const [searchQuery, setSearchQuery] = useState('')

  // 使用稳定 selector 引用（定义在组件外），避免 inline 函数导致 useSyncExternalStore 反复重建
  const activeBrowserUrl = useTabStore(selectActiveBrowserUrl)
  const activeBrowserTitle = useTabStore(selectActiveBrowserTitle)

  useEffect(() => {
    if (activeBrowserUrl) {
      addHistory(activeBrowserUrl, activeBrowserTitle || 'Browser')
    }
  }, [activeBrowserUrl, activeBrowserTitle, addHistory])

  const handleNavigate = useCallback((url: string) => {
    const normalized = normalizeBrowserUrl(url)
    openBrowserTab(normalized, 'Browser')
    closeLeftPanel()
  }, [openBrowserTab, closeLeftPanel])

  const handleSendToAi = useCallback(async () => {
    // 直接通过 sessionStoreManager 获取 sendMessage，避免顶层调用 useActiveSessionActions
    const sessionId = sessionStoreManager.getState().activeSessionId
    if (!sessionId) {
      toast.error(t('browser.sidebar.noSession', { defaultValue: '请先创建一个 AI 会话' }))
      return
    }
    const store = sessionStoreManager.getState().stores.get(sessionId)?.getState()
    if (!store?.sendMessage) {
      toast.error(t('browser.sidebar.sessionNotReady', { defaultValue: 'AI 会话尚未就绪，请稍后再试' }))
      return
    }

    const browserTab = useTabStore.getState().tabs.find(
      (t) => t.type === 'browser' && t.id === useTabStore.getState().activeTabId
    )
    if (!browserTab) {
      toast.error(t('browser.sidebar.noBrowserTab', { defaultValue: '没有打开的浏览器标签' }))
      return
    }
    if (!currentWorkspace) {
      toast.error(t('messages.noWorkspace'))
      return
    }

    const url = browserTab.metadata?.currentUrl as string || ''
    const title = browserTab.title || 'Browser'
    const message = `📤 来自浏览器：${title}\n${url}`

    try {
      await store.sendMessage(message, currentWorkspace.path)
      toast.success(t('browser.sidebar.sentToAi', { defaultValue: '已发送给 AI' }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }, [currentWorkspace, toast, t])

  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query)
  }, [])

  // 搜索过滤 — 使用 selector 替代 getState()，确保与 React 渲染周期一致
  const allShortcuts = useBrowserSidebarStore((s) => s.shortcuts)
  const allHistory = useBrowserSidebarStore((s) => s.history)

  const filteredResults = useMemo(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    return {
      shortcuts: allShortcuts.filter(
        (s) => s.label.toLowerCase().includes(q) || s.url.toLowerCase().includes(q)
      ),
      history: allHistory.filter(
        (h) => h.title.toLowerCase().includes(q) || h.url.toLowerCase().includes(q)
      ),
    }
  }, [searchQuery, allShortcuts, allHistory])

  const tabs: { name: SidebarTabName; label: string; icon: React.ReactNode; count?: number }[] = [
    { name: 'quick', label: t('browser.sidebar.quickAccess', { defaultValue: '快捷' }), icon: <Globe2 size={13} /> },
    { name: 'history', label: t('browser.sidebar.history', { defaultValue: '历史' }), icon: <History size={13} /> },
    { name: 'aiSource', label: t('browser.sidebar.aiSource', { defaultValue: 'AI 信息源' }), icon: <Sparkles size={13} /> },
  ]

  return (
    <div data-theme-panel className="flex h-full min-h-0 flex-col bg-background-elevated">
      {/* 标题栏 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <Globe2 size={16} className="text-primary" />
        <span className="flex-1 text-sm font-medium text-text-primary">
          {t('labels.browserPanel', { defaultValue: '浏览器管理中心' })}
        </span>
        <button
          onClick={() => {
            openBrowserTab()
            closeLeftPanel()
          }}
          className="inline-flex h-7 items-center gap-1 rounded-md border border-border-subtle bg-background-surface px-2 text-xs text-text-secondary transition-colors hover:bg-background-hover hover:text-text-primary"
          title={t('browser.openTab', { defaultValue: '打开浏览器标签' })}
        >
          <Plus size={13} />
          <span className="hidden sm:inline">{t('browser.openTab', { defaultValue: '新建标签' })}</span>
        </button>
      </div>

      {/* 搜索框 */}
      <SearchBar onSearch={handleSearch} />

      {/* 搜索结果 */}
      {filteredResults ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {filteredResults.shortcuts.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-medium text-text-tertiary">快捷访问</div>
              {filteredResults.shortcuts.map((s) => (
                <div key={s.id} className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-background-hover" onClick={() => handleNavigate(s.url)}>
                  <Globe2 size={12} className="shrink-0" />
                  <span className="truncate">{s.label}</span>
                  <span className="shrink-0 text-[10px] text-text-tertiary">{getHostname(s.url)}</span>
                </div>
              ))}
            </div>
          )}
          {filteredResults.history.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[11px] font-medium text-text-tertiary">历史记录</div>
              {filteredResults.history.slice(0, 10).map((h) => (
                <div key={h.id} className="flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-secondary hover:bg-background-hover" onClick={() => handleNavigate(h.url)}>
                  <History size={12} className="shrink-0" />
                  <span className="truncate">{h.title}</span>
                  <span className="shrink-0 text-[10px] text-text-tertiary">{formatTimeAgo(h.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
          {!filteredResults.shortcuts.length && !filteredResults.history.length && (
            <div className="flex items-center justify-center py-8 text-xs text-text-tertiary">
              {t('browser.sidebar.noSearchResults', { defaultValue: '未找到匹配结果' })}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Tab 切换栏 */}
          <div className="flex shrink-0 border-b border-border-subtle px-2">
            {tabs.map((tab) => (
              <TabButton
                key={tab.name}
                name={tab.name}
                label={tab.label}
                icon={tab.icon}
                active={activeTabName === tab.name}
                count={tab.count}
                onClick={() => setActiveTabName(tab.name)}
              />
            ))}
          </div>

          {/* Tab 内容 */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
            {activeTabName === 'quick' && <QuickAccessTab onNavigate={handleNavigate} />}
            {activeTabName === 'history' && <HistoryTab onNavigate={handleNavigate} />}
            {activeTabName === 'aiSource' && <AiSourceTab onNavigate={handleNavigate} />}
          </div>
        </>
      )}

      {/* 底部状态栏 */}
      <BottomStatusBar onSendToAi={handleSendToAi} />
    </div>
  )
}