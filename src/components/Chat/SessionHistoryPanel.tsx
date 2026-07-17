/**
 * 会话历史面板 — 统一时间线 + 续聊工作台
 *
 * 数据源：后端 SQLite 索引（history_query / history_search），self 与引擎原生会话
 * 按 sessionId 合并成一个列表，不再按"存储实现"分 Tab；来源仅作为条目徽标。
 *
 * 结构：
 * - 「继续工作」区：置顶 + 最近活跃卡片（最后一条消息摘要，主按钮=继续）
 * - 组合筛选：范围（当前项目/全部）、引擎、星标、归档
 * - 全文搜索：标题 + 消息正文（FTS5），带命中片段
 * - 标注：星标/置顶/归档，对 self 与 native 会话一致生效（存索引，不改引擎文件）
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { historyService } from '@/services/historyService'
import type { UnifiedHistoryItem, HistoryScope, HistoryEngineFilter, HistoryMarks } from '@/services/historyService'
import type { ChatMessage, EngineId } from '@/types'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useHistoryPrefsStore } from '@/stores/historyPrefsStore'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import { useViewStore, useToastStore } from '@/stores/index'
import { createLogger } from '@/utils/logger'
import {
  Clock, MessageSquare, Trash2, RotateCcw, HardDrive, Loader2, X, ChevronDown,
  Globe, FolderOpen, List, GitBranch, Star, Pin, Archive, ArchiveRestore, Play, RefreshCw,
} from 'lucide-react'
import { ForkIndicator } from './ForkIndicator'
import { SessionTree } from './SessionTree'
import { ForkSessionDialog } from './ForkSessionDialog'
import { SessionPreviewModal } from './SessionPreviewModal'
import { getEngineFullName } from '@/utils/engineDisplay'
import { getPathBasename, normalizeWorkspacePath } from '@/utils/workspacePath'

const log = createLogger('SessionHistoryPanel')

function getHistoryEngines(filter: 'all' | EngineId): HistoryEngineFilter[] {
  if (filter === 'codex') return ['codex']
  if (filter === 'claude-code') return ['claude-code']
  if (filter === 'mimo') return ['mimo']
  if (filter === 'simple-ai') return ['simple-ai']
  return ['claude-code', 'codex', 'mimo', 'simple-ai']
}

/** 日期分组类型 */
type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

/** 视图模式 */
type ViewMode = 'list' | 'tree'

/** 日期分组顺序 */
const DATE_GROUP_ORDER: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier']

async function resolveForkWorkspaceId(
  item: UnifiedHistoryItem,
  fallbackWorkspaceId?: string | null,
): Promise<string | undefined> {
  const projectPath = item.projectPath?.trim()
  const workspaceState = useWorkspaceStore.getState()

  if (projectPath) {
    const normalizedProjectPath = normalizeWorkspacePath(projectPath)
    let workspace = workspaceState.workspaces.find(
      (w) => normalizeWorkspacePath(w.path) === normalizedProjectPath,
    )
    if (workspace) return workspace.id

    try {
      await workspaceState.createWorkspace(getPathBasename(projectPath), projectPath, false)
      workspace = useWorkspaceStore.getState().workspaces.find(
        (w) => normalizeWorkspacePath(w.path) === normalizedProjectPath,
      )
      if (workspace) return workspace.id
    } catch (error) {
      log.warn('Failed to resolve fork workspace', { error: String(error), projectPath })
    }
  }

  return fallbackWorkspaceId ?? undefined
}

/** 搜索命中片段渲染：FTS snippet 用 [..] 包裹命中词 */
function SnippetText({ text }: { text: string }) {
  const parts = useMemo(() => {
    const out: Array<{ hit: boolean; s: string }> = []
    let rest = text
    for (let guard = 0; guard < 20 && rest.length > 0; guard++) {
      const open = rest.indexOf('[')
      const close = open >= 0 ? rest.indexOf(']', open + 1) : -1
      if (open < 0 || close < 0) {
        out.push({ hit: false, s: rest })
        break
      }
      if (open > 0) out.push({ hit: false, s: rest.slice(0, open) })
      out.push({ hit: true, s: rest.slice(open + 1, close) })
      rest = rest.slice(close + 1)
    }
    return out
  }, [text])
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="bg-amber-200/60 dark:bg-amber-500/30 rounded-sm px-0.5 text-inherit">
            {p.s}
          </mark>
        ) : (
          <span key={i}>{p.s}</span>
        ),
      )}
    </>
  )
}

