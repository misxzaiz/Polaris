/**
 * 会话历史面板
 *
 * 显示所有历史会话（localStorage + Claude Code 原生），支持恢复和删除
 * 支持服务端分页加载 + 按项目/全局范围切换
 * 集成 Fork/PR 关系可视化 + 树形/列表视图切换
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { historyService } from '../../services/historyService'
import type { UnifiedHistoryItem, HistoryScope } from '../../services/historyService'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { sessionStoreManager } from '../../stores/conversationStore/sessionStoreManager'
import { useViewStore } from '../../stores/index'
import { Clock, MessageSquare, Trash2, RotateCcw, HardDrive, Loader2, X, ChevronDown, Globe, FolderOpen, List, GitBranch } from 'lucide-react'
import { ForkIndicator } from './ForkIndicator'
import { SessionTree } from './SessionTree'
import { ForkSessionDialog } from './ForkSessionDialog'

const PAGE_SIZE = 20

/** 日期分组类型 */
type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

/** 视图模式 */
type ViewMode = 'list' | 'tree'

/** 日期分组顺序 */
const DATE_GROUP_ORDER: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier']

interface SessionHistoryPanelProps {
  onClose?: () => void
}

export function SessionHistoryPanel({ onClose }: SessionHistoryPanelProps) {
  const { t } = useTranslation('chat')
  const [allHistory, setAllHistory] = useState<UnifiedHistoryItem[]>([])
  const [scope, setScope] = useState<HistoryScope>('workspace')
  const [page, setPage] = useState(1)
  const [totalCount, setTotalCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'claude-code'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [forkTarget, setForkTarget] = useState<UnifiedHistoryItem | null>(null)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

  // 加载历史会话（首页或 scope 变化时）
  useEffect(() => {
    loadHistory(true)
  }, [currentWorkspace, scope])

  const loadHistory = async (reset: boolean = true) => {
    if (reset) {
      setLoading(true)
      setPage(1)
    } else {
      setLoadingMore(true)
    }

    try {
      const currentPage = reset ? 1 : page
      const result = await historyService.getUnifiedHistory(scope, currentPage, PAGE_SIZE)

      if (reset) {
        setAllHistory(result.items)
      } else {
        // 追加去重
        const existingIds = new Set(allHistory.map(h => h.id))
        const newItems = result.items.filter(item => !existingIds.has(item.id))
        setAllHistory(prev => [...prev, ...newItems])
      }

      setTotalCount(result.total)
      setHasMore(result.hasMore)
    } catch (e) {
      console.error('[SessionHistoryPanel] 加载历史失败:', e)
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }

  // 加载更多
  const handleLoadMore = useCallback(async () => {
    const nextPage = page + 1
    setPage(nextPage)

    setLoadingMore(true)
    try {
      const result = await historyService.getUnifiedHistory(scope, nextPage, PAGE_SIZE)
      const existingIds = new Set(allHistory.map(h => h.id))
      const newItems = result.items.filter(item => !existingIds.has(item.id))
      setAllHistory(prev => [...prev, ...newItems])
      setTotalCount(result.total)
      setHasMore(result.hasMore)
    } catch (e) {
      console.error('[SessionHistoryPanel] 加载更多失败:', e)
    } finally {
      setLoadingMore(false)
    }
  }, [page, scope, allHistory])

  // 切换 scope
  const handleScopeChange = (newScope: HistoryScope) => {
    if (newScope === scope) return
    setScope(newScope)
    setFilter('all')
    setSearchQuery('')
  }

  // 恢复会话
  const handleRestore = async (item: UnifiedHistoryItem) => {
    setRestoring(item.id)
    try {
      const success = await historyService.restoreFromHistory(
        item.id,
        item.engineId,
        item.projectPath,
        item.claudeProjectName
      )
      if (success) {
        console.log('[SessionHistoryPanel] 会话已恢复:', item.id)
        onClose?.()
      } else {
        console.error('[SessionHistoryPanel] 恢复会话失败')
      }
    } catch (e) {
      console.error('[SessionHistoryPanel] 恢复会话出错:', e)
    } finally {
      setRestoring(null)
    }
  }

  // 删除会话
  const handleDelete = (sessionId: string, _source: 'local' | 'claude-code-native') => {
    historyService.deleteHistorySession(sessionId)
    setAllHistory(prev => prev.filter(h => h.id !== sessionId))
    setTotalCount(prev => prev - 1)
  }

  // Fork 会话
  const handleFork = async (item: UnifiedHistoryItem, branchName?: string) => {
    try {
      // 1. 先恢复源会话的消息
      const messages = await loadSessionMessages(item)
      if (messages.length === 0) return

      // 2. 创建新会话并复制消息
      //    不传 conversationId（第二个参数为 null），这样 sendMessage 走 start_chat 而非 continue_chat
      //    只有 Claude Code 原生会话才能传 forkFromId（有 CLI session ID 可用于 --fork-session）
      const isClaudeNative = item.source === 'claude-code-native'
      const title = branchName || `Fork: ${item.title}`
      const prevActiveId = sessionStoreManager.getState().activeSessionId
      const newSessionId = sessionStoreManager.getState().createSessionFromHistory(
        messages,
        null, // 不传 conversationId，确保发消息走 start_chat
        {
          title,
          forkFromId: isClaudeNative ? item.id : undefined,
        },
      )

      console.log('[SessionHistoryPanel] Fork 创建成功:', newSessionId, {
        sourceId: item.id,
        branchName,
        isClaudeNative,
      })

      // 3. 多窗口模式下，恢复 activeSessionId 到原来的会话，不抢焦点
      if (useViewStore.getState().multiSessionMode && prevActiveId) {
        sessionStoreManager.getState().switchSession(prevActiveId)
      }

      // 4. 关闭对话框
      setForkTarget(null)
    } catch (e) {
      console.error('[SessionHistoryPanel] Fork 失败:', e)
    }
  }

  // 加载会话消息（用于 Fork）
  const loadSessionMessages = async (item: UnifiedHistoryItem) => {
    // 从 localStorage 尝试
    const historyJson = localStorage.getItem('event_chat_session_history')
    const localHistory = historyJson ? JSON.parse(historyJson) : []
    const localSession = localHistory.find((h: { id: string }) => h.id === item.id)
    if (localSession?.data?.messages?.length > 0) {
      return localSession.data.messages
    }

    // 从 Claude Code 原生历史尝试
    if (!item.engineId || item.engineId === 'claude-code') {
      const { getClaudeCodeHistoryService } = await import('../../services/claudeCodeHistoryService')
      const claudeCodeService = getClaudeCodeHistoryService()
      const messages = await claudeCodeService.getSessionHistory(item.id, item.claudeProjectName)
      if (messages.length > 0) {
        return claudeCodeService.convertToChatMessages(messages)
      }
    }

    return []
  }

  // 判断日期分组
  const getDateGroup = (timestamp: string): DateGroup => {
    const date = new Date(timestamp)
    const now = new Date()
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000)
    const startOfWeek = new Date(startOfToday.getTime() - 6 * 86400000)

    if (date >= startOfToday) {
      return 'today'
    } else if (date >= startOfYesterday) {
      return 'yesterday'
    } else if (date >= startOfWeek) {
      return 'thisWeek'
    } else {
      return 'earlier'
    }
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

    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  // 获取引擎信息
  const getEngineInfo = (_engineId: 'claude-code', source: string) => {
    if (source === 'claude-code-native') {
      return {
        name: 'Claude Code',
        color: 'text-blue-500',
        bgColor: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
        icon: HardDrive,
      }
    }
    return {
      name: 'Claude Code',
      color: 'text-blue-500',
      bgColor: 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300',
      icon: HardDrive,
    }
  }

  // 过滤历史（客户端搜索）
  const filteredHistory = allHistory.filter(item => {
    if (filter !== 'all' && item.engineId !== filter) return false
    if (searchQuery && !item.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false
    }
    return true
  })

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

    for (const item of filteredHistory) {
      const group = getDateGroup(item.timestamp)
      groups[group].push(item)
    }

    return groups
  }, [filteredHistory])

  // 格式化文件大小
  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return ''
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
  }

  if (loading) {
    return (
      <div className="flex flex-col h-full">
        {/* 头部 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-base font-semibold text-text-primary">会话历史</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 加载中 */}
        <div className="flex flex-col items-center justify-center flex-1 p-8">
          <Loader2 className="w-8 h-8 animate-spin text-text-tertiary" />
          <p className="mt-4 text-sm text-text-secondary">加载历史会话...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-base font-semibold text-text-primary">会话历史</h2>
        <button
          onClick={onClose}
          className="p-1 rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 范围 + 引擎筛选 + 视图切换 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle shrink-0">
        {/* 范围切换 */}
        <button
          onClick={() => handleScopeChange('workspace')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            scope === 'workspace'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          <FolderOpen className="w-3 h-3" />
          当前项目
        </button>
        <button
          onClick={() => handleScopeChange('global')}
          className={`flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
            scope === 'global'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          <Globe className="w-3 h-3" />
          全部
        </button>

        {/* 分隔符 */}
        <span className="border-l border-border h-4" />

        {/* 引擎筛选 */}
        <button
          onClick={() => setFilter('all')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'all'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          全部
        </button>
        <button
          onClick={() => setFilter('claude-code')}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'claude-code'
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          Claude Code
        </button>

        {/* 分隔符 */}
        <span className="border-l border-border h-4" />

        {/* 视图模式切换 */}
        <button
          onClick={() => setViewMode('list')}
          className={`p-1 rounded-md transition-colors ${
            viewMode === 'list'
              ? 'bg-primary/20 text-primary'
              : 'text-text-tertiary hover:bg-background-hover hover:text-text-primary'
          }`}
          title="列表视图"
        >
          <List className="w-3.5 h-3.5" />
        </button>
        <button
          onClick={() => setViewMode('tree')}
          className={`p-1 rounded-md transition-colors ${
            viewMode === 'tree'
              ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400'
              : 'text-text-tertiary hover:bg-background-hover hover:text-text-primary'
          }`}
          title="树形视图 (Fork/PR 关系)"
        >
          <GitBranch className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* 搜索框 */}
      <div className="px-4 py-2 border-b border-border-subtle shrink-0">
        <input
          type="text"
          placeholder={t('history.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 bg-background"
        />
      </div>

      {/* 会话列表 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {filteredHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-text-tertiary">
            <MessageSquare className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">{t('history.noHistory')}</p>
          </div>
        ) : viewMode === 'tree' ? (
          /* ===== 树形视图 ===== */
          <SessionTree
            sessions={filteredHistory}
            onRestore={handleRestore}
            restoringId={restoring}
          />
        ) : (
          /* ===== 列表视图 ===== */
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
                  {/* 分组标题 */}
                  <div className="sticky top-0 z-10 px-4 py-2 bg-background-elevated border-b border-border-subtle">
                    <span className="text-xs font-medium text-text-tertiary">
                      {groupLabels[group]}
                      <span className="ml-2 text-text-muted">({items.length})</span>
                    </span>
                  </div>

                  {/* 分组内的会话列表 */}
                  <ul>
                    {items.map((item, index) => {
                      const isRestoring = restoring === item.id
                      const canDelete = item.source === 'local'
                      const engineInfo = getEngineInfo(item.engineId, item.source)
                      const EngineIcon = engineInfo.icon

                      return (
                        <li
                          key={item.id}
                          className={`flex items-start gap-3 px-4 py-3 hover:bg-background-hover transition-colors ${index > 0 ? 'border-t border-border-subtle' : ''}`}
                        >
                          {/* 引擎标识 */}
                          <div className={`mt-0.5 ${engineInfo.color}`}>
                            <EngineIcon className="w-4 h-4" />
                          </div>

                          {/* 会话信息 */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="text-sm font-medium text-text-primary truncate">{item.title}</h3>
                              <span className={`text-xs px-1.5 py-0.5 rounded ${engineInfo.bgColor}`}>
                                {engineInfo.name}
                              </span>
                            </div>

                            <div className="flex items-center gap-4 text-xs text-text-tertiary mb-1.5">
                              <span className="flex items-center gap-1">
                                <MessageSquare className="w-3 h-3" />
                                {t('history.messages', { count: item.messageCount })}
                              </span>
                              <span className="flex items-center gap-1">
                                <Clock className="w-3 h-3" />
                                {formatTime(item.timestamp)}
                              </span>
                              {item.fileSize && (
                                <span>{formatFileSize(item.fileSize)}</span>
                              )}
                            </div>

                            {/* Fork/PR 关系指示器 */}
                            {(item.parentSessionId || (item.childSessionIds && item.childSessionIds.length > 0) || item.gitBranch || item.linkedPr) && (
                              <ForkIndicator
                                parentSessionId={item.parentSessionId}
                                childSessionIds={item.childSessionIds}
                                gitBranch={item.gitBranch}
                                linkedPr={item.linkedPr}
                                compact
                              />
                            )}
                          </div>

                          {/* 操作按钮 */}
                          <div className="flex items-center gap-1 shrink-0">
                            {/* Fork 按钮 */}
                            <button
                              onClick={() => setForkTarget(item)}
                              className="p-1.5 rounded-md hover:bg-amber-100 dark:hover:bg-amber-900/30 text-text-tertiary hover:text-amber-500 transition-colors"
                              title="创建分支"
                            >
                              <GitBranch className="w-4 h-4" />
                            </button>
                            {/* 恢复按钮 */}
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
                                onClick={() => handleDelete(item.id, item.source)}
                                className="p-1.5 rounded-md hover:bg-danger/10 text-text-tertiary hover:text-danger transition-colors"
                                title={t('history.deleteSession')}
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )
            })}
          </>
        )}

        {/* 加载更多（仅列表模式） */}
        {viewMode === 'list' && hasMore && (
          <div className="flex items-center justify-center py-3">
            <button
              onClick={handleLoadMore}
              disabled={loadingMore}
              className="flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors disabled:opacity-50"
            >
              {loadingMore ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
              <span>{loadingMore ? '加载中...' : `加载更多 (剩余 ${Math.max(0, totalCount - allHistory.length)} 条)`}</span>
            </button>
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-tertiary shrink-0">
        <div className="flex items-center justify-between">
          <div>
            <p>{t('history.claudeCodeHint')}</p>
            <p>{t('history.localSessionHint')}</p>
          </div>
          {/* Fork/PR 统计 */}
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
    </div>
  )
}
