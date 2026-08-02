/**
 * 提交历史组件
 *
 * 显示 Git 提交历史列表，支持滚动加载更多，并可查看单个提交的文件和内容。
 */

import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GitCommit as GitCommitIcon,
  RefreshCw,
  Loader2,
  ChevronDown,
  Search,
  X,
  FileClock,
  GitBranch as GitBranchIcon,
  ArrowLeft,
  Copy,
  GitMerge,
  RotateCcw,
  Undo2,
  GitBranchPlus,
  Tag,
  Trash2,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { parseGitError } from '@/stores/gitStore'
import type {
  GitCommit as GitCommitType,
  GitCommitDetails,
  GitDiffEntry,
  GitFileHistoryEntry,
} from '@/types/git'
import type { OpenDiffTabOptions } from '@/stores/tabStore'
import { createLogger } from '@/utils/logger'
import { ContextMenu, type ContextMenuItem } from '@/components/FileExplorer/ContextMenu'
import { ConfirmDialog } from '@/components/Common/ConfirmDialog'
import {
  PAGE_SIZE,
  COMMIT_LIST_MIN_WIDTH,
  COMMIT_LIST_MAX_WIDTH,
  FILE_PANE_MIN_WIDTH,
  FILE_PANE_MAX_WIDTH,
  getDiffKey,
  writeLocalStorage,
  getInitialFileListMode,
  getInitialDiffViewMode,
  getInitialFilePaneCollapsed,
  getInitialPaneWidth,
  clamp,
  formatRelativeTime,
  getCommitTypeColor,
  getFileStatusBadge,
  INLINE_FILES_MAX_HEIGHT,
  FILE_LIST_MODE_STORAGE_KEY,
  COMMIT_LIST_WIDTH_STORAGE_KEY,
  FILE_PANE_WIDTH_STORAGE_KEY,
  FILE_PANE_COLLAPSED_STORAGE_KEY,
  DIFF_VIEW_MODE_STORAGE_KEY,
} from './historyTabUtils'
import type { FileListMode, CopyAction } from './historyTabUtils'
import { CommitDetailsPane } from './CommitDetailsPane'
import { CreateBranchFromCommitDialog } from './CreateBranchFromCommitDialog'
import { CreateTagFromCommitDialog } from './CreateTagFromCommitDialog'

const log = createLogger('HistoryTab')

interface HistoryTabProps {
  targetCommitSha?: string | null
  onCommitSelected?: () => void
  onOpenDiffInTab?: (diff: GitDiffEntry, options?: OpenDiffTabOptions) => void
  onOpenFileInEditor?: (filePath: string) => void
  variant?: 'sidebar' | 'workbench'
}