interface SessionHistoryPanelProps {
  onClose?: () => void
}

export function SessionHistoryPanel({ onClose }: SessionHistoryPanelProps) {
  const { t } = useTranslation('chat')
  const listPageSize = useHistoryPrefsStore((s) => s.listPageSize)
  const recentCards = useHistoryPrefsStore((s) => s.recentCards)

  const [allHistory, setAllHistory] = useState<UnifiedHistoryItem[]>([])
  const [scope, setScope] = useState<HistoryScope>('workspace')
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | EngineId>('all')
  const [starredOnly, setStarredOnly] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<UnifiedHistoryItem[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [forkTarget, setForkTarget] = useState<UnifiedHistoryItem | null>(null)
  const [previewTarget, setPreviewTarget] = useState<UnifiedHistoryItem | null>(null)
  const [refreshTick, setRefreshTick] = useState(0)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentWorkspace = useWorkspaceStore((state) => state.getCurrentWorkspace())

  /** 拉取一页统一时间线 */
  const fetchPage = useCallback(
    async (targetPage: number, forceScan = false) => {
      return historyService.listUnifiedTimeline({
        scope,
        page: targetPage,
        pageSize: listPageSize,
        engines: getHistoryEngines(filter),
        starred: starredOnly || undefined,
        archived: showArchived ? true : undefined,
        forceScan,
      })
    },
    [scope, filter, starredOnly, showArchived, listPageSize],
  )

  // 加载首页（筛选条件变化 / 手动刷新时）
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setPage(1)
      try {
        const result = await fetchPage(1, refreshTick > 0)
        if (cancelled) return
        setAllHistory(result.items)
        setTotalCount(result.total)
        setHasMore(result.hasMore)
      } catch (e) {
        if (!cancelled) {
          log.error('Failed to load history', e instanceof Error ? e : new Error(String(e)))
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [currentWorkspace?.path, fetchPage, refreshTick])

  // 全文搜索（防抖 250ms）
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults(null)
      setSearching(false)
      return
    }
    setSearching(true)
    searchTimerRef.current = setTimeout(async () => {
      try {
        const results = await historyService.searchHistory(q, scope)
        setSearchResults(results)
      } catch {
        setSearchResults([])
      } finally {
        setSearching(false)
      }
    }, 250)
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    }
  }, [searchQuery, scope])

  // 加载更多
  const handleLoadMore = useCallback(async () => {
    const nextPage = page + 1
    setPage(nextPage)
    setLoadingMore(true)
    try {
      const result = await fetchPage(nextPage)
      const existingIds = new Set(allHistory.map((h) => h.id))
      const newItems = result.items.filter((item) => !existingIds.has(item.id))
      setAllHistory((prev) => [...prev, ...newItems])
      setTotalCount(result.total)
      setHasMore(result.hasMore)
    } catch (e) {
      log.error('Failed to load more history', e instanceof Error ? e : new Error(String(e)))
    } finally {
      setLoadingMore(false)
    }
  }, [page, fetchPage, allHistory])

  // 恢复会话（= 继续）
  const handleRestore = async (item: UnifiedHistoryItem) => {
    setRestoring(item.id)
    try {
      const success = await historyService.restoreFromHistory(
        item.id,
        item.engineId,
        item.projectPath,
        item.claudeProjectName,
        item.title,
      )
      if (success) {
        log.info('Session restored', { itemId: item.id })
        onClose?.()
      } else {
        useToastStore.getState().addToast({
          type: 'error',
          title: t('history.restoreFailed', '恢复会话失败'),
          message: t('history.restoreFailedMessage', '无法加载会话消息，会话数据可能已过期'),
        })
      }
    } catch (e) {
      log.error('Failed to restore session', e instanceof Error ? e : new Error(String(e)))
      useToastStore.getState().addToast({
        type: 'error',
        title: t('history.restoreFailed', '恢复会话失败'),
        message: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRestoring(null)
    }
  }

  // 标注（星标/置顶/归档）：乐观更新 + 失败回滚
  const handleMark = async (item: UnifiedHistoryItem, marks: HistoryMarks) => {
    const apply = (list: UnifiedHistoryItem[]) =>
      list.map((h) => (h.id === item.id ? { ...h, ...marks } : h))
    setAllHistory(apply)
    setSearchResults((prev) => (prev ? apply(prev) : prev))
    const ok = await historyService.markHistory(item.id, marks)
    if (!ok) {
      const revert = (list: UnifiedHistoryItem[]) =>
        list.map((h) => (h.id === item.id ? { ...h, ...item } : h))
      setAllHistory(revert)
      setSearchResults((prev) => (prev ? revert(prev) : prev))
      useToastStore.getState().addToast({
        type: 'error',
        title: t('history.markFailed', '更新标注失败'),
        message: t('history.markFailedMessage', '会话可能尚未进入索引，请刷新后重试'),
      })
    } else if (marks.archived !== undefined) {
      // 归档/取消归档后从当前列表移除（列表按归档状态过滤）
      setAllHistory((prev) => prev.filter((h) => h.id !== item.id))
      setTotalCount((prev) => Math.max(0, prev - 1))
    }
  }

  // 删除会话
  const handleDelete = async (item: UnifiedHistoryItem) => {
    try {
      await historyService.deleteHistorySession(item.id, item.source, item.engineId)
      setAllHistory((prev) => prev.filter((h) => h.id !== item.id))
      setSearchResults((prev) => (prev ? prev.filter((h) => h.id !== item.id) : prev))
      setTotalCount((prev) => prev - 1)
    } catch (e) {
      log.error('Failed to delete session', e instanceof Error ? e : new Error(String(e)))
      useToastStore.getState().addToast({
        type: 'error',
        title: t('history.deleteFailed', '删除会话失败'),
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 加载会话消息（用于 Fork）
  const loadSessionMessages = async (item: UnifiedHistoryItem): Promise<ChatMessage[]> => {
    // Fork 需要完整历史：不走分页，整份读取
    const record = await import('@/services/dialogStorage').then(({ dialogStorageService }) =>
      dialogStorageService.getConversation(item.id),
    )
    if (record && record.messages.length > 0) return record.messages
    const loaded = await historyService.loadMessagesForItem(
      item.id,
      item.engineId,
      item.projectPath,
      item.claudeProjectName,
      item.title,
    )
    return loaded.messages
  }

  // Fork 会话
  const handleFork = async (item: UnifiedHistoryItem, branchName?: string) => {
    try {
      const messages = await loadSessionMessages(item)
      if (messages.length === 0) {
        useToastStore.getState().addToast({
          type: 'error',
          title: t('history.forkFailed', '创建分支失败'),
          message: t('history.forkFailedMessage', '无法加载会话消息，会话数据可能已过期'),
        })
        return
      }

      const isClaudeNative = item.source === 'claude-code-native'
      const title = branchName || `Fork: ${item.title}`
      const prevActiveId = sessionStoreManager.getState().activeSessionId
      const workspaceId = await resolveForkWorkspaceId(item, currentWorkspace?.id)
      const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
        messages,
        null, // 不传 conversationId，确保发消息走 start_chat
        {
          title,
          workspaceId,
          forkFromId: isClaudeNative ? item.id : undefined,
          engineId: item.engineId,
        },
      )

      log.info('Fork created', { newSessionId, sourceId: item.id, branchName, isClaudeNative, workspaceId })

      if (useViewStore.getState().multiSessionMode && prevActiveId) {
        sessionStoreManager.getState().switchSession(prevActiveId)
      }

      setForkTarget(null)
    } catch (e) {
      log.error('Fork failed', e instanceof Error ? e : new Error(String(e)))
      useToastStore.getState().addToast({
        type: 'error',
        title: t('history.forkFailed', '创建分支失败'),
        message: e instanceof Error ? e.message : String(e),
      })
    }
  }

  // 判断日期分组
  const getDateGroup = (timestamp: string): DateGroup => {
    const date = new Date(timestamp)
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000)
    const startOfWeek = new Date(startOfToday.getTime() - 6 * 86400000)

    if (date >= startOfToday) return 'today'
    if (date >= startOfYesterday) return 'yesterday'
    if (date >= startOfWeek) return 'thisWeek'
    return 'earlier'
  }

  // 格式化时间
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)

    if (diffMins < 1) return t('history.justNow')
    if (diffMins < 60) return t('history.minutesAgo', { count: diffMins })
    if (diffHours < 24) return t('history.hoursAgo', { count: diffHours })

    return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' }) +
      ' ' + date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }

  // 获取引擎徽标信息
  const getEngineInfo = (engineId: EngineId) => {
    if (engineId === 'codex') {
      return {
        name: getEngineFullName(engineId),
        bgColor: 'bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300',
      }
    }
    if (engineId === 'mimo') {
      return {
        name: getEngineFullName(engineId),
        bgColor: 'bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300',
      }
    }
    if (engineId === 'simple-ai') {
      return {
        name: getEngineFullName(engineId),
        bgColor: 'bg-orange-100 text-orange-600 dark:bg-orange-900 dark:text-orange-300',
      }
    }
    return {
      name: getEngineFullName(engineId),
      bgColor: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
    }
  }

  // 展示列表：搜索态用搜索结果，否则用时间线
  const displayItems = searchResults ?? allHistory

  // 「继续工作」区（非搜索、非星标/归档筛选、第一页数据即可）
  const continueItems = useMemo(() => {
    if (searchResults || starredOnly || showArchived || recentCards === 0) return []
    const pinned = allHistory.filter((h) => h.pinned)
    const recent = allHistory.filter((h) => !h.pinned).slice(0, recentCards)
    return [...pinned, ...recent].slice(0, Math.max(recentCards, pinned.length + 1))
  }, [allHistory, searchResults, starredOnly, showArchived, recentCards])

  // 统计 Fork/PR 关联数量
  const forkStats = useMemo(() => {
    let forkCount = 0
    let prCount = 0
    for (const item of allHistory) {
      if (item.parentSessionId || (item.childSessionIds && item.childSessionIds.length > 0)) forkCount++
      if (item.linkedPr) prCount++
    }
    return { forkCount, prCount }
  }, [allHistory])

  // 按日期分组
  const groupedHistory = useMemo(() => {
    const groups: Record<DateGroup, UnifiedHistoryItem[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: [],
    }
    for (const item of displayItems) {
      groups[getDateGroup(item.timestamp)].push(item)
    }
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayItems])

  // 格式化文件大小
  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return ''
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  const renderItemRow = (item: UnifiedHistoryItem, index: number) => {
    const isRestoring = restoring === item.id
    const canDelete =
      item.source === 'self' || item.source === 'local' || item.source === 'codex-native'
    const engineInfo = getEngineInfo(item.engineId)

    return (
      <li
        key={item.id}
        className={`group flex items-start gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-background-hover transition-colors ${index > 0 ? 'border-t border-border-subtle' : ''}`}
      >
        <button
          onClick={() => handleMark(item, { starred: !item.starred })}
          className={`mt-0.5 shrink-0 transition-colors ${
            item.starred
              ? 'text-amber-400 hover:text-amber-500'
              : 'text-text-muted opacity-0 group-hover:opacity-100 hover:text-amber-400'
          }`}
          title={item.starred ? t('history.unstar', '取消星标') : t('history.star', '星标')}
        >
          <Star className="w-4 h-4" fill={item.starred ? 'currentColor' : 'none'} />
        </button>

        <div
          className="flex-1 min-w-0 cursor-pointer"
          onClick={() => setPreviewTarget(item)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setPreviewTarget(item)
            }
          }}
          title={t('preview.openHint', '点击预览完整对话')}
        >
          <div className="flex items-center gap-2 mb-1">
            {item.pinned && <Pin className="w-3 h-3 text-primary shrink-0" fill="currentColor" />}
            <h3 className="text-sm font-medium text-text-primary truncate">{item.title}</h3>
            <span className={`text-xs px-1.5 py-0.5 rounded shrink-0 ${engineInfo.bgColor}`}>
              {engineInfo.name}
            </span>
            {item.source !== 'self' && (
              <span
                className="text-[10px] px-1 py-0.5 rounded bg-background-elevated text-text-muted shrink-0"
                title={t('history.nativeSourceHint', '引擎原生记录')}
              >
                {t('history.nativeSource', '原生')}
              </span>
            )}
          </div>

          {(item.snippet || item.preview) && (
            <p className="text-xs text-text-secondary line-clamp-2 mb-1.5 leading-snug">
              {searchResults && item.snippet ? (
                <SnippetText text={item.snippet} />
              ) : (
                item.preview || item.snippet
              )}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 sm:gap-4 text-xs text-text-tertiary mb-1.5">
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {t('history.messages', { count: item.messageCount })}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {formatTime(item.timestamp)}
            </span>
            {item.fileSize ? <span>{formatFileSize(item.fileSize)}</span> : null}
            {scope === 'global' && item.projectPath && (
              <span className="flex items-center gap-1 max-w-[120px] truncate" title={item.projectPath}>
                <FolderOpen className="w-3 h-3 shrink-0" />
                <span className="truncate">{getPathBasename(item.projectPath)}</span>
              </span>
            )}
          </div>

          {(item.parentSessionId ||
            (item.childSessionIds && item.childSessionIds.length > 0) ||
            item.gitBranch ||
            item.linkedPr) && (
            <ForkIndicator
              parentSessionId={item.parentSessionId}
              childSessionIds={item.childSessionIds}
              gitBranch={item.gitBranch}
              linkedPr={item.linkedPr}
              compact
            />
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          <button
            onClick={() => handleMark(item, { pinned: !item.pinned })}
            className={`p-1.5 rounded-md transition-colors ${
              item.pinned
                ? 'text-primary hover:bg-primary/10'
                : 'text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-background-elevated hover:text-primary'
            }`}
            title={item.pinned ? t('history.unpin', '取消置顶') : t('history.pin', '置顶到继续工作区')}
          >
            <Pin className="w-4 h-4" fill={item.pinned ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => setForkTarget(item)}
            className="p-1.5 rounded-md hover:bg-amber-100 dark:hover:bg-amber-900/30 text-text-tertiary hover:text-amber-500 transition-colors opacity-0 group-hover:opacity-100"
            title={t('history.createBranch')}
          >
            <GitBranch className="w-4 h-4" />
          </button>
          <button
            onClick={() => handleMark(item, { archived: !item.archived })}
            className="p-1.5 rounded-md hover:bg-background-elevated text-text-tertiary hover:text-text-primary transition-colors opacity-0 group-hover:opacity-100"
            title={item.archived ? t('history.unarchive', '取消归档') : t('history.archive', '归档')}
          >
            {item.archived ? <ArchiveRestore className="w-4 h-4" /> : <Archive className="w-4 h-4" />}
          </button>
          <button
            onClick={() => handleRestore(item)}
            disabled={isRestoring}
            className={`p-1.5 rounded-md hover:bg-background-elevated transition-colors ${
              isRestoring ? 'opacity-50 cursor-not-allowed' : 'text-text-secondary hover:text-text-primary'
            }`}
            title={t('history.restoreSession')}
          >
            {isRestoring ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RotateCcw className="w-4 h-4" />
            )}
          </button>
          {canDelete && (
            <button
              onClick={() => handleDelete(item)}
              className="p-1.5 rounded-md hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors opacity-0 group-hover:opacity-100"
              title={t('history.deleteSession')}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </li>
    )
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">{t('history.title')}</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex flex-col items-center justify-center flex-1 p-8">
          <Loader2 className="w-8 h-8 animate-spin text-text-tertiary" />
          <p className="mt-4 text-sm text-text-secondary">{t('history.loading')}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text-primary">{t('history.title')}</h2>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setRefreshTick((v) => v + 1)}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
            title={t('history.refresh', '刷新（立即重扫引擎目录）')}
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 范围 + 引擎筛选 + 标注筛选 + 视图切换 */}
      <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-1.5 sm:py-2 border-b border-border-subtle shrink-0">
        <button
          onClick={() => setScope('workspace')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            scope === 'workspace' ? 'bg-primary/20 text-primary' : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          <FolderOpen className="w-3 h-3" />
          {t('history.currentProject')}
        </button>
        <button
          onClick={() => setScope('global')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            scope === 'global' ? 'bg-primary/20 text-primary' : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          <Globe className="w-3 h-3" />
          {t('history.all')}
        </button>
        <span className="hidden sm:block border-l border-border h-4" />

        {(['all', 'claude-code', 'codex', 'mimo', 'simple-ai'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-2 py-1 rounded-md text-xs transition-colors ${
              filter === f ? 'bg-primary/20 text-primary' : 'text-text-secondary hover:bg-background-hover'
            }`}
          >
            {f === 'all' ? t('history.allEngines', '全部') : getEngineFullName(f)}
          </button>
        ))}

        <span className="hidden sm:block border-l border-border h-4" />

        <button
          onClick={() => setStarredOnly((v) => !v)}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            starredOnly
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
          title={t('history.starredOnly', '只看星标')}
        >
          <Star className="w-3 h-3" fill={starredOnly ? 'currentColor' : 'none'} />
        </button>
        <button
          onClick={() => setShowArchived((v) => !v)}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            showArchived ? 'bg-primary/20 text-primary' : 'text-text-secondary hover:bg-background-hover'
          }`}
          title={t('history.showArchived', '查看归档')}
        >
          <Archive className="w-3 h-3" />
        </button>

        <span className="flex-1" />

        <button
          onClick={() => setViewMode('list')}
          className={`p-1.5 sm:p-1 rounded-md transition-colors ${
            viewMode === 'list'
              ? 'bg-primary/20 text-primary'
              : 'text-text-tertiary hover:bg-background-hover hover:text-text-primary'
          }`}
          title={t('history.listView')}
        >
          <List className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setViewMode('tree')}
          className={`p-1.5 sm:p-1 rounded-md transition-colors ${
            viewMode === 'tree'
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
              : 'text-text-tertiary hover:bg-background-hover hover:text-text-primary'
          }`}
          title={t('history.treeView')}
        >
          <GitBranch className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 搜索框（标题 + 全文） */}
      <div className="px-3 sm:px-4 py-1.5 sm:py-2 border-b border-border-subtle shrink-0 relative">
        <input
          type="text"
          placeholder={t('history.searchFullText', '搜索标题与对话内容…')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 bg-background"
        />
        {searching && (
          <Loader2 className="w-4 h-4 animate-spin text-text-tertiary absolute right-6 top-1/2 -translate-y-1/2" />
        )}
      </div>

      {/* 会话列表 */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        {/* 继续工作区 */}
        {continueItems.length > 0 && viewMode === 'list' && (
          <div className="px-3 sm:px-4 pt-3 pb-1">
            <div className="text-xs font-medium text-text-tertiary mb-2">
              {t('history.continueWorking', '继续工作')}
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2">
              {continueItems.map((item) => {
                const engineInfo = getEngineInfo(item.engineId)
                return (
                  <div
                    key={`cw-${item.id}`}
                    className="w-52 shrink-0 rounded-lg border border-border-subtle bg-background-elevated/60 hover:border-primary/40 transition-colors p-2.5 flex flex-col gap-1.5"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {item.pinned && (
                        <Pin className="w-3 h-3 text-primary shrink-0" fill="currentColor" />
                      )}
                      <span className="text-xs font-medium text-text-primary truncate flex-1">
                        {item.title}
                      </span>
                    </div>
                    <p className="text-[11px] text-text-tertiary line-clamp-2 leading-snug min-h-[2em]">
                      {item.preview || item.snippet || t('history.noPreview', '（暂无摘要）')}
                    </p>
                    <div className="flex items-center justify-between mt-auto">
                      <span className={`text-[10px] px-1 py-0.5 rounded ${engineInfo.bgColor}`}>
                        {engineInfo.name}
                      </span>
                      <span className="text-[10px] text-text-muted">{formatTime(item.timestamp)}</span>
                      <button
                        onClick={() => handleRestore(item)}
                        disabled={restoring === item.id}
                        className="flex items-center gap-1 px-2 py-1 rounded-md bg-primary/15 text-primary hover:bg-primary/25 text-[11px] font-medium transition-colors disabled:opacity-50"
                      >
                        {restoring === item.id ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <Play className="w-3 h-3" />
                        )}
                        {t('history.continue', '继续')}
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {displayItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-text-tertiary">
            <MessageSquare className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">
              {searchResults ? t('history.noSearchResults', '没有匹配的会话') : t('history.noHistory')}
            </p>
          </div>
        ) : viewMode === 'tree' ? (
          <SessionTree sessions={displayItems} onRestore={handleRestore} restoringId={restoring} />
        ) : searchResults ? (
          <ul>{searchResults.map((item, index) => renderItemRow(item, index))}</ul>
        ) : (
          <>
            {DATE_GROUP_ORDER.map((group) => {
              const items = groupedHistory[group]
              if (items.length === 0) return null

              const groupLabels: Record<DateGroup, string> = {
                today: t('history.today'),
                yesterday: t('history.yesterday'),
                thisWeek: t('history.thisWeek'),
                earlier: t('history.earlier'),
              }

              return (
                <div key={group} className="mb-2">
                  <div className="sticky top-0 z-10 px-3 sm:px-4 py-1.5 sm:py-2 bg-background-elevated border-b border-border-subtle">
                    <span className="text-xs font-medium text-text-tertiary">
                      {groupLabels[group]}
                      <span className="ml-2 text-text-muted">({items.length})</span>
                    </span>
                  </div>
                  <ul>{items.map((item, index) => renderItemRow(item, index))}</ul>
                </div>
              )
            })}
          </>
        )}

        {/* 加载更多（仅列表非搜索模式） */}
        {viewMode === 'list' && !searchResults && hasMore && (
          <div className="flex items-center justify-center py-3">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors disabled:opacity-50"
            >
              {loadingMore ? <Loader2 className="w-4 h-4 animate-spin" /> : <ChevronDown className="w-4 h-4" />}
              <span>
                {loadingMore
                  ? t('history.loadingMore')
                  : t('history.loadMore', { count: Math.max(0, totalCount - allHistory.length) })}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-3 sm:px-4 py-1.5 sm:py-2 border-t border-border-subtle text-xs text-text-tertiary shrink-0">
        <div className="flex items-center justify-between">
          <p className="flex items-center gap-1">
            <HardDrive className="w-3 h-3" />
            {searchResults
              ? t('history.searchHint', '全文搜索：标题 + 对话内容')
              : t('history.unifiedHint', '全部来源已合并（自有存储 + 引擎原生），星标/置顶/归档随处生效')}
          </p>
          {(forkStats.forkCount > 0 || forkStats.prCount > 0) && (
            <div className="flex items-center gap-2 text-[10px]">
              {forkStats.forkCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400">
                  {forkStats.forkCount} Fork
                </span>
              )}
              {forkStats.prCount > 0 && (
                <span className="px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400">
                  {forkStats.prCount} PR
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Fork 会话对话框 */}
      {forkTarget && (
        <ForkSessionDialog
          sourceSession={forkTarget}
          onConfirm={(branchName) => handleFork(forkTarget, branchName)}
          onCancel={() => setForkTarget(null)}
        />
      )}

      {/* 只读会话预览：无需恢复即可查看完整上下文 */}
      {previewTarget && (
        <SessionPreviewModal
          item={previewTarget}
          onRestore={(item) => {
            setPreviewTarget(null)
            handleRestore(item)
          }}
          onFork={(item) => {
            setPreviewTarget(null)
            setForkTarget(item)
          }}
          onClose={() => setPreviewTarget(null)}
        />
      )}
    </div>
  )
}
