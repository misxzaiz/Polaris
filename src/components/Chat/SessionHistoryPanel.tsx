/**
 * 会话历史面板
 *
 * 显示所有历史会话（localStorage + Claude Code 原生），支持恢复和删除
 * 支持滚动加载更多（每次显示20条）
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useEventChatStore, UnifiedHistoryItem } from '../../stores/eventChatStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { Clock, MessageSquare, Trash2, RotateCcw, HardDrive, Loader2, X, ChevronDown } from 'lucide-react'

const PAGE_SIZE = 20

/** 日期分组类型 */
type DateGroup = 'today' | 'yesterday' | 'thisWeek' | 'earlier'

/** 日期分组顺序 */
const DATE_GROUP_ORDER: DateGroup[] = ['today', 'yesterday', 'thisWeek', 'earlier']

interface SessionHistoryPanelProps {
  onClose?: () => void
}

export function SessionHistoryPanel({ onClose }: SessionHistoryPanelProps) {
  const { t } = useTranslation('chat')
  const [allHistory, setAllHistory] = useState<UnifiedHistoryItem[]>([])
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE)
  const [loading, setLoading] = useState(true)
  const [restoring, setRestoring] = useState<string | null>(null)
  const [filter, setFilter] = useState<'all' | 'claude-code'>('all')
  const [searchQuery, setSearchQuery] = useState('')

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const currentWorkspace = useWorkspaceStore(state => state.getCurrentWorkspace())

  // 加载历史会话
  useEffect(() => {
    loadHistory()
  }, [currentWorkspace])

  const loadHistory = async () => {
    setLoading(true)
    setDisplayCount(PAGE_SIZE) // 重置显示数量
    try {
      const items = await useEventChatStore.getState().getUnifiedHistory()
      setAllHistory(items)
    } catch (e) {
      console.error('[SessionHistoryPanel] 加载历史失败:', e)
    } finally {
      setLoading(false)
    }
  }

  // 加载更多
  const handleLoadMore = useCallback(() => {
    setDisplayCount(prev => Math.min(prev + PAGE_SIZE, filteredHistory.length))
  }, [displayCount, allHistory, filter, searchQuery])

  // 恢复会话
  const handleRestore = async (item: UnifiedHistoryItem) => {
    setRestoring(item.id)
    try {
      const success = await useEventChatStore.getState().restoreFromHistory(
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
  const handleDelete = (sessionId: string, source: 'local' | 'claude-code-native') => {
    useEventChatStore.getState().deleteHistorySession(sessionId, source === 'local' ? 'local' : undefined)
    setAllHistory(prev => prev.filter(h => h.id !== sessionId))
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

  // 过滤历史
  const filteredHistory = allHistory.filter(item => {
    if (filter !== 'all' && item.engineId !== filter) return false
    if (searchQuery && !item.title.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false
    }
    return true
  })

  // 当前显示的历史
  const displayedHistory = filteredHistory.slice(0, displayCount)
  const hasMore = displayCount < filteredHistory.length

  // 按日期分组
  const groupedHistory = useMemo(() => {
    const groups: Record<DateGroup, UnifiedHistoryItem[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: [],
    }

    for (const item of displayedHistory) {
      const group = getDateGroup(item.timestamp)
      groups[group].push(item)
    }

    return groups
  }, [displayedHistory])

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

      {/* 引擎筛选 */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border-subtle shrink-0">
        <button
          onClick={() => { setFilter('all'); setDisplayCount(PAGE_SIZE); }}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'all'
              ? 'bg-primary/20 text-primary'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          全部
        </button>
        <button
          onClick={() => { setFilter('claude-code'); setDisplayCount(PAGE_SIZE); }}
          className={`px-2 py-1 rounded-md text-xs transition-colors ${
            filter === 'claude-code'
              ? 'bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300'
              : 'text-text-secondary hover:bg-background-hover'
          }`}
        >
          Claude Code
        </button>
      </div>

      {/* 搜索框 */}
      <div className="px-4 py-2 border-b border-border-subtle shrink-0">
        <input
          type="text"
          placeholder={t('history.searchPlaceholder')}
          value={searchQuery}
          onChange={(e) => { setSearchQuery(e.target.value); setDisplayCount(PAGE_SIZE); }}
          className="w-full px-3 py-2 text-sm border border-border rounded-md focus:outline-none focus:ring-2 focus:ring-primary/50 bg-background"
        />
      </div>

      {/* 会话列表 */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {displayedHistory.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full p-8 text-text-tertiary">
            <MessageSquare className="w-12 h-12 mb-4 opacity-50" />
            <p className="text-sm">{t('history.noHistory')}</p>
          </div>
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

                            <div className="flex items-center gap-4 text-xs text-text-tertiary">
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
                              {(item.inputTokens || item.outputTokens) && (
                                <span>
                                  {((item.inputTokens || 0) + (item.outputTokens || 0)).toLocaleString()} Tokens
                                </span>
                              )}
                            </div>
                          </div>

                          {/* 操作按钮 */}
                          <div className="flex items-center gap-1 shrink-0">
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

        {/* 加载更多按钮 */}
        {hasMore && (
          <div className="flex items-center justify-center py-3">
            <button
              onClick={handleLoadMore}
              className="flex items-center gap-2 px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-md transition-colors"
            >
              <ChevronDown className="w-4 h-4" />
              <span>{t('history.loadMore', { count: filteredHistory.length - displayCount })}</span>
            </button>
          </div>
        )}
      </div>

      {/* 底部提示 */}
      <div className="px-4 py-2 border-t border-border-subtle text-xs text-text-tertiary shrink-0">
        <p>{t('history.claudeCodeHint')}</p>
        <p>{t('history.localSessionHint')}</p>
      </div>
    </div>
  )
}
