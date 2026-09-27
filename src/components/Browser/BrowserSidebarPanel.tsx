/**
 * BrowserSidebarPanel - 浏览器管理中心（左侧边栏面板）
 *
 * 替代原有的 BrowserLauncherPanel，提供：
 *   - 快捷访问（可编辑网格）
 *   - 底部状态栏（当前浏览器标签联动）
 */

import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { clsx } from 'clsx'
import {
  Globe2,
  Plus,
  Send,
  Copy,
  X,
  Star,
  Search,
  Check,
  Download,
  FolderOpen,
  Trash2,
  RotateCw,
} from 'lucide-react'
import { useTabStore, type TabStore } from '@/stores/tabStore'
import { useViewStore } from '@/stores/viewStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { getKernel } from '@/session-v2/kernel/registry'
import { useToastStore } from '@/stores/toastStore'
import { useBrowserSidebarStore, type SidebarTabName, type ShortcutItem } from '@/stores/browserSidebarStore'
import { useBrowserDownloadStore, selectActiveCount, selectTotalCount, type BrowserDownloadItem } from '@/stores/browserDownloadStore'
import { openInDefaultApp } from '@/services/tauri/windowService'
import { browserNavigate } from '@/services/tauri/browserService'
import { normalizeBrowserUrl, type BrowserNetworkInfo } from '@/services/tauri/browserService'

// ─── 常量 ───────────────────────────────────────────

// ─── 工具函数 ───────────────────────────────────────

function getHostname(url: string): string {
  try { return new URL(url).hostname || url } catch { return url }
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

// ─── 底部状态栏 ────────────────────────────────────

// ─── 下载管理 Tab ──────────────────────────────────────

function downloadIconClass(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || ''
  if (['exe', 'msi', 'dmg', 'apk', 'ipa'].includes(ext)) return 't-exe'
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 't-arc'
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'pdf'].includes(ext)) return 't-doc'
  return 't-gen'
}

function downloadTag(filename: string): string {
  const ext = filename.split('.').pop()?.toUpperCase()
  return ext && ext.length <= 5 ? ext : 'FILE'
}

