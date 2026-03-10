/**
 * 提交历史组件
 *
 * 显示 Git 提交历史列表，使用虚拟滚动优化性能
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { GitCommit, User, Clock, RefreshCw, ChevronRight, Loader2, Search, X, Cherry, AlertTriangle, XCircle, CheckCircle, RotateCcw } from 'lucide-react'
import { Virtuoso } from 'react-virtuoso'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitCommit as GitCommitType, GitCherryPickResult, GitRevertResult } from '@/types/git'

const PAGE_SIZE = 50

interface HistoryTabProps {
  targetCommitSha?: string | null
  onCommitSelected?: () => void
}

export function HistoryTab({ targetCommitSha, onCommitSelected }: HistoryTabProps) {
  const { t } = useTranslation('git')
  const [commits, setCommits] = useState<GitCommitType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<GitCommitType | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const loadingRef = useRef(false)
  const commitsLengthRef = useRef(0)
  const retryCountRef = useRef(0)
  const MAX_RETRIES = 3

  // Cherry-pick 相关状态
  const [showCherryPickDialog, setShowCherryPickDialog] = useState(false)
  const [cherryPickTarget, setCherryPickTarget] = useState<GitCommitType | null>(null)
  const [cherryPickResult, setCherryPickResult] = useState<GitCherryPickResult | null>(null)
  const [isCherryPicking, setIsCherryPicking] = useState(false)

  // Revert 相关状态
  const [showRevertDialog, setShowRevertDialog] = useState(false)
  const [revertTarget, setRevertTarget] = useState<GitCommitType | null>(null)
  const [revertResult, setRevertResult] = useState<GitRevertResult | null>(null)
  const [isReverting, setIsReverting] = useState(false)

  const getLog = useGitStore((s) => s.getLog)
  const cherryPick = useGitStore((s) => s.cherryPick)
  const cherryPickAbort = useGitStore((s) => s.cherryPickAbort)
  const cherryPickContinue = useGitStore((s) => s.cherryPickContinue)
  const revert = useGitStore((s) => s.revert)
  const revertAbort = useGitStore((s) => s.revertAbort)
  const revertContinue = useGitStore((s) => s.revertContinue)
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
  const toast = useToastStore()

  // 过滤提交（按消息和作者搜索）
  const filteredCommits = useMemo(() => {
    if (!searchQuery.trim()) {
      return commits
    }

    const query = searchQuery.toLowerCase()
    return commits.filter((commit) =>
      commit.message.toLowerCase().includes(query) ||
      commit.author.toLowerCase().includes(query) ||
      commit.shortSha.toLowerCase().includes(query)
    )
  }, [commits, searchQuery])

  // 处理从 Blame 跳转到指定提交
  useEffect(() => {
    if (targetCommitSha && commits.length > 0) {
      const targetCommit = commits.find(c => c.sha === targetCommitSha || c.sha.startsWith(targetCommitSha))
      if (targetCommit) {
        setSelectedCommit(targetCommit)
        // 清除搜索条件以便找到提交
        setSearchQuery('')
        onCommitSelected?.()
      }
    }
  }, [targetCommitSha, commits, onCommitSelected])

  // 使用 ref 存储 getLog 函数，避免依赖变化
  const getLogRef = useRef(getLog)
  getLogRef.current = getLog

  // 创建超时Promise
  const createTimeoutPromise = (timeoutMs: number) => {
    return new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`TIMEOUT_ERROR:${timeoutMs}`))
      }, timeoutMs)
    })
  }

  const loadCommits = useCallback(async (append = false) => {
    if (!currentWorkspace) {
      return
    }
    if (loadingRef.current) {
      return
    }

    if (append) {
      setIsLoadingMore(true)
    } else {
      setIsLoading(true)
      setCommits([])
      setHasMore(true)
      commitsLengthRef.current = 0
      retryCountRef.current = 0
    }
    loadingRef.current = true
    setError(null)

    try {
      const skip = append ? commitsLengthRef.current : 0

      // 添加超时保护 (30秒超时)
      const result = await Promise.race([
        getLogRef.current(currentWorkspace.path, PAGE_SIZE, skip),
        createTimeoutPromise(30000)
      ]) as GitCommitType[]

      // 验证数据格式
      if (!Array.isArray(result)) {
        throw new Error(`INVALID_DATA_FORMAT:${typeof result}`)
      }

      if (result.length < PAGE_SIZE) {
        setHasMore(false)
      }

      setCommits((prev) => {
        const newCommits = append ? [...prev, ...result] : result
        commitsLengthRef.current = newCommits.length
        return newCommits
      })

      // 重置重试计数
      retryCountRef.current = 0
    } catch (err) {
      let errorMsg = err instanceof Error ? err.message : String(err)

      // 翻译内部错误消息
      if (errorMsg.startsWith('TIMEOUT_ERROR:')) {
        const timeoutMs = errorMsg.split(':')[1]
        errorMsg = t('history.timeout', { timeout: timeoutMs })
      } else if (errorMsg.startsWith('INVALID_DATA_FORMAT:')) {
        const type = errorMsg.split(':')[1]
        errorMsg = t('history.invalidDataFormat', { type })
      }

      // 重试逻辑（超时错误不重试）
      retryCountRef.current++
      if (retryCountRef.current < MAX_RETRIES && !errorMsg.includes(t('history.timeout', { timeout: '' }).trim())) {
        setTimeout(() => {
          loadCommitsRef.current(append)
        }, 1000 * retryCountRef.current) // 递增延迟
        return
      }

      setError(errorMsg)
    } finally {
      setIsLoading(false)
      setIsLoadingMore(false)
      loadingRef.current = false
    }
  }, [currentWorkspace])

  // 清理函数 - 组件卸载时重置状态
  useEffect(() => {
    return () => {
      loadingRef.current = false
      retryCountRef.current = 0
    }
  }, [])

  // 使用 ref 存储 loadCommits 函数，避免在 loadMore 和 handleRefresh 中产生依赖问题
  const loadCommitsRef = useRef(loadCommits)
  loadCommitsRef.current = loadCommits

  // 初始加载 - 当 currentWorkspace 变化时重新加载（带防抖）
  useEffect(() => {
    if (!currentWorkspace?.path) {
      return
    }

    // 防抖：延迟300ms再加载
    const timeoutId = setTimeout(() => {
      loadCommitsRef.current(false)
    }, 300)

    return () => {
      clearTimeout(timeoutId)
    }
  }, [currentWorkspace?.path])

  // 加载更多
  const loadMore = useCallback(() => {
    if (!isLoadingMore && hasMore && commitsLengthRef.current > 0) {
      loadCommitsRef.current(true)
    }
  }, [isLoadingMore, hasMore])

  // 手动刷新
  const handleRefresh = useCallback(() => {
    // 重置重试计数
    retryCountRef.current = 0
    loadCommitsRef.current(false)
  }, [])

  // 打开 Cherry-pick 确认弹窗
  const handleOpenCherryPick = useCallback((commit: GitCommitType) => {
    setCherryPickTarget(commit)
    setCherryPickResult(null)
    setShowCherryPickDialog(true)
  }, [])

  // 执行 Cherry-pick
  const handleCherryPick = useCallback(async () => {
    if (!currentWorkspace || !cherryPickTarget) return

    setIsCherryPicking(true)
    try {
      const result = await cherryPick(currentWorkspace.path, cherryPickTarget.sha)
      setCherryPickResult(result)

      if (result.success && !result.hasConflicts) {
        toast.success(t('cherryPick.success'))
        setShowCherryPickDialog(false)
        loadCommitsRef.current(false)
      } else if (result.hasConflicts) {
        toast.warning(t('cherryPick.conflicts'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('cherryPick.failed', { error: errorMsg }))
    } finally {
      setIsCherryPicking(false)
    }
  }, [currentWorkspace, cherryPickTarget, cherryPick, toast, t, loadCommits])

  // 中止 Cherry-pick
  const handleCherryPickAbort = useCallback(async () => {
    if (!currentWorkspace) return

    setIsCherryPicking(true)
    try {
      await cherryPickAbort(currentWorkspace.path)
      toast.info(t('cherryPick.aborted'))
      setShowCherryPickDialog(false)
      setCherryPickResult(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('cherryPick.abortFailed', { error: errorMsg }))
    } finally {
      setIsCherryPicking(false)
    }
  }, [currentWorkspace, cherryPickAbort, toast, t])

  // 继续 Cherry-pick
  const handleCherryPickContinue = useCallback(async () => {
    if (!currentWorkspace) return

    setIsCherryPicking(true)
    try {
      const result = await cherryPickContinue(currentWorkspace.path)
      setCherryPickResult(result)

      if (result.success && !result.hasConflicts) {
        toast.success(t('cherryPick.success'))
        setShowCherryPickDialog(false)
        loadCommitsRef.current(false)
      } else if (result.hasConflicts) {
        toast.warning(t('cherryPick.stillConflicts'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('cherryPick.continueFailed', { error: errorMsg }))
    } finally {
      setIsCherryPicking(false)
    }
  }, [currentWorkspace, cherryPickContinue, toast, t, loadCommits])

  // 打开 Revert 确认弹窗
  const handleOpenRevert = useCallback((commit: GitCommitType) => {
    setRevertTarget(commit)
    setRevertResult(null)
    setShowRevertDialog(true)
  }, [])

  // 执行 Revert
  const handleRevert = useCallback(async () => {
    if (!currentWorkspace || !revertTarget) return

    setIsReverting(true)
    try {
      const result = await revert(currentWorkspace.path, revertTarget.sha)
      setRevertResult(result)

      if (result.success && !result.hasConflicts) {
        toast.success(t('revert.success'))
        setShowRevertDialog(false)
        loadCommitsRef.current(false)
      } else if (result.hasConflicts) {
        toast.warning(t('revert.conflicts'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('revert.failed', { error: errorMsg }))
    } finally {
      setIsReverting(false)
    }
  }, [currentWorkspace, revertTarget, revert, toast, t, loadCommits])

  // 中止 Revert
  const handleRevertAbort = useCallback(async () => {
    if (!currentWorkspace) return

    setIsReverting(true)
    try {
      await revertAbort(currentWorkspace.path)
      toast.info(t('revert.aborted'))
      setShowRevertDialog(false)
      setRevertResult(null)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('revert.abortFailed', { error: errorMsg }))
    } finally {
      setIsReverting(false)
    }
  }, [currentWorkspace, revertAbort, toast, t])

  // 继续 Revert
  const handleRevertContinue = useCallback(async () => {
    if (!currentWorkspace) return

    setIsReverting(true)
    try {
      const result = await revertContinue(currentWorkspace.path)
      setRevertResult(result)

      if (result.success && !result.hasConflicts) {
        toast.success(t('revert.success'))
        setShowRevertDialog(false)
        loadCommitsRef.current(false)
      } else if (result.hasConflicts) {
        toast.warning(t('revert.stillConflicts'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('revert.continueFailed', { error: errorMsg }))
    } finally {
      setIsReverting(false)
    }
  }, [currentWorkspace, revertContinue, toast, t, loadCommits])

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return t('history.justNow')
    if (diffMins < 60) return t('history.minutesAgo', { count: diffMins })
    if (diffHours < 24) return t('history.hoursAgo', { count: diffHours })
    if (diffDays < 7) return t('history.daysAgo', { count: diffDays })
    return date.toLocaleDateString()
  }

  // 渲染单个提交项
  const CommitItem = useCallback(({ commit }: { commit: GitCommitType }) => (
    <div
      onClick={() => setSelectedCommit(commit)}
      className={`px-4 py-3 cursor-pointer hover:bg-background-hover transition-colors border-b border-border-subtle ${
        selectedCommit?.sha === commit.sha ? 'bg-primary/5' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
          <GitCommit size={12} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
              {commit.shortSha}
            </span>
          </div>
          <div className="text-sm text-text-primary font-medium truncate mb-1">
            {commit.message.split('\n')[0]}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            <span className="flex items-center gap-1">
              <User size={10} />
              {commit.author}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />
              {formatTime(commit.timestamp)}
            </span>
          </div>
        </div>
        <ChevronRight size={14} className="text-text-tertiary flex-shrink-0" />
      </div>
    </div>
  ), [selectedCommit?.sha])

  // 渲染底部加载更多指示器
  const Footer = useCallback(() => {
    if (searchQuery.trim()) return null // 搜索模式下不显示加载更多
    if (isLoadingMore) {
      return (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={16} className="animate-spin text-text-tertiary" />
          <span className="ml-2 text-xs text-text-tertiary">{t('history.loadingMore')}</span>
        </div>
      )
    }
    if (!hasMore && commitsLengthRef.current > 0) {
      return (
        <div className="flex items-center justify-center py-4 text-xs text-text-tertiary">
          {t('history.noMore')}
        </div>
      )
    }
    return null
  }, [isLoadingMore, hasMore, searchQuery, t])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-text-primary shrink-0">
          {t('history.title')}
          {commits.length > 0 && (
            <span className="ml-2 text-xs text-text-tertiary">({commits.length})</span>
          )}
        </span>
        <div className="flex-1 max-w-[200px]">
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('history.searchPlaceholder')}
              className="w-full pl-7 pr-6 py-1 text-xs bg-background-surface border border-border-subtle rounded focus:outline-none focus:border-primary text-text-primary placeholder:text-text-tertiary"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 text-text-tertiary hover:text-text-primary rounded"
              >
                <X size={12} />
              </button>
            )}
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50 shrink-0"
          title={t('refresh', { ns: 'common' })}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-hidden">
        {isLoading && commits.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : commits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <GitCommit size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('history.noCommits')}</span>
          </div>
        ) : filteredCommits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Search size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('history.noSearchResults')}</span>
          </div>
        ) : (
          <Virtuoso
            key={filteredCommits.length}
            data={filteredCommits}
            endReached={loadMore}
            itemContent={(_, commit) => <CommitItem commit={commit} />}
            components={{
              Footer,
            }}
            className="h-full"
          />
        )}
      </div>

      {selectedCommit && (
        <div className="border-t border-border-subtle p-4 bg-background-surface">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-mono text-text-tertiary">
              {selectedCommit.shortSha}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => handleOpenRevert(selectedCommit)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-warning/10 text-warning rounded hover:bg-warning/20 transition-colors"
                title={t('revert.title')}
              >
                <RotateCcw size={12} />
                {t('revert.button')}
              </button>
              <button
                onClick={() => handleOpenCherryPick(selectedCommit)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors"
                title={t('cherryPick.title')}
              >
                <Cherry size={12} />
                {t('cherryPick.button')}
              </button>
              <button
                onClick={() => setSelectedCommit(null)}
                className="text-xs text-text-tertiary hover:text-text-primary"
              >
                {t('close', { ns: 'common' })}
              </button>
            </div>
          </div>
          <div className="text-sm text-text-primary whitespace-pre-wrap">
            {selectedCommit.message}
          </div>
          <div className="mt-2 text-xs text-text-tertiary">
            {selectedCommit.author} · {formatTime(selectedCommit.timestamp)}
          </div>
        </div>
      )}

      {/* Cherry-pick 弹窗 */}
      {showCherryPickDialog && cherryPickTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-surface border border-border-subtle rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                <Cherry size={16} className="text-primary" />
                {t('cherryPick.title')}
              </h3>
              <button
                onClick={() => {
                  setShowCherryPickDialog(false)
                  setCherryPickResult(null)
                }}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-4">
              {/* 显示要 cherry-pick 的提交信息 */}
              <div className="mb-4 p-3 bg-background rounded border border-border-subtle">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
                    {cherryPickTarget.shortSha}
                  </span>
                </div>
                <div className="text-sm text-text-primary truncate">
                  {cherryPickTarget.message.split('\n')[0]}
                </div>
                <div className="text-xs text-text-tertiary mt-1">
                  {cherryPickTarget.author}
                </div>
              </div>

              {/* 冲突提示 */}
              {cherryPickResult?.hasConflicts && (
                <div className="mb-4 p-3 bg-warning/10 border border-warning/20 rounded">
                  <div className="flex items-center gap-2 text-warning mb-2">
                    <AlertTriangle size={14} />
                    <span className="text-sm font-medium">{t('cherryPick.conflictTitle')}</span>
                  </div>
                  <div className="text-xs text-text-secondary mb-2">
                    {t('cherryPick.conflictDesc')}
                  </div>
                  {cherryPickResult.conflicts.length > 0 && (
                    <div className="max-h-32 overflow-y-auto">
                      <ul className="text-xs text-text-tertiary space-y-1">
                        {cherryPickResult.conflicts.map((file, idx) => (
                          <li key={idx} className="font-mono">• {file}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                {cherryPickResult?.hasConflicts ? (
                  <>
                    <button
                      onClick={handleCherryPickAbort}
                      disabled={isCherryPicking}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 transition-colors disabled:opacity-50"
                    >
                      <XCircle size={14} />
                      {t('cherryPick.abort')}
                    </button>
                    <button
                      onClick={handleCherryPickContinue}
                      disabled={isCherryPicking}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {isCherryPicking ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <CheckCircle size={14} />
                      )}
                      {t('cherryPick.continue')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setShowCherryPickDialog(false)
                        setCherryPickResult(null)
                      }}
                      className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      {t('cancel', { ns: 'common' })}
                    </button>
                    <button
                      onClick={handleCherryPick}
                      disabled={isCherryPicking}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {isCherryPicking && <Loader2 size={14} className="animate-spin" />}
                      {t('cherryPick.confirm')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Revert 弹窗 */}
      {showRevertDialog && revertTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-surface border border-border-subtle rounded-lg shadow-xl max-w-md w-full mx-4">
            <div className="flex items-center justify-between p-4 border-b border-border-subtle">
              <h3 className="text-sm font-medium text-text-primary flex items-center gap-2">
                <RotateCcw size={16} className="text-warning" />
                {t('revert.title')}
              </h3>
              <button
                onClick={() => {
                  setShowRevertDialog(false)
                  setRevertResult(null)
                }}
                className="text-text-tertiary hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-4">
              {/* 显示要 revert 的提交信息 */}
              <div className="mb-4 p-3 bg-background rounded border border-border-subtle">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-xs font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
                    {revertTarget.shortSha}
                  </span>
                </div>
                <div className="text-sm text-text-primary truncate">
                  {revertTarget.message.split('\n')[0]}
                </div>
                <div className="text-xs text-text-tertiary mt-1">
                  {revertTarget.author}
                </div>
              </div>

              {/* 冲突提示 */}
              {revertResult?.hasConflicts && (
                <div className="mb-4 p-3 bg-warning/10 border border-warning/20 rounded">
                  <div className="flex items-center gap-2 text-warning mb-2">
                    <AlertTriangle size={14} />
                    <span className="text-sm font-medium">{t('revert.conflictTitle')}</span>
                  </div>
                  <div className="text-xs text-text-secondary mb-2">
                    {t('revert.conflictDesc')}
                  </div>
                  {revertResult.conflicts.length > 0 && (
                    <div className="max-h-32 overflow-y-auto">
                      <ul className="text-xs text-text-tertiary space-y-1">
                        {revertResult.conflicts.map((file, idx) => (
                          <li key={idx} className="font-mono">• {file}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex justify-end gap-2">
                {revertResult?.hasConflicts ? (
                  <>
                    <button
                      onClick={handleRevertAbort}
                      disabled={isReverting}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-danger/10 text-danger rounded hover:bg-danger/20 transition-colors disabled:opacity-50"
                    >
                      <XCircle size={14} />
                      {t('revert.abort')}
                    </button>
                    <button
                      onClick={handleRevertContinue}
                      disabled={isReverting}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {isReverting ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <CheckCircle size={14} />
                      )}
                      {t('revert.continue')}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => {
                        setShowRevertDialog(false)
                        setRevertResult(null)
                      }}
                      className="px-3 py-1.5 text-xs text-text-tertiary hover:text-text-primary transition-colors"
                    >
                      {t('cancel', { ns: 'common' })}
                    </button>
                    <button
                      onClick={handleRevert}
                      disabled={isReverting}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs bg-warning text-white rounded hover:bg-warning/90 transition-colors disabled:opacity-50"
                    >
                      {isReverting && <Loader2 size={14} className="animate-spin" />}
                      {t('revert.confirm')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
