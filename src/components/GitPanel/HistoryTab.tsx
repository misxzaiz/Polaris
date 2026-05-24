/**
 * 提交历史组件
 *
 * 显示 Git 提交历史列表，支持滚动加载更多，并可查看单个提交的文件和内容。
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
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
  Search,
  X,
  Copy,
  Check,
  List,
  FolderTree,
  Rows3,
  Columns2,
  ArrowLeft,
  FileClock,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import type { DiffViewMode } from '@/components/Diff/DiffViewer'
import type {
  GitCommit as GitCommitType,
  GitCommitDetails,
  GitDiffEntry,
  GitFileHistoryEntry,
} from '@/types/git'
import { createLogger } from '../../utils/logger'

const log = createLogger('HistoryTab')

const PAGE_SIZE = 20
const FILE_LIST_MODE_STORAGE_KEY = 'polaris.git.history.fileListMode'
const COMMIT_LIST_WIDTH_STORAGE_KEY = 'polaris.git.history.commitListWidth'
const FILE_PANE_WIDTH_STORAGE_KEY = 'polaris.git.history.filePaneWidth'
const DIFF_VIEW_MODE_STORAGE_KEY = 'polaris.git.history.diffViewMode'
const COMMIT_LIST_MIN_WIDTH = 280
const COMMIT_LIST_MAX_WIDTH = 560
const FILE_PANE_MIN_WIDTH = 240
const FILE_PANE_MAX_WIDTH = 520

type FileListMode = 'list' | 'tree'
type CopyAction = 'sha' | 'message'

const getDiffKey = (file: GitDiffEntry) => `${file.old_file_path ?? ''}:${file.file_path}`

const readLocalStorage = (key: string) => {
  if (typeof window === 'undefined') return null

  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

const writeLocalStorage = (key: string, value: string) => {
  if (typeof window === 'undefined') return

  try {
    window.localStorage.setItem(key, value)
  } catch {
    // Storage can be unavailable in restricted browser contexts; keep UI state in memory.
  }
}

const getInitialFileListMode = (): FileListMode => {
  return readLocalStorage(FILE_LIST_MODE_STORAGE_KEY) === 'tree' ? 'tree' : 'list'
}

const getInitialDiffViewMode = (): DiffViewMode => {
  return readLocalStorage(DIFF_VIEW_MODE_STORAGE_KEY) === 'split' ? 'split' : 'unified'
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

const getInitialPaneWidth = (key: string, fallback: number, min: number, max: number) => {
  const stored = Number(readLocalStorage(key))
  return Number.isFinite(stored) && stored > 0 ? clamp(stored, min, max) : fallback
}

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
  const [searchQuery, setSearchQuery] = useState('')
  const [fileHistoryPath, setFileHistoryPath] = useState<string | null>(null)
  const [fileHistoryEntries, setFileHistoryEntries] = useState<GitFileHistoryEntry[]>([])
  const [fileHistoryHasMore, setFileHistoryHasMore] = useState(true)
  const [fileHistoryTotalCount, setFileHistoryTotalCount] = useState(0)
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [fileListMode, setFileListMode] = useState<FileListMode>(getInitialFileListMode)
  const [diffViewMode, setDiffViewMode] = useState<DiffViewMode>(getInitialDiffViewMode)
  const [copiedAction, setCopiedAction] = useState<CopyAction | null>(null)
  const [commitListWidth, setCommitListWidth] = useState(() => getInitialPaneWidth(
    COMMIT_LIST_WIDTH_STORAGE_KEY,
    380,
    COMMIT_LIST_MIN_WIDTH,
    COMMIT_LIST_MAX_WIDTH
  ))
  const [filePaneWidth, setFilePaneWidth] = useState(() => getInitialPaneWidth(
    FILE_PANE_WIDTH_STORAGE_KEY,
    320,
    FILE_PANE_MIN_WIDTH,
    FILE_PANE_MAX_WIDTH
  ))

  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const detailsRequestRef = useRef(0)
  const hasAutoSelectedRef = useRef(false)
  const copyResetTimerRef = useRef<number | null>(null)
  const paneResizeCleanupRef = useRef<(() => void) | null>(null)

  const getLog = useGitStore((s) => s.getLog)
  const getCommitDetails = useGitStore((s) => s.getCommitDetails)
  const getFileHistory = useGitStore((s) => s.getFileHistory)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId, viewingWorkspaceId } = s
    const targetId = viewingWorkspaceId || currentWorkspaceId
    return workspaces.find(w => w.id === targetId) || null
  })

  const isWorkbench = variant === 'workbench'
  const isFileHistoryMode = fileHistoryPath !== null
  const activeTotalCount = isFileHistoryMode ? fileHistoryTotalCount : totalCount
  const activeHasMore = isFileHistoryMode ? fileHistoryHasMore : hasMore
  const noWorkspaceError = t('errors.noWorkspace')
  const rootDirectoryLabel = t('history.rootDirectory')

  const clearSelection = useCallback(() => {
    detailsRequestRef.current += 1
    setSelectedCommit(null)
    setSelectedDetails(null)
    setSelectedFileDiff(null)
    setIsDetailsLoading(false)
    setDetailsError(null)
    setFileSearchQuery('')
    setCopiedAction(null)
  }, [])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const normalizedFileSearchQuery = fileSearchQuery.trim().toLowerCase()

  const filteredCommits = useMemo(() => {
    if (!normalizedSearchQuery) return commits

    return commits.filter((commit) => {
      const searchableText = [
        commit.sha,
        commit.shortSha,
        commit.message,
        commit.author,
        commit.authorEmail,
      ].join('\n').toLowerCase()

      return searchableText.includes(normalizedSearchQuery)
    })
  }, [commits, normalizedSearchQuery])

  const filteredFileHistoryEntries = useMemo(() => {
    if (!normalizedSearchQuery) return fileHistoryEntries

    return fileHistoryEntries.filter((entry) => {
      const searchableText = [
        entry.commit.sha,
        entry.commit.shortSha,
        entry.commit.message,
        entry.commit.author,
        entry.commit.authorEmail,
        entry.file.file_path,
        entry.file.old_file_path ?? '',
        entry.file.change_type,
      ].join('\n').toLowerCase()

      return searchableText.includes(normalizedSearchQuery)
    })
  }, [fileHistoryEntries, normalizedSearchQuery])

  const filteredSelectedFiles = useMemo(() => {
    if (!selectedDetails) return []
    if (!normalizedFileSearchQuery) return selectedDetails.files

    return selectedDetails.files.filter((file) => {
      const searchableText = [
        file.file_path,
        file.old_file_path ?? '',
        file.change_type,
      ].join('\n').toLowerCase()

      return searchableText.includes(normalizedFileSearchQuery)
    })
  }, [normalizedFileSearchQuery, selectedDetails])

  const groupedSelectedFiles = useMemo(() => {
    const groups = new Map<string, GitDiffEntry[]>()

    for (const file of filteredSelectedFiles) {
      const normalizedPath = file.file_path.replace(/\\/g, '/')
      const directory = normalizedPath.includes('/')
        ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
        : rootDirectoryLabel
      const existing = groups.get(directory) ?? []
      existing.push(file)
      groups.set(directory, existing)
    }

    return Array.from(groups.entries()).map(([directory, files]) => ({ directory, files }))
  }, [filteredSelectedFiles, rootDirectoryLabel])

  const selectFileHistoryEntry = useCallback((entry: GitFileHistoryEntry) => {
    detailsRequestRef.current += 1
    const additions = entry.file.additions ?? 0
    const deletions = entry.file.deletions ?? 0

    setSelectedCommit(entry.commit)
    setSelectedDetails({
      commit: entry.commit,
      files: [entry.file],
      totalAdditions: additions,
      totalDeletions: deletions,
    })
    setSelectedFileDiff(entry.file)
    setDetailsError(null)
    setIsDetailsLoading(false)
    setFileSearchQuery('')
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
      setFileSearchQuery('')
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
      setFileSearchQuery('')
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
      setError(noWorkspaceError)
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
        hasAutoSelectedRef.current = false
      } else if (isWorkbench && !targetCommitSha && !hasAutoSelectedRef.current) {
        hasAutoSelectedRef.current = true
        void loadCommitDetails(result[0])
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      log.error('Failed to load commits', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [clearSelection, currentWorkspace, getLog, isWorkbench, loadCommitDetails, noWorkspaceError, targetCommitSha])

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

  const loadFileHistory = useCallback(async (filePath: string) => {
    if (!currentWorkspace) {
      setError(noWorkspaceError)
      return
    }

    setIsLoading(true)
    setError(null)
    setFileHistoryPath(filePath)
    setFileHistoryEntries([])
    setFileHistoryHasMore(true)
    setFileHistoryTotalCount(0)
    setSearchQuery('')

    try {
      const result = await getFileHistory(currentWorkspace.path, filePath, PAGE_SIZE, 0)
      setFileHistoryEntries(result)
      setFileHistoryHasMore(result.length === PAGE_SIZE)
      setFileHistoryTotalCount(result.length)
      if (result.length > 0) {
        selectFileHistoryEntry(result[0])
      } else {
        clearSelection()
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      log.error('Failed to load file history', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [clearSelection, currentWorkspace, getFileHistory, noWorkspaceError, selectFileHistoryEntry])

  const loadMoreFileHistory = useCallback(async () => {
    if (!currentWorkspace || !fileHistoryPath || isLoadingMore || !fileHistoryHasMore) return

    setIsLoadingMore(true)

    try {
      const result = await getFileHistory(
        currentWorkspace.path,
        fileHistoryPath,
        PAGE_SIZE,
        fileHistoryEntries.length
      )

      if (result.length === 0) {
        setFileHistoryHasMore(false)
      } else {
        setFileHistoryEntries(prev => [...prev, ...result])
        setFileHistoryTotalCount(prev => prev + result.length)
        setFileHistoryHasMore(result.length === PAGE_SIZE)
      }
    } catch (err) {
      log.error('Failed to load more file history', err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoadingMore(false)
    }
  }, [
    currentWorkspace,
    fileHistoryEntries.length,
    fileHistoryHasMore,
    fileHistoryPath,
    getFileHistory,
    isLoadingMore,
  ])

  // 滚动加载更多
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || isLoadingMore || !activeHasMore) return

    const { scrollTop, scrollHeight, clientHeight } = container
    if (scrollHeight - scrollTop - clientHeight < 100) {
      if (isFileHistoryMode) {
        loadMoreFileHistory()
      } else {
        loadMoreCommits()
      }
    }
  }, [activeHasMore, isFileHistoryMode, isLoadingMore, loadMoreCommits, loadMoreFileHistory])

  // 初始加载
  useEffect(() => {
    loadCommits()
  }, [loadCommits])

  useEffect(() => {
    writeLocalStorage(FILE_LIST_MODE_STORAGE_KEY, fileListMode)
  }, [fileListMode])

  useEffect(() => {
    writeLocalStorage(DIFF_VIEW_MODE_STORAGE_KEY, diffViewMode)
  }, [diffViewMode])

  useEffect(() => {
    writeLocalStorage(COMMIT_LIST_WIDTH_STORAGE_KEY, String(commitListWidth))
  }, [commitListWidth])

  useEffect(() => {
    writeLocalStorage(FILE_PANE_WIDTH_STORAGE_KEY, String(filePaneWidth))
  }, [filePaneWidth])

  useEffect(() => () => {
    if (copyResetTimerRef.current) {
      window.clearTimeout(copyResetTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!selectedFileDiff) return
    if (filteredSelectedFiles.some((file) => getDiffKey(file) === getDiffKey(selectedFileDiff))) return

    setSelectedFileDiff(filteredSelectedFiles[0] ?? null)
  }, [filteredSelectedFiles, selectedFileDiff])

  useEffect(() => {
    hasAutoSelectedRef.current = false
    setFileHistoryPath(null)
    setFileHistoryEntries([])
    setFileHistoryHasMore(true)
    setFileHistoryTotalCount(0)
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
    if (fileHistoryPath) {
      loadFileHistory(fileHistoryPath)
      return
    }

    loadCommits()
  }, [fileHistoryPath, loadCommits, loadFileHistory])

  const handleExitFileHistory = useCallback(() => {
    setFileHistoryPath(null)
    setFileHistoryEntries([])
    setFileHistoryHasMore(true)
    setFileHistoryTotalCount(0)
    setSearchQuery('')
    clearSelection()

    if (isWorkbench && commits[0]) {
      void loadCommitDetails(commits[0])
    }
  }, [clearSelection, commits, isWorkbench, loadCommitDetails])

  const copyText = useCallback(async (text: string | undefined, action: CopyAction) => {
    if (!text) return

    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error('Clipboard API is unavailable')
      }

      await navigator.clipboard.writeText(text)
      setCopiedAction(action)
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current)
      }
      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedAction(null)
        copyResetTimerRef.current = null
      }, 1600)
    } catch (err) {
      log.error('Failed to copy commit text', err instanceof Error ? err : new Error(String(err)))
    }
  }, [])

  const stopPaneResize = useCallback(() => {
    if (!paneResizeCleanupRef.current) return

    paneResizeCleanupRef.current()
    paneResizeCleanupRef.current = null
  }, [])

  const startPaneResize = useCallback((
    pane: 'commits' | 'files',
    event: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (!isWorkbench) return

    event.preventDefault()
    stopPaneResize()
    const startX = event.clientX
    const startWidth = pane === 'commits' ? commitListWidth : filePaneWidth
    const minWidth = pane === 'commits' ? COMMIT_LIST_MIN_WIDTH : FILE_PANE_MIN_WIDTH
    const maxWidth = pane === 'commits' ? COMMIT_LIST_MAX_WIDTH : FILE_PANE_MAX_WIDTH
    const setWidth = pane === 'commits' ? setCommitListWidth : setFilePaneWidth

    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = clamp(startWidth + moveEvent.clientX - startX, minWidth, maxWidth)
      setWidth(nextWidth)
    }

    const handlePointerUp = () => {
      stopPaneResize()
    }

    const cleanup = () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    paneResizeCleanupRef.current = cleanup
  }, [commitListWidth, filePaneWidth, isWorkbench, stopPaneResize])

  useEffect(() => stopPaneResize, [stopPaneResize])

  const renderCommitRow = (commit: GitCommitType) => (
    <div
      key={commit.sha}
      onClick={() => loadCommitDetails(commit)}
      title={commit.message.split('\n')[0]}
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
  )

  const renderFileHistoryRow = (entry: GitFileHistoryEntry) => (
    <div
      key={`${entry.commit.sha}:${getDiffKey(entry.file)}`}
      onClick={() => selectFileHistoryEntry(entry)}
      title={entry.commit.message.split('\n')[0]}
      className={`px-4 py-3 cursor-pointer hover:bg-background-hover transition-colors border-b border-border-subtle ${
        selectedCommit?.sha === entry.commit.sha ? 'bg-primary/5' : ''
      }`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center">
          <FileClock size={12} className="text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-xs font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
              {entry.commit.shortSha}
            </span>
            <span className="text-[10px] text-text-tertiary">
              <span className="text-success">+{entry.file.additions ?? 0}</span>
              <span className="text-danger ml-1">-{entry.file.deletions ?? 0}</span>
            </span>
          </div>
          <div className="text-sm text-text-primary font-medium truncate mb-1">
            {entry.commit.message.split('\n')[0]}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-tertiary min-w-0">
            <span className="flex items-center gap-1 min-w-0">
              <User size={10} className="shrink-0" />
              <span className="truncate">{entry.commit.author}</span>
            </span>
            <span className="flex items-center gap-1 shrink-0">
              <Clock size={10} />
              {formatTime(entry.commit.timestamp)}
            </span>
          </div>
        </div>
        <ChevronRight size={14} className="text-text-tertiary flex-shrink-0" />
      </div>
    </div>
  )

  const renderCommitList = () => {
    const activeItems = isFileHistoryMode ? fileHistoryEntries : commits
    const filteredItems = isFileHistoryMode ? filteredFileHistoryEntries : filteredCommits

    return (
      <div
        ref={scrollContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0"
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : activeItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            {isFileHistoryMode ? (
              <FileClock size={24} className="mb-2 opacity-50" />
            ) : (
              <GitCommitIcon size={24} className="mb-2 opacity-50" />
            )}
            <span className="text-sm">
              {isFileHistoryMode ? t('history.noFileHistory') : t('history.noCommits')}
            </span>
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Search size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('history.noSearchResults')}</span>
          </div>
        ) : (
          <>
            {isFileHistoryMode
              ? filteredFileHistoryEntries.map(renderFileHistoryRow)
              : filteredCommits.map(renderCommitRow)}

            {isLoadingMore && (
              <div className="flex items-center justify-center py-3 text-text-tertiary">
                <Loader2 size={14} className="animate-spin mr-2" />
                <span className="text-xs">{t('history.loadingMore')}</span>
              </div>
            )}

            {activeHasMore && !isLoadingMore && (
              <div className="flex items-center justify-center py-3 text-text-tertiary">
                <ChevronDown className="w-4 h-4 animate-bounce mr-2" />
                <span className="text-xs">{t('history.scrollForMore')}</span>
              </div>
            )}

            {!activeHasMore && activeItems.length > 0 && (
              <div className="flex items-center justify-center py-3 text-text-tertiary">
                <span className="text-xs">
                  {isFileHistoryMode
                    ? t('history.fileHistoryLoaded', { count: fileHistoryEntries.length })
                    : normalizedSearchQuery
                      ? t('history.filteredCommitsLoaded', { shown: filteredCommits.length, count: commits.length })
                      : t('history.commitsLoaded', { count: commits.length })}
                </span>
              </div>
            )}
          </>
        )}
      </div>
    )
  }

  const renderFileButton = (file: GitDiffEntry) => {
    const isSelected = selectedFileDiff ? getDiffKey(selectedFileDiff) === getDiffKey(file) : false

    return (
      <div
        key={getDiffKey(file)}
        title={file.file_path}
        className={`group flex items-center border-b border-border-subtle hover:bg-background-hover transition-colors ${
          isSelected ? 'bg-primary/5' : ''
        }`}
      >
        <button
          type="button"
          onClick={() => setSelectedFileDiff(file)}
          className="min-w-0 flex-1 px-4 py-2 flex items-center gap-2 text-left"
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
        <button
          type="button"
          onClick={() => void loadFileHistory(file.file_path)}
          className="mr-2 p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors opacity-70 group-hover:opacity-100 shrink-0"
          title={t('history.viewFileHistory')}
        >
          <FileClock size={13} />
        </button>
      </div>
    )
  }

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
            <div className="flex items-center gap-1 shrink-0">
              {selectedCommit && (
                <>
                  <button
                    type="button"
                    onClick={() => copyText(selectedCommit.sha, 'sha')}
                    className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                    title={copiedAction === 'sha' ? t('history.copied') : t('history.copySha')}
                  >
                    {copiedAction === 'sha' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => copyText(selectedCommit.message, 'message')}
                    className="p-1 text-text-tertiary hover:text-primary hover:bg-background-hover rounded transition-colors"
                    title={copiedAction === 'message' ? t('history.copied') : t('history.copyMessage')}
                  >
                    {copiedAction === 'message' ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={clearSelection}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                title={t('history.closeDetails')}
              >
                <X size={14} />
              </button>
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
            {!isFileHistoryMode && (
              <div
                className={`${isWorkbench ? 'relative border-r' : 'max-h-56 border-b'} border-border-subtle shrink-0 flex flex-col min-h-0`}
                style={isWorkbench ? { width: filePaneWidth } : undefined}
              >
                {selectedDetails.files.length === 0 ? (
                  <div className="p-4 text-sm text-text-tertiary text-center">
                    {t('history.noFileChanges')}
                  </div>
                ) : (
                  <>
                    <div className="p-2 border-b border-border-subtle bg-background-surface shrink-0">
                      <div className="flex items-center gap-1.5">
                        <div className="relative flex-1 min-w-0">
                          <Search
                            size={13}
                            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
                          />
                          <input
                            type="search"
                            value={fileSearchQuery}
                            onChange={(event) => setFileSearchQuery(event.target.value)}
                            placeholder={t('history.fileSearchPlaceholder')}
                            className="w-full h-7 pl-7 pr-7 text-xs bg-background-base border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder:text-text-tertiary"
                          />
                          {fileSearchQuery && (
                            <button
                              type="button"
                              onClick={() => setFileSearchQuery('')}
                              className="absolute right-1 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
                              title={t('history.clearFileSearch')}
                            >
                              <X size={12} />
                            </button>
                          )}
                        </div>
                        <div className="flex items-center bg-background-base border border-border rounded shrink-0">
                          <button
                            type="button"
                            onClick={() => setFileListMode('list')}
                            className={`p-1.5 transition-colors ${fileListMode === 'list' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                            title={t('history.listView')}
                          >
                            <List size={13} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setFileListMode('tree')}
                            className={`p-1.5 transition-colors ${fileListMode === 'tree' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                            title={t('history.treeView')}
                          >
                            <FolderTree size={13} />
                          </button>
                        </div>
                      </div>
                      {normalizedFileSearchQuery && (
                        <div className="mt-1.5 text-[11px] text-text-tertiary">
                          {t('history.fileSearchCount', {
                            shown: filteredSelectedFiles.length,
                            count: selectedDetails.files.length,
                          })}
                        </div>
                      )}
                    </div>

                    <div className="flex-1 overflow-y-auto min-h-0">
                      {filteredSelectedFiles.length === 0 ? (
                        <div className="p-4 text-sm text-text-tertiary text-center">
                          {t('history.noFileSearchResults')}
                        </div>
                      ) : fileListMode === 'tree' ? (
                        groupedSelectedFiles.map((group) => (
                          <div key={group.directory}>
                            <div className="sticky top-0 px-4 py-1.5 bg-background-surface border-b border-border-subtle text-[11px] font-medium text-text-tertiary flex items-center gap-1.5">
                              <FolderTree size={12} />
                              <span className="truncate">{group.directory}</span>
                            </div>
                            {group.files.map(renderFileButton)}
                          </div>
                        ))
                      ) : (
                        filteredSelectedFiles.map(renderFileButton)
                      )}
                    </div>
                  </>
                )}
                {isWorkbench && (
                  <div
                    role="separator"
                    aria-orientation="vertical"
                    onPointerDown={(event) => startPaneResize('files', event)}
                    className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors"
                    title={t('history.resizePane')}
                  />
                )}
              </div>
            )}

            <div className="flex-1 flex flex-col min-h-0">
              {selectedFileDiff ? (
                <>
                  <div className="px-4 py-2 border-b border-border-subtle bg-background-surface flex items-center gap-2 shrink-0">
                    <span className="flex-1 text-xs font-medium text-text-secondary truncate">
                      {selectedFileDiff.file_path}
                    </span>
                    <div className="flex items-center bg-background-base border border-border rounded shrink-0">
                      <button
                        type="button"
                        onClick={() => setDiffViewMode('unified')}
                        className={`p-1.5 transition-colors ${diffViewMode === 'unified' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                        title={t('diff.unifiedView')}
                      >
                        <Rows3 size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiffViewMode('split')}
                        className={`p-1.5 transition-colors ${diffViewMode === 'split' ? 'text-primary bg-primary/10' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'}`}
                        title={t('diff.splitView')}
                      >
                        <Columns2 size={13} />
                      </button>
                    </div>
                    {onOpenDiffInTab && (
                      <button
                        type="button"
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
                    viewMode={diffViewMode}
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
        <div className="flex items-center gap-2 min-w-0">
          {isFileHistoryMode && (
            <button
              type="button"
              onClick={handleExitFileHistory}
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors shrink-0"
              title={t('history.backToCommitHistory')}
            >
              <ArrowLeft size={14} />
            </button>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-medium text-text-primary truncate">
                {isFileHistoryMode ? t('history.fileHistoryTitle') : t('history.title')}
              </span>
              {activeTotalCount > 0 && (
                <span className="text-xs text-text-tertiary shrink-0">
                  ({activeTotalCount}{activeHasMore ? '+' : ''})
                </span>
              )}
            </div>
            {isFileHistoryMode && fileHistoryPath && (
              <div className="mt-0.5 text-[11px] text-text-tertiary truncate" title={fileHistoryPath}>
                {fileHistoryPath}
              </div>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          title={t('refreshStatus')}
        >
          <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border-subtle shrink-0">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={isFileHistoryMode
              ? t('history.fileHistorySearchPlaceholder')
              : t('history.searchPlaceholder')}
            className="w-full h-8 pl-8 pr-8 text-sm bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary text-text-primary placeholder:text-text-tertiary"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              title={t('history.clearSearch')}
            >
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      <div className={isWorkbench ? 'flex-1 flex min-h-0' : 'flex-1 flex flex-col min-h-0'}>
        <div
          className={isWorkbench ? 'relative border-r border-border-subtle flex flex-col min-h-0 shrink-0' : 'flex-1 flex flex-col min-h-0'}
          style={isWorkbench ? { width: commitListWidth } : undefined}
        >
          {renderCommitList()}
          {isWorkbench && (
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(event) => startPaneResize('commits', event)}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors"
              title={t('history.resizePane')}
            />
          )}
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