export function HistoryTab({
  targetCommitSha,
  onCommitSelected,
  onOpenDiffInTab,
  onOpenFileInEditor,
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
  const [selectedBranch, setSelectedBranch] = useState('')
  const [branchSelectOpen, setBranchSelectOpen] = useState(false)
  const branchSelectRef = useRef<HTMLDivElement>(null)
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [fileListMode, setFileListMode] = useState<FileListMode>(getInitialFileListMode)
  const [diffViewMode, setDiffViewMode] = useState<import('@/components/Diff/DiffViewer').DiffViewMode>(getInitialDiffViewMode)
  const [copiedAction, setCopiedAction] = useState<CopyAction | null>(null)
  const [isCommitMessageExpanded, setIsCommitMessageExpanded] = useState(false)
  const [isFilePaneCollapsed, setIsFilePaneCollapsed] = useState(getInitialFilePaneCollapsed)
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

  const [commitContextMenu, setCommitContextMenu] = useState<{ x: number; y: number; commit: GitCommitType } | null>(null)
  const [confirmDialog, setConfirmDialog] = useState<{
    show: boolean
    title: string
    message: string
    type?: 'danger' | 'warning'
    onConfirm: () => void
  } | null>(null)
  const [createBranchFromCommit, setCreateBranchFromCommit] = useState<GitCommitType | null>(null)
  const [createTagFromCommit, setCreateTagFromCommit] = useState<GitCommitType | null>(null)

  const getLog = useGitStore((s) => s.getLog)
  const getCommitDetails = useGitStore((s) => s.getCommitDetails)
  const getFileHistory = useGitStore((s) => s.getFileHistory)
  const branches = useGitStore((s) => s.branches)
  const getBranches = useGitStore((s) => s.getBranches)
  const currentBranchName = useGitStore((s) => s.status?.branch ?? '')
  const cherryPick = useGitStore((s) => s.cherryPick)
  const revert = useGitStore((s) => s.revert)
  const reset = useGitStore((s) => s.reset)
  const checkoutCommit = useGitStore((s) => s.checkoutCommit)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId, viewingWorkspaceId } = s
    const targetId = viewingWorkspaceId || currentWorkspaceId
    return workspaces.find(w => w.id === targetId) || null
  })
  const toast = useToastStore()

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
    setIsCommitMessageExpanded(false)
  }, [])

  const clearFileHistoryMode = useCallback(() => {
    setFileHistoryPath(null)
    setFileHistoryEntries([])
    setFileHistoryHasMore(true)
    setFileHistoryTotalCount(0)
  }, [])

  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  const normalizedFileSearchQuery = fileSearchQuery.trim().toLowerCase()

  const branchOptions = useMemo(() => {
    const seen = new Set<string>()
    return branches.filter((branch) => {
      if (!branch.name || seen.has(branch.name)) return false
      if (branch.name === currentBranchName) return false
      seen.add(branch.name)
      return true
    })
  }, [branches, currentBranchName])

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
    setIsCommitMessageExpanded(false)
  }, [])

  const loadCommitDetails = useCallback(async (commit: GitCommitType) => {
    if (!currentWorkspace) return

    const requestId = ++detailsRequestRef.current
    setSelectedCommit(commit)
    setSelectedDetails(null)
    setSelectedFileDiff(null)
    setDetailsError(null)
    setIsDetailsLoading(true)
    setIsCommitMessageExpanded(false)

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
    setIsCommitMessageExpanded(false)

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

  const loadCommits = useCallback(async () => {
    if (!currentWorkspace) {
      setError(noWorkspaceError)
      return
    }

    setIsLoading(true)
    setError(null)
    setHasMore(true)

    try {
      log.debug('Loading commits', { path: currentWorkspace.path, branch: selectedBranch || null })
      const result = await getLog(currentWorkspace.path, PAGE_SIZE, 0, selectedBranch || undefined)
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
  }, [
    clearSelection,
    currentWorkspace,
    getLog,
    isWorkbench,
    loadCommitDetails,
    noWorkspaceError,
    selectedBranch,
    targetCommitSha,
  ])

  const loadMoreCommits = useCallback(async () => {
    if (!currentWorkspace || isLoadingMore || !hasMore) return

    setIsLoadingMore(true)

    try {
      const skip = commits.length
      const result = await getLog(currentWorkspace.path, PAGE_SIZE, skip, selectedBranch || undefined)

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
  }, [currentWorkspace, commits.length, getLog, hasMore, isLoadingMore, selectedBranch])

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
      const result = await getFileHistory(
        currentWorkspace.path,
        filePath,
        PAGE_SIZE,
        0,
        selectedBranch || undefined
      )
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
  }, [
    clearSelection,
    currentWorkspace,
    getFileHistory,
    noWorkspaceError,
    selectFileHistoryEntry,
    selectedBranch,
  ])

  const loadMoreFileHistory = useCallback(async () => {
    if (!currentWorkspace || !fileHistoryPath || isLoadingMore || !fileHistoryHasMore) return

    setIsLoadingMore(true)

    try {
      const result = await getFileHistory(
        currentWorkspace.path,
        fileHistoryPath,
        PAGE_SIZE,
        fileHistoryEntries.length,
        selectedBranch || undefined
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
    selectedBranch,
  ])

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

  useEffect(() => {
    loadCommits()
  }, [loadCommits])

  useEffect(() => {
    if (!currentWorkspace) return
    void getBranches(currentWorkspace.path)
  }, [currentWorkspace, getBranches])

  // 点击外部关闭分支选择下拉框
  useEffect(() => {
    if (!branchSelectOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (branchSelectRef.current && !branchSelectRef.current.contains(e.target as Node)) {
        setBranchSelectOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [branchSelectOpen])

  useEffect(() => {
    writeLocalStorage(FILE_LIST_MODE_STORAGE_KEY, fileListMode)
  }, [fileListMode])

  useEffect(() => {
    writeLocalStorage(DIFF_VIEW_MODE_STORAGE_KEY, diffViewMode)
  }, [diffViewMode])

  useEffect(() => {
    writeLocalStorage(FILE_PANE_COLLAPSED_STORAGE_KEY, String(isFilePaneCollapsed))
  }, [isFilePaneCollapsed])

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
    setSelectedBranch('')
    clearFileHistoryMode()
    clearSelection()
  }, [clearFileHistoryMode, clearSelection, currentWorkspace?.path])

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

  const handleRefresh = useCallback(() => {
    if (fileHistoryPath) {
      loadFileHistory(fileHistoryPath)
      return
    }

    loadCommits()
  }, [fileHistoryPath, loadCommits, loadFileHistory])

  const closeCommitContextMenu = useCallback(() => setCommitContextMenu(null), [])

  const handleCommitContextMenu = useCallback((e: React.MouseEvent, commit: GitCommitType) => {
    e.preventDefault()
    e.stopPropagation()
    setCommitContextMenu({ x: e.clientX, y: e.clientY, commit })
  }, [])

  const handleBranchFilterChange = useCallback((nextBranch: string) => {
    if (nextBranch === selectedBranch) return

    setSelectedBranch(nextBranch)
    setBranchSelectOpen(false)
    setSearchQuery('')
    hasAutoSelectedRef.current = false
    clearFileHistoryMode()
    clearSelection()
  }, [clearFileHistoryMode, clearSelection, selectedBranch])

  const handleExitFileHistory = useCallback(() => {
    clearFileHistoryMode()
    setSearchQuery('')
    clearSelection()

    if (isWorkbench && commits[0]) {
      void loadCommitDetails(commits[0])
    }
  }, [clearFileHistoryMode, clearSelection, commits, isWorkbench, loadCommitDetails])

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

  const buildCommitContextMenuItems = useCallback((commit: GitCommitType): ContextMenuItem[] => {
    const isHeadCommit = commits.length > 0 && commits[0].sha === commit.sha
    const items: ContextMenuItem[] = [
      // -- Copy --
      {
        id: 'copy-sha',
        label: t('history.copySha'),
        icon: <Copy size={14} />,
        action: () => copyText(commit.sha, 'sha'),
      },
      {
        id: 'copy-message',
        label: t('history.copyMessage'),
        icon: <Copy size={14} />,
        action: () => copyText(commit.message, 'message'),
      },
      {
        id: 'copy-author',
        label: t('history.copyAuthor'),
        icon: <Copy size={14} />,
        action: () => copyText(commit.author, 'author'),
      },
      {
        id: 'copy-author-email',
        label: t('history.copyAuthorEmail'),
        icon: <Copy size={14} />,
        action: () => copyText(commit.authorEmail, 'authorEmail'),
      },
      { id: 'sep-1', label: '-', icon: undefined, action: () => {} },

      // -- Branch/Tag --
      {
        id: 'create-branch',
        label: t('history.createBranch'),
        icon: <GitBranchPlus size={14} />,
        action: () => setCreateBranchFromCommit(commit),
      },
      {
        id: 'create-tag',
        label: t('history.createTag'),
        icon: <Tag size={14} />,
        action: () => setCreateTagFromCommit(commit),
      },
      {
        id: 'checkout-commit',
        label: t('history.checkoutCommit'),
        icon: <GitBranchIcon size={14} />,
        action: () => {
          if (!currentWorkspace) return
          setConfirmDialog({
            show: true,
            title: t('history.checkoutCommitTitle'),
            message: t('history.checkoutCommitConfirm'),
            type: 'warning',
            onConfirm: async () => {
              setConfirmDialog(null)
              try {
                await checkoutCommit(currentWorkspace.path, commit.sha)
                toast.success(t('history.checkoutCommitSuccess'))
                void loadCommits()
              } catch (err) {
                toast.error(t('history.checkoutCommitFailed', { error: parseGitError(err) }))
              }
            },
          })
        },
      },
      { id: 'sep-2', label: '-', icon: undefined, action: () => {} },

      // -- Cherry-pick / Revert --
      {
        id: 'cherry-pick',
        label: t('cherryPick.button'),
        icon: <GitMerge size={14} />,
        action: () => {
          if (!currentWorkspace) return
          setConfirmDialog({
            show: true,
            title: t('cherryPick.title'),
            message: t('cherryPick.confirm'),
            onConfirm: async () => {
              setConfirmDialog(null)
              try {
                await cherryPick(currentWorkspace.path, commit.sha)
                toast.success(t('cherryPick.success'))
                void loadCommits()
              } catch (err) {
                toast.error(t('cherryPick.failed', { error: parseGitError(err) }))
              }
            },
          })
        },
      },
      {
        id: 'revert',
        label: t('revert.button'),
        icon: <RotateCcw size={14} />,
        action: () => {
          if (!currentWorkspace) return
          setConfirmDialog({
            show: true,
            title: t('revert.title'),
            message: t('revert.confirm'),
            onConfirm: async () => {
              setConfirmDialog(null)
              try {
                await revert(currentWorkspace.path, commit.sha)
                toast.success(t('revert.success'))
                void loadCommits()
              } catch (err) {
                toast.error(t('revert.failed', { error: parseGitError(err) }))
              }
            },
          })
        },
      },
      { id: 'sep-3', label: '-', icon: undefined, action: () => {} },

      // -- Reset (HEAD commit only) --
      {
        id: 'undo-commit',
        label: t('history.undoCommit'),
        icon: <Undo2 size={14} />,
        disabled: !isHeadCommit,
        action: () => {
          if (!currentWorkspace) return
          setConfirmDialog({
            show: true,
            title: t('history.undoCommitTitle'),
            message: t('history.undoCommitConfirm'),
            onConfirm: async () => {
              setConfirmDialog(null)
              try {
                await reset(currentWorkspace.path, 'soft', commit.sha + '^')
                toast.success(t('history.undoCommitSuccess'))
                void loadCommits()
              } catch (err) {
                toast.error(t('history.undoCommitFailed', { error: parseGitError(err) }))
              }
            },
          })
        },
      },
      {
        id: 'drop-commit',
        label: t('history.dropCommit'),
        icon: <Trash2 size={14} />,
        disabled: !isHeadCommit,
        action: () => {
          if (!currentWorkspace) return
          setConfirmDialog({
            show: true,
            title: t('history.dropCommitTitle'),
            message: t('history.dropCommitConfirm'),
            type: 'danger',
            onConfirm: async () => {
              setConfirmDialog(null)
              try {
                await reset(currentWorkspace.path, 'hard', commit.sha + '^')
                toast.success(t('history.dropCommitSuccess'))
                void loadCommits()
              } catch (err) {
                toast.error(t('history.dropCommitFailed', { error: parseGitError(err) }))
              }
            },
          })
        },
      },
    ]
    return items
  }, [cherryPick, checkoutCommit, commits, copyText, currentWorkspace, loadCommits, reset, revert, t, toast])

  // 在中央编辑器打开某提交中某文件的 diff（复用同一标签页，identity 去重）
  const openFileDiffInTab = useCallback((commit: GitCommitType, file: GitDiffEntry) => {
    onOpenDiffInTab?.(file, {
      identity: `history:${commit.sha}:${getDiffKey(file)}`,
      titleContext: commit.shortSha,
      metadata: {
        commitSha: commit.sha,
        shortSha: commit.shortSha,
        source: isFileHistoryMode ? 'file-history' : 'commit-history',
      },
    })
  }, [isFileHistoryMode, onOpenDiffInTab])

  // 侧边栏：再次点击已展开的提交则收起（手风琴）；其余情况加载详情
  const handleCommitRowClick = useCallback((commit: GitCommitType) => {
    if (!isWorkbench && selectedCommit?.sha === commit.sha) {
      clearSelection()
      return
    }
    void loadCommitDetails(commit)
  }, [clearSelection, isWorkbench, loadCommitDetails, selectedCommit?.sha])

  // 工作台：右侧详情面板；侧边栏：直接在编辑器打开该文件的 diff
  const handleFileHistoryRowClick = useCallback((entry: GitFileHistoryEntry) => {
    if (isWorkbench) {
      selectFileHistoryEntry(entry)
      return
    }
    setSelectedCommit(entry.commit)
    openFileDiffInTab(entry.commit, entry.file)
  }, [isWorkbench, openFileDiffInTab, selectFileHistoryEntry])

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

  const renderInlineFileRow = (commit: GitCommitType, file: GitDiffEntry) => {
    const badge = getFileStatusBadge(file.change_type)
    return (
      <div
        key={getDiffKey(file)}
        onClick={() => openFileDiffInTab(commit, file)}
        title={`${file.file_path} · ${t('history.openDiffInEditor')}`}
        className="group flex items-center gap-2 pl-7 pr-2 py-1.5 cursor-pointer border-l-2 border-transparent hover:bg-background-hover hover:border-primary/50 transition-colors"
      >
        <span
          className="w-3.5 h-3.5 rounded-[3px] text-[9px] font-bold flex items-center justify-center shrink-0"
          style={{ background: `rgb(var(${badge.colorVar}) / 0.16)`, color: `rgb(var(${badge.colorVar}))` }}
        >
          {badge.letter}
        </span>
        <span
          className="flex-1 min-w-0 text-xs text-text-secondary group-hover:text-text-primary truncate"
          style={{ direction: 'rtl', textAlign: 'left' }}
        >
          {file.file_path}
        </span>
        <span className="text-[10px] shrink-0">
          <span className="text-success">+{file.additions ?? 0}</span>
          <span className="text-danger ml-1">-{file.deletions ?? 0}</span>
        </span>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); void loadFileHistory(file.file_path) }}
          className="p-1 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors opacity-0 group-hover:opacity-100 shrink-0"
          title={t('history.viewFileHistory')}
        >
          <FileClock size={12} />
        </button>
      </div>
    )
  }

  // 侧边栏专用：点击提交后在该行下方就地展开的文件清单（文件多时容器内部滚动）
  const renderInlineDetails = (commit: GitCommitType) => {
    const isActive = selectedCommit?.sha === commit.sha

    if (isDetailsLoading && isActive) {
      return (
        <div className="flex items-center gap-2 pl-7 pr-3 py-3 text-xs text-text-tertiary bg-background-elevated border-y border-border-subtle">
          <Loader2 size={13} className="animate-spin" />
          {t('history.loadingDetails')}
        </div>
      )
    }

    if (detailsError && isActive) {
      return (
        <div className="pl-7 pr-3 py-2 text-xs text-danger bg-danger/10 border-y border-danger/20">
          {t('history.detailLoadFailed')}: {detailsError}
        </div>
      )
    }

    if (!selectedDetails || selectedDetails.commit.sha !== commit.sha) return null

    const files = selectedDetails.files
    return (
      <div className="bg-background-elevated border-y border-border-subtle">
        <div className="flex items-center gap-2 pl-7 pr-3 py-1.5 text-[11px] text-text-tertiary">
          <span className="truncate max-w-[150px]">{commit.author}</span>
          <span>·</span>
          <span className="shrink-0">{t('history.filesChanged', { count: files.length })}</span>
          <span className="text-success shrink-0">+{selectedDetails.totalAdditions}</span>
          <span className="text-danger shrink-0">-{selectedDetails.totalDeletions}</span>
        </div>
        {files.length === 0 ? (
          <div className="pl-7 pr-3 py-2 text-xs text-text-tertiary">{t('history.noFileChanges')}</div>
        ) : (
          <div className="overflow-y-auto" style={{ maxHeight: INLINE_FILES_MAX_HEIGHT }}>
            {files.map((file) => renderInlineFileRow(commit, file))}
          </div>
        )}
      </div>
    )
  }

  const renderCommitRow = (commit: GitCommitType) => {
    const subject = commit.message.split('\n')[0]
    const isSelected = selectedCommit?.sha === commit.sha

    return (
      <Fragment key={commit.sha}>
        <div
          onClick={() => handleCommitRowClick(commit)}
          onContextMenu={(e) => handleCommitContextMenu(e, commit)}
          title={`${subject}\n${commit.author}`}
          className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer border-l-2 transition-colors ${
            isSelected ? 'bg-primary/10 border-primary' : 'border-transparent hover:bg-background-hover'
          }`}
        >
          <span
            className="w-1.5 h-1.5 rounded-full shrink-0"
            style={{ background: isSelected ? 'rgb(var(--c-primary))' : getCommitTypeColor(commit.message) }}
          />
          <span className="text-[11px] font-mono text-text-tertiary shrink-0">{commit.shortSha}</span>
          <span className={`flex-1 min-w-0 text-[13px] truncate ${isSelected ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
            {subject}
          </span>
          <span className="text-[11px] text-text-tertiary shrink-0">{formatRelativeTime(commit.timestamp, t)}</span>
        </div>
        {!isWorkbench && isSelected && renderInlineDetails(commit)}
      </Fragment>
    )
  }

  const renderFileHistoryRow = (entry: GitFileHistoryEntry) => {
    const subject = entry.commit.message.split('\n')[0]
    const isSelected = selectedCommit?.sha === entry.commit.sha

    return (
      <div
        key={`${entry.commit.sha}:${getDiffKey(entry.file)}`}
        onClick={() => handleFileHistoryRowClick(entry)}
        onContextMenu={(e) => handleCommitContextMenu(e, entry.commit)}
        title={`${subject}\n${entry.commit.author}`}
        className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer border-l-2 transition-colors ${
          isSelected ? 'bg-primary/10 border-primary' : 'border-transparent hover:bg-background-hover'
        }`}
      >
        <FileClock size={12} className="text-text-tertiary shrink-0" />
        <span className="text-[11px] font-mono text-text-tertiary shrink-0">{entry.commit.shortSha}</span>
        <span className={`flex-1 min-w-0 text-[13px] truncate ${isSelected ? 'text-text-primary font-medium' : 'text-text-secondary'}`}>
          {subject}
        </span>
        <span className="text-[10px] shrink-0">
          <span className="text-success">+{entry.file.additions ?? 0}</span>
          <span className="text-danger ml-1">-{entry.file.deletions ?? 0}</span>
        </span>
        <span className="text-[11px] text-text-tertiary shrink-0">{formatRelativeTime(entry.commit.timestamp, t)}</span>
      </div>
    )
  }

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
        <div className="flex items-center gap-1.5 shrink-0">
          <div ref={branchSelectRef} className="relative">
            <button
              type="button"
              onClick={() => setBranchSelectOpen(prev => !prev)}
              aria-label={t('history.branchFilter')}
              aria-expanded={branchSelectOpen}
              aria-haspopup="listbox"
              className="h-7 flex items-center gap-1.5 pl-2 pr-1.5 text-xs bg-background-surface border border-border rounded text-text-tertiary hover:bg-background-hover hover:border-primary/30 transition-colors cursor-pointer"
              title={t('history.branchFilter')}
            >
              <GitBranchIcon size={12} className="shrink-0 text-primary" />
              <span className="max-w-[120px] text-text-secondary truncate">
                {selectedBranch || t('history.currentBranchFilter', {
                  branch: currentBranchName || t('history.head'),
                })}
              </span>
              <ChevronDown size={11} className="shrink-0 opacity-40" />
            </button>

            {branchSelectOpen && (
              <div
                className="absolute top-full mt-1 left-0 z-50 min-w-[180px] max-h-[60vh] overflow-y-auto bg-background-elevated border border-border rounded-lg shadow-lg py-1"
                role="listbox"
              >
                <button
                  type="button"
                  onClick={() => handleBranchFilterChange('')}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-background-hover transition-colors ${
                    !selectedBranch ? 'bg-primary/8 text-primary' : 'text-text-primary'
                  }`}
                  role="option"
                  aria-selected={!selectedBranch}
                >
                  <GitBranchIcon size={12} className="shrink-0 text-primary" />
                  <span className="flex-1 truncate">{t('history.currentBranchFilter', {
                    branch: currentBranchName || t('history.head'),
                  })}</span>
                  <span className="text-[10px] text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded shrink-0">HEAD</span>
                </button>

                {branchOptions.length > 0 && (
                  <>
                    <div className="mx-2 my-1 h-px bg-border" />
                    {branchOptions.map((branch) => (
                      <button
                        key={branch.name}
                        type="button"
                        onClick={() => handleBranchFilterChange(branch.name!)}
                        className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left hover:bg-background-hover transition-colors ${
                          selectedBranch === branch.name ? 'bg-primary/8 text-primary' : 'text-text-secondary'
                        }`}
                        role="option"
                        aria-selected={selectedBranch === branch.name}
                      >
                        <span className="w-4 shrink-0 text-center text-[10px]">{selectedBranch === branch.name ? '✓' : ''}</span>
                        <span className="truncate">{branch.name}</span>
                      </button>
                    ))}
                  </>
                )}
              </div>
            )}
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

      {isWorkbench ? (
        <div className="flex-1 flex min-h-0">
          <div
            className="relative border-r border-border-subtle flex flex-col min-h-0 shrink-0"
            style={{ width: commitListWidth }}
          >
            {renderCommitList()}
            <div
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(event) => startPaneResize('commits', event)}
              className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-primary/40 transition-colors"
              title={t('history.resizePane')}
            />
          </div>

          {(selectedCommit || isDetailsLoading || isWorkbench) && (
            <div className="flex-1 flex min-w-0 min-h-0">
              <CommitDetailsPane
                selectedCommit={selectedCommit}
                selectedDetails={selectedDetails}
                selectedFileDiff={selectedFileDiff}
                isDetailsLoading={isDetailsLoading}
                detailsError={detailsError}
                fileSearchQuery={fileSearchQuery}
                fileListMode={fileListMode}
                diffViewMode={diffViewMode}
                copiedAction={copiedAction}
                isCommitMessageExpanded={isCommitMessageExpanded}
                isFilePaneCollapsed={isFilePaneCollapsed}
                filePaneWidth={filePaneWidth}
                filteredSelectedFiles={filteredSelectedFiles}
                groupedSelectedFiles={groupedSelectedFiles}
                normalizedFileSearchQuery={normalizedFileSearchQuery}
                isWorkbench={isWorkbench}
                isFileHistoryMode={isFileHistoryMode}
                currentWorkspacePath={currentWorkspace?.path}
                onSetFileSearchQuery={setFileSearchQuery}
                onSetFileListMode={setFileListMode}
                onSetDiffViewMode={setDiffViewMode}
                onSetCopiedAction={setCopiedAction}
                onSetIsCommitMessageExpanded={setIsCommitMessageExpanded}
                onSetIsFilePaneCollapsed={setIsFilePaneCollapsed}
                onSetSelectedFileDiff={setSelectedFileDiff}
                onClearSelection={clearSelection}
                onCopyText={copyText}
                onLoadFileHistory={loadFileHistory}
                onOpenDiffInTab={onOpenDiffInTab}
                onOpenFileInEditor={onOpenFileInEditor}
                onStartPaneResize={startPaneResize}
              />
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 flex flex-col min-h-0">
          {renderCommitList()}
        </div>
      )}

      {commitContextMenu && (
        <ContextMenu
          visible
          x={commitContextMenu.x}
          y={commitContextMenu.y}
          items={buildCommitContextMenuItems(commitContextMenu.commit)}
          onClose={closeCommitContextMenu}
        />
      )}

      {confirmDialog?.show && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          type={confirmDialog.type}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog(null)}
        />
      )}

      {createBranchFromCommit && currentWorkspace && (
        <CreateBranchFromCommitDialog
          commit={createBranchFromCommit}
          workspacePath={currentWorkspace.path}
          onClose={() => setCreateBranchFromCommit(null)}
          onSuccess={() => {
            setCreateBranchFromCommit(null)
            void loadCommits()
          }}
        />
      )}

      {createTagFromCommit && currentWorkspace && (
        <CreateTagFromCommitDialog
          commit={createTagFromCommit}
          workspacePath={currentWorkspace.path}
          onClose={() => setCreateTagFromCommit(null)}
          onSuccess={() => setCreateTagFromCommit(null)}
        />
      )}
    </div>
  )
}
