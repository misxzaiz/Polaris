/**
 * 提交历史组件
 *
 * 显示 Git 提交历史列表，支持滚动加载更多，并可查看单个提交的文件和内容。
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GitCommit as GitCommitIcon,
  User,
  Clock,
  RefreshCw,
  ChevronRight,
  Loader2,
  ChevronDown,
  FileText,
  ExternalLink,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import type { GitCommit as GitCommitType, GitCommitDetails, GitDiffEntry } from '@/types/git'
import { createLogger } from '../../utils/logger'

const log = createLogger('HistoryTab')

const PAGE_SIZE = 20

interface HistoryTabProps {
  targetCommitSha?: string | null
  onCommitSelected?: () => void
  onOpenDiffInTab?: (diff: GitDiffEntry) => void
  variant?: 'sidebar' | 'workbench'
}

export function HistoryTab({
  targetCommitSha,
  onCommitSelected,
  onOpenDiffInTab,
  variant = 'sidebar',
}: HistoryTabProps) {
  const { t } = useTranslation('git')
  const [commits, setCommits] = useState<GitCommitType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedCommit, setSelectedCommit] = useState<GitCommitType | null>(null)
  const [selectedDetails, setSelectedDetails] = useState<GitCommitDetails | null>(null)
  const [selectedFileDiff, setSelectedFileDiff] = useState<GitDiffEntry | null>(null)
  const [isDetailsLoading, setIsDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(true)
  const [totalCount, setTotalCount] = useState(0)

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const detailsRequestRef = useRef(0)

  const getLog = useGitStore((s) => s.getLog)
  const getCommitDetails = useGitStore((s) => s.getCommitDetails)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId, viewingWorkspaceId } = s
    const targetId = viewingWorkspaceId || currentWorkspaceId
    return workspaces.find(w => w.id === targetId) || null
  })

  const isWorkbench = variant === 'workbench'

  const clearSelection = useCallback(() => {
    setSelectedCommit(null)
    setSelectedDetails(null)
    setSelectedFileDiff(null)
    setDetailsError(null)
  }, [])

  const loadCommitDetails = useCallback(async (commit: GitCommitType) => {
    if (!currentWorkspace) return

    const requestId = ++detailsRequestRef.current
    setSelectedCommit(commit)
    setSelectedDetails(null)
    setSelectedFileDiff(null)
    setDetailsError(null)
    setIsDetailsLoading(true)

    try {
      const details = await getCommitDetails(currentWorkspace.path, commit.sha)
      if (requestId !== detailsRequestRef.current) return
      setSelectedCommit(details.commit)
      setSelectedDetails(details)
      setSelectedFileDiff(details.files[0] ?? null)
    } catch (err) {
      if (requestId !== detailsRequestRef.current) return
      const errorMsg = err instanceof Error ? err.message : String(err)
      setDetailsError(errorMsg)
      log.error('Failed to load commit details', err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (requestId === detailsRequestRef.current) {
        setIsDetailsLoading(false)
      }
    }
  }, [currentWorkspace, getCommitDetails])

  const loadCommitDetailsBySha = useCallback(async (commitSha: string) => {
    if (!currentWorkspace) return

    const requestId = ++detailsRequestRef.current
    setDetailsError(null)
    setIsDetailsLoading(true)

    try {
      const details = await getCommitDetails(currentWorkspace.path, commitSha)
      if (requestId !== detailsRequestRef.current) return
      setSelectedCommit(details.commit)
      setSelectedDetails(details)
      setSelectedFileDiff(details.files[0] ?? null)
    } catch (err) {
      if (requestId !== detailsRequestRef.current) return
      const errorMsg = err instanceof Error ? err.message : String(err)
      setDetailsError(errorMsg)
      log.error('Failed to load target commit details', err instanceof Error ? err : new Error(String(err)))
    } finally {
      if (requestId === detailsRequestRef.current) {
        setIsDetailsLoading(false)
      }
    }
  }, [currentWorkspace, getCommitDetails])

  // 加载提交历史（初始）
  const loadCommits = useCallback(async () => {
    if (!currentWorkspace) {
      setError(t('errors.noWorkspace'))
      return
    }

    setIsLoading(true)
    setError(null)
    setHasMore(true)

    try {
      log.debug('Loading commits', { path: currentWorkspace.path })
      const result = await getLog(currentWorkspace.path, PAGE_SIZE, 0)
      log.debug('Loaded commits', { count: result.length })

      setCommits(result)
      setHasMore(result.length === PAGE_SIZE)
      setTotalCount(result.length)
      if (result.length === 0) {
        clearSelection()
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      log.error('Failed to load commits', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [clearSelection, currentWorkspace, getLog, t])

  // 加载更多提交
  const loadMoreCommits = useCallback(async () => {
    if (!currentWorkspace || isLoadingMore || !hasMore) return

    setIsLoadingMore(true)

    try {
      const skip = commits.length
      const result = await getLog(currentWorkspace.path, PAGE_SIZE, skip)

      if (result.length === 0) {
        setHasMore(false)
      } else {
        setCommits(prev => [...prev, ...result])
        setTotalCount(prev => prev + result.length)
        setHasMore(result.length === PAGE_SIZE)
      }
    } catch (err) {
      log.error('Failed to load more commits', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoadingMore(false)
    }
  }, [currentWorkspace, commits.length, isLoadingMore, hasMore, getLog])

  // 滚动加载更多
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || isLoadingMore || !hasMore) return

    const { scrollTop, scrollHeight, clientHeight } = container
    if (scrollHeight - scrollTop - clientHeight < 100) {
      loadMoreCommits()
    }
  }, [isLoadingMore, hasMore, loadMoreCommits])

  // 初始加载
  useEffect(() => {
    loadCommits()
  }, [loadCommits])

  useEffect(() => {
    clearSelection()
  }, [clearSelection, currentWorkspace?.path])

  // 处理从 Blame 跳转
  useEffect(() => {
    if (!targetCommitSha) return

    const targetCommit = commits.find(c => c.sha === targetCommitSha || c.sha.startsWith(targetCommitSha))
    if (targetCommit) {
      void loadCommitDetails(targetCommit)
      onCommitSelected?.()
      return
    }

    void loadCommitDetailsBySha(targetCommitSha)
    onCommitSelected?.()
  }, [commits, loadCommitDetails, loadCommitDetailsBySha, onCommitSelected, targetCommitSha])

  // 格式化时间
  const formatTime = (timestamp?: number) => {
    if (!timestamp) return ''

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

  const handleRefresh = useCallback(() => {
    loadCommits()
  }, [loadCommits])

  const renderCommitList = () => (
    <div
      ref={scrollContainerRef}
      onScroll={handleScroll}
      className="flex-1 overflow-y-auto min-h-0"
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-text-tertiary" />
        </div>
      ) : commits.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
          <GitCommitIcon size={24} className="mb-2 opacity-50" />
          <span className="text-sm">{t('history.noCommits')}</span>
        </div>
      ) : (
        <>
          {commits.map((commit) => (
            <div
              key={commit.sha}
              onClick={() => loadCommitDetails(commit)}
              className={`px-4 py-3 cursor-pointer hover:bg-background-hover transition-colors border-b border-border-subtle ${
                selectedCommit?.sha === commit.sha ? 'bg-primary/5' : ''
              }`}
            >
              <div className="flex items-start gap-3">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
                  <GitCommitIcon size={12} className="text-primary" />
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
                  <div className="flex items-center gap-3 text-xs text-text-tertiary min-w-0">
                    <span className="flex items-center gap-1 min-w-0">
                      <User size={10} className="shrink-0" />
                      <span className="truncate">{commit.author}</span>
                    </span>
                    <span className="flex items-center gap-1 shrink-0">
                      <Clock size={10} />
                      {formatTime(commit.timestamp)}
                    </span>
                  </div>
                </div>
                <ChevronRight size={14} className="text-text-tertiary flex-shrink-0" />
              </div>
            </div>
          ))}

          {isLoadingMore && (
            <div className="flex items-center justify-center py-3 text-text-tertiary">
              <Loader2 size={14} className="animate-spin mr-2" />
              <span className="text-xs">{t('history.loadingMore')}</span>
            </div>
          )}

          {hasMore && !isLoadingMore && (
            <div className="flex items-center justify-center py-3 text-text-tertiary">
              <ChevronDown className="w-4 h-4 animate-bounce mr-2" />
              <span className="text-xs">{t('history.scrollForMore')}</span>
            </div>
          )}

          {!hasMore && commits.length > 0 && (
            <div className="flex items-center justify-center py-3 text-text-tertiary">
              <span className="text-xs">{t('history.commitsLoaded', { count: commits.length })}</span>
            </div>
          )}
        </>
      )}
    </div>
  )

  const renderDetails = () => {
    if (!selectedCommit && !isDetailsLoading) {
      return (
        <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm p-6 text-center">
          {t('history.selectCommit')}
        </div>
      )
    }

    return (
      <div className="flex-1 flex flex-col min-h-0 bg-background-base">
        <div className="px-4 py-3 border-b border-border-subtle bg-background-surface shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-xs font-mono text-text-tertiary bg-background-elevated px-1.5 py-0.5 rounded">
                  {selectedCommit?.shortSha}
                </span>
                {selectedCommit && selectedCommit.parents.length > 1 && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-info/10 text-info">
                    {t('history.mergeCommit')}
                  </span>
                )}
              </div>
              <div className="text-sm text-text-primary font-medium whitespace-pre-wrap break-words">
                {selectedCommit?.message}
              </div>
              <div className="mt-2 text-xs text-text-tertiary">
                {selectedCommit?.author} · {formatTime(selectedCommit?.timestamp)}
              </div>
            </div>
          </div>

          {selectedDetails && (
            <div className="mt-3 flex items-center gap-3 text-xs text-text-tertiary">
              <span>{t('history.filesChanged', { count: selectedDetails.files.length })}</span>
              <span className="text-success">+{selectedDetails.totalAdditions}</span>
              <span className="text-danger">-{selectedDetails.totalDeletions}</span>
            </div>
          )}
        </div>

        {detailsError && (
          <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
            {t('history.detailLoadFailed')}: {detailsError}
          </div>
        )}

        {isDetailsLoading ? (
          <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
            <Loader2 size={16} className="animate-spin mr-2" />
            {t('history.loadingDetails')}
          </div>
        ) : selectedDetails ? (
          <div className={isWorkbench ? 'flex-1 flex min-h-0' : 'flex-1 flex flex-col min-h-0'}>
            <div className={`${isWorkbench ? 'w-[320px] border-r' : 'max-h-48 border-b'} border-border-subtle overflow-y-auto shrink-0`}>
              {selectedDetails.files.length === 0 ? (
                <div className="p-4 text-sm text-text-tertiary text-center">
                  {t('history.noFileChanges')}
                </div>
              ) : (
                selectedDetails.files.map((file) => (
                  <button
                    key={`${file.old_file_path ?? ''}:${file.file_path}`}
                    onClick={() => setSelectedFileDiff(file)}
                    className={`w-full px-4 py-2 flex items-center gap-2 text-left hover:bg-background-hover transition-colors border-b border-border-subtle ${
                      selectedFileDiff?.file_path === file.file_path ? 'bg-primary/5' : ''
                    }`}
                  >
                    <FileText size={13} className="text-text-tertiary shrink-0" />
                    <span className="flex-1 min-w-0 text-sm text-text-primary truncate">
                      {file.file_path}
                    </span>
                    <span className="text-xs shrink-0">
                      <span className="text-success">+{file.additions ?? 0}</span>
                      <span className="text-danger ml-1">-{file.deletions ?? 0}</span>
                    </span>
                  </button>
                ))
              )}
            </div>

            <div className="flex-1 flex flex-col min-h-0">
              {selectedFileDiff ? (
                <>
                  <div className="px-4 py-2 border-b border-border-subtle bg-background-surface flex items-center gap-2 shrink-0">
                    <span className="flex-1 text-xs font-medium text-text-secondary truncate">
                      {selectedFileDiff.file_path}
                    </span>
                    {onOpenDiffInTab && (
                      <button
                        onClick={() => onOpenDiffInTab(selectedFileDiff)}
                        className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                        title={t('history.openDiffInEditor')}
                      >
                        <ExternalLink size={14} />
                      </button>
                    )}
                  </div>
                  <DiffViewer
                    oldContent={selectedFileDiff.old_content}
                    newContent={selectedFileDiff.new_content}
                    changeType={selectedFileDiff.change_type}
                    statusHint={selectedFileDiff.status_hint}
                    contentOmitted={selectedFileDiff.content_omitted ?? false}
                  />
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center text-sm text-text-tertiary p-6 text-center">
                  {t('history.selectFile')}
                </div>
              )}
            </div>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col flex-1 h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between shrink-0">
        <span className="text-sm font-medium text-text-primary">
          {t('history.title')}
          {totalCount > 0 && (
            <span className="ml-2 text-xs text-text-tertiary">({totalCount}+)</span>
          )}
        </span>
        <button
          onClick={handleRefresh}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          title={t('refreshStatus')}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      <div className={isWorkbench ? 'flex-1 flex min-h-0' : 'flex-1 flex flex-col min-h-0'}>
        <div className={isWorkbench ? 'w-[380px] border-r border-border-subtle flex flex-col min-h-0 shrink-0' : 'flex-1 flex flex-col min-h-0'}>
          {renderCommitList()}
        </div>

        {(selectedCommit || isDetailsLoading || isWorkbench) && (
          <div className={isWorkbench ? 'flex-1 flex min-w-0 min-h-0' : 'min-h-[360px] max-h-[70%] flex flex-col border-t border-border-subtle'}>
            {renderDetails()}
          </div>
        )}
      </div>
    </div>
  )
}