function formatTime(ts: number): string {
  const diff = Date.now() - ts
  const min = 60 * 1000, hour = 60 * min, day = 24 * hour
  if (diff < min) return '刚刚'
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`
  return `${Math.floor(diff / day)} 天前`
}

function formatSize(bytes: number | null): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DownloadsTab() {
  const { t } = useTranslation('common')
  const items = useBrowserDownloadStore((s) => s.items)
  const remove = useBrowserDownloadStore((s) => s.remove)
  const clearCompleted = useBrowserDownloadStore((s) => s.clearCompleted)
  const toast = useToastStore()
  const [filter, setFilter] = useState<'all' | 'running' | 'done' | 'failed'>('all')

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    if (filter === 'running') return items.filter((i) => i.status === 'downloading')
    if (filter === 'done') return items.filter((i) => i.status === 'completed')
    return items.filter((i) => i.status === 'failed')
  }, [items, filter])

  const handleClear = useCallback(() => {
    if (window.confirm(t('browser.downloadsClearConfirm', { defaultValue: '确定清空所有已完成和失败的下载记录？' }))) {
      clearCompleted()
    }
  }, [clearCompleted, t])

  const handleCopyPath = useCallback(async (path: string) => {
    if (!path) return
    try {
      await navigator.clipboard.writeText(path)
      toast.success(t('buttons.copied', { defaultValue: '已复制' }))
    } catch {
      toast.error(t('browser.copyFailed', { defaultValue: '复制失败' }))
    }
  }, [toast, t])

  const handleRetry = useCallback((item: BrowserDownloadItem) => {
    // blob: URL 重试无意义（已随页面销毁），只重新导航到来源
    if (item.url.startsWith('blob:') || item.url.startsWith('data:')) {
      toast.info(t('browser.downloadFailed', { defaultValue: '下载失败' }), 'blob URL 无法重试，请重新从来源页面导出')
      return
    }
    void browserNavigate(item.label, item.url).catch(() => undefined)
  }, [toast, t])

  const handleRemove = useCallback((id: string) => {
    remove(id)
  }, [remove])

  const isWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border-subtle px-2 py-1.5">
        <span className="flex-1 truncate text-[10px] text-text-tertiary">DataRoot\downloads</span>
        <button
          onClick={() => { /* openDir: openInDefaultApp on a directory path — unsupported in pure web, skip */ }}
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary"
          title={t('browser.downloadsOpenDir', { defaultValue: '打开下载目录' })}
        >
          <FolderOpen size={13} />
        </button>
        <button
          onClick={handleClear}
          disabled={!items.some((i) => i.status !== 'downloading')}
          className="flex h-6 w-6 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-background-hover hover:text-text-primary disabled:opacity-40"
          title={t('browser.downloadsClearCompleted', { defaultValue: '清空已完成' })}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {/* 过滤 */}
      <div className="flex shrink-0 gap-1 px-2 py-1">
        {(['all', 'running', 'done', 'failed'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              'rounded-full px-2 py-0.5 text-[10px] transition-colors',
              filter === f
                ? 'bg-primary/15 text-primary'
                : 'text-text-tertiary hover:bg-background-hover'
            )}
          >
            {t(`browser.downloadsFilter${f.charAt(0).toUpperCase() + f.slice(1)}` as const, { defaultValue: f })}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1">
        {!isWindows ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Download size={32} className="opacity-30" />
            <div className="text-xs text-text-tertiary">{t('browser.downloadsPlatformUnsupported', { defaultValue: '当前平台不支持' })}</div>
            <div className="text-[10px] leading-relaxed text-text-muted">{t('browser.downloadsPlatformHint', { defaultValue: '下载管理器依赖 WebView2 的 DownloadStarting 事件，仅 Windows 平台可用' })}</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <Download size={32} className="opacity-30" />
            <div className="text-xs text-text-tertiary">{t('browser.downloadsEmpty', { defaultValue: '暂无下载记录' })}</div>
            <div className="text-[10px] leading-relaxed text-text-muted">{t('browser.downloadsEmptyHint', { defaultValue: '在浏览器标签页中导出或下载文件，记录会显示在这里' })}</div>
          </div>
        ) : (
          filtered.map((item) => {
            const isExe = /\.(exe|msi|dmg|apk|ipa)$/i.test(item.filename)
            return (
              <div
                key={item.id}
                className="group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-background-hover"
              >
                <div className={clsx('flex h-6 w-6 shrink-0 items-center justify-center rounded text-[9px] font-bold', downloadIconClass(item.filename))}>
                  {downloadTag(item.filename)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-text-primary">
                    {item.filename}
                    {isExe && <span className="ml-1 rounded border border-danger/40 px-1 text-[9px] font-normal text-danger">可执行</span>}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1 text-[10px] text-text-tertiary">
                    <span className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', item.status === 'downloading' ? 'bg-info animate-pulse' : item.status === 'failed' ? 'bg-danger' : 'bg-success')} />
                    <span className={item.status === 'downloading' ? 'text-info' : item.status === 'failed' ? 'text-danger' : 'text-success'}>
                      {item.status === 'downloading' ? '下载中' : item.status === 'failed' ? '失败' : '完成'}
                    </span>
                    {item.error && <span className="text-danger">· {item.error}</span>}
                    {item.size != null && <span className="text-text-muted">· {formatSize(item.size)}</span>}
                    <span className="text-text-muted">· {formatTime(item.createdAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                  {item.status !== 'downloading' && (
                    <button
                      onClick={() => item.path && void openInDefaultApp(item.path)}
                      disabled={!item.path}
                      className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-background-active hover:text-text-primary disabled:opacity-40"
                      title={t('browser.downloadsOpenFile', { defaultValue: '打开文件' })}
                    >
                      <FolderOpen size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => item.path && void openInDefaultApp(item.path)}
                    disabled={!item.path}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-background-active hover:text-text-primary disabled:opacity-40"
                    title={t('browser.downloadsOpenDir', { defaultValue: '打开目录' })}
                  >
                    <FolderOpen size={11} />
                  </button>
                  <button
                    onClick={() => void handleCopyPath(item.path || item.destination)}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-background-active hover:text-text-primary"
                    title={t('browser.downloadsCopyPath', { defaultValue: '复制路径' })}
                  >
                    <Copy size={11} />
                  </button>
                  {item.status === 'failed' && (
                    <button
                      onClick={() => handleRetry(item)}
                      className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-background-active hover:text-primary"
                      title={t('browser.downloadsRetry', { defaultValue: '重试' })}
                    >
                      <RotateCw size={11} />
                    </button>
                  )}
                  <button
                    onClick={() => handleRemove(item.id)}
                    className="flex h-5 w-5 items-center justify-center rounded text-text-tertiary hover:bg-background-active hover:text-danger"
                    title={t('browser.downloadsRemove', { defaultValue: '删除记录' })}
                  >
                    <X size={11} />
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

function BottomStatusBar({ onSendToAi }: { onSendToAi: () => void }) {
  const { t } = useTranslation('common')
  // 使用原始值 selector，避免对象引用变化导致 useSyncExternalStore 无限循环
  const currentUrl = useTabStore(selectActiveBrowserUrl)
  const currentTitle = useTabStore(selectActiveBrowserTitle)
  const networkInfo = useTabStore(selectActiveBrowserNetworkInfo)
  const dlActive = useBrowserDownloadStore(selectActiveCount)
  const dlTotal = useBrowserDownloadStore(selectTotalCount)
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
            onClick={() => useBrowserSidebarStore.getState().setActiveTabName('downloads')}
            className={clsx(
              'inline-flex h-7 items-center gap-1 rounded-md border px-1.5 text-[11px] transition-colors',
              dlActive > 0
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border-subtle bg-background-surface text-text-tertiary hover:bg-background-hover hover:text-text-primary'
            )}
            title={t('browser.downloads', { defaultValue: '下载' })}
          >
            <Download size={12} className={dlActive > 0 ? 'animate-pulse' : ''} />
            {dlActive > 0 ? (
              <span className="min-w-[14px] rounded-full bg-primary px-1 text-center text-[10px] font-medium text-white">{dlActive}</span>
            ) : dlTotal > 0 ? (
              <span className="min-w-[14px] rounded-full bg-background-active px-1 text-center text-[10px] text-text-secondary">{dlTotal}</span>
            ) : null}
          </button>
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
  const dlTotal = useBrowserDownloadStore(selectTotalCount)
  const openBrowserTab = useTabStore((s) => s.openBrowserTab)
  const closeLeftPanel = useViewStore((s) => s.closeLeftPanel)
  const toast = useToastStore()
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
  const [searchQuery, setSearchQuery] = useState('')

  const handleNavigate = useCallback((url: string) => {
    const normalized = normalizeBrowserUrl(url)
    openBrowserTab(normalized, 'Browser')
    closeLeftPanel()
  }, [openBrowserTab, closeLeftPanel])

  const handleSendToAi = useCallback(async () => {
    // 批次 3 类 1：写入口统一走 kernel（完整透传 workDir），不再经 store 直调
    const sessionId = sessionStoreManager.getState().activeSessionId
    if (!sessionId) {
      toast.error(t('browser.sidebar.noSession', { defaultValue: '请先创建一个 AI 会话' }))
      return
    }
    const kernel = await getKernel()
    const exists = await kernel.getSessionState(sessionId)
    if (exists.state === 'none') {
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
      await kernel.sendMessage({
        sessionId,
        content: message,
        workspaceDir: currentWorkspace.path,
      })
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

  const filteredResults = useMemo(() => {
    if (!searchQuery.trim()) return null
    const q = searchQuery.toLowerCase()
    return {
      shortcuts: allShortcuts.filter(
        (s) => s.label.toLowerCase().includes(q) || s.url.toLowerCase().includes(q)
      ),
    }
  }, [searchQuery, allShortcuts])

  const tabs: { name: SidebarTabName; label: string; icon: React.ReactNode; count?: number }[] = [
    { name: 'quick', label: t('browser.sidebar.quickAccess', { defaultValue: '快捷' }), icon: <Globe2 size={13} /> },
    { name: 'downloads', label: t('browser.downloads', { defaultValue: '下载' }), icon: <Download size={13} />, count: dlTotal || undefined },
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
          {!filteredResults.shortcuts.length && (
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
            {activeTabName === 'downloads' && <DownloadsTab />}
          </div>
        </>
      )}

      {/* 底部状态栏 */}
      <BottomStatusBar onSendToAi={handleSendToAi} />
    </div>
  )
}