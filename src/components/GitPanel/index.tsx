/**
 * Git 面板主组件
 */

import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, GitPullRequest, X, Check, RotateCcw, MoreHorizontal, GitBranch, FolderGit2, FileText, History, Archive } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { GitStatusHeader } from './GitStatusHeader'
import { FileChangesList } from './FileChangesList'
import { CommitInput } from './CommitInput'
import { QuickActions } from './QuickActions'
import { HistoryTab } from './HistoryTab'
import { StashTab } from './StashTab'
import { DiffViewer } from '@/components/Diff/DiffViewer'
import { Button } from '@/components/Common/Button'
import { DropdownMenu } from '@/components/Common/DropdownMenu'
import { logger } from '@/utils/logger'
import type { GitFileChange, GitDiffEntry } from '@/types'

type TabType = 'changes' | 'history' | 'stash'

interface GitPanelProps {
  width?: number
  className?: string
  onOpenDiffInTab?: (diff: GitDiffEntry) => void
}

export function GitPanel({ width, className = '', onOpenDiffInTab }: GitPanelProps) {
  const { t } = useTranslation('git')
  const { status, isLoading, error, refreshStatus, getWorktreeFileDiff, getIndexFileDiff, stageFile, unstageFile, discardChanges, initRepository } = useGitStore()
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())

  const [activeTab, setActiveTab] = useState<TabType>('changes')
  const [selectedDiff, setSelectedDiff] = useState<GitDiffEntry | null>(null)
  const [isDiffLoading, setIsDiffLoading] = useState(false)

  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set())
  const [isBatchOperating, setIsBatchOperating] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number } | null>(null)
  const [isInitializing, setIsInitializing] = useState(false)
  const [showInitPrompt, setShowInitPrompt] = useState(false)
  const [initBranchName, setInitBranchName] = useState('main')

  const handleFileClick = async (file: GitFileChange, type: 'staged' | 'unstaged') => {
    if (!currentWorkspace) return

    logger.debug('[GitPanel] handleFileClick 被调用:', {
      filePath: file.path,
      type,
      timestamp: new Date().toISOString()
    })

    setIsDiffLoading(true)
    try {
      const diff = type === 'staged'
        ? await getIndexFileDiff(currentWorkspace.path, file.path)
        : await getWorktreeFileDiff(currentWorkspace.path, file.path)

      logger.debug('[GitPanel] 获取到 diff:', {
        filePath: diff.file_path,
        changeType: diff.change_type,
        oldContentLength: diff.old_content?.length ?? 0,
        newContentLength: diff.new_content?.length ?? 0,
        contentOmitted: diff.content_omitted,
        timestamp: new Date().toISOString()
      })

      if (onOpenDiffInTab) {
        onOpenDiffInTab(diff)
      } else {
        setSelectedDiff(diff)
      }
    } catch (err) {
      logger.error('[GitPanel] 获取文件 diff 失败:', err)
    } finally {
      setIsDiffLoading(false)
    }
  }

  const handleUntrackedFileClick = async (filePath: string) => {
    if (!currentWorkspace) return

    setIsDiffLoading(true)
    try {
      const diff = await getWorktreeFileDiff(currentWorkspace.path, filePath)

      if (onOpenDiffInTab) {
        onOpenDiffInTab(diff)
      } else {
        setSelectedDiff(diff)
      }
    } catch (err) {
      console.error('[GitPanel] 获取未跟踪文件 diff 失败:', err)
    } finally {
      setIsDiffLoading(false)
    }
  }

  const handleCloseDiff = () => {
    setSelectedDiff(null)
  }

  const toggleFileSelection = useCallback((path: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const toggleSelectAll = useCallback(() => {
    if (!status) return

    const allPaths = [
      ...status.staged.map(f => f.path),
      ...status.unstaged.map(f => f.path),
      ...status.untracked
    ]

    setSelectedFiles(prev => {
      if (prev.size === allPaths.length && allPaths.length > 0) {
        return new Set()
      } else {
        return new Set(allPaths)
      }
    })
  }, [status])

  const handleBatchStage = useCallback(async () => {
    if (!currentWorkspace || selectedFiles.size === 0) return

    setIsBatchOperating(true)
    try {
      const stageablePaths = Array.from(selectedFiles).filter(path => {
        return status?.unstaged.some(f => f.path === path) ||
               status?.untracked.includes(path)
      })

      setBatchProgress({ current: 0, total: stageablePaths.length })

      for (let i = 0; i < stageablePaths.length; i++) {
        const path = stageablePaths[i]
        await stageFile(currentWorkspace.path, path)
        setBatchProgress({ current: i + 1, total: stageablePaths.length })
      }

      await refreshStatus(currentWorkspace.path)
      setSelectedFiles(new Set())
    } finally {
      setIsBatchOperating(false)
      setBatchProgress(null)
    }
  }, [currentWorkspace, selectedFiles, status, stageFile, refreshStatus])

  const handleBatchUnstage = useCallback(async () => {
    if (!currentWorkspace || selectedFiles.size === 0) return

    setIsBatchOperating(true)
    try {
      const unstageablePaths = Array.from(selectedFiles).filter(path => {
        return status?.staged.some(f => f.path === path)
      })

      setBatchProgress({ current: 0, total: unstageablePaths.length })

      for (let i = 0; i < unstageablePaths.length; i++) {
        const path = unstageablePaths[i]
        await unstageFile(currentWorkspace.path, path)
        setBatchProgress({ current: i + 1, total: unstageablePaths.length })
      }

      await refreshStatus(currentWorkspace.path)
      setSelectedFiles(new Set())
    } finally {
      setIsBatchOperating(false)
      setBatchProgress(null)
    }
  }, [currentWorkspace, selectedFiles, status, unstageFile, refreshStatus])

  const handleBatchDiscard = useCallback(async () => {
    if (!currentWorkspace || selectedFiles.size === 0) return

    const confirmed = window.confirm(t('confirmDiscard', { count: selectedFiles.size }))
    if (!confirmed) return

    setIsBatchOperating(true)
    try {
      const discardablePaths = Array.from(selectedFiles).filter(path => {
        return status?.unstaged.some(f => f.path === path)
      })

      setBatchProgress({ current: 0, total: discardablePaths.length })

      for (let i = 0; i < discardablePaths.length; i++) {
        const path = discardablePaths[i]
        await discardChanges(currentWorkspace.path, path)
        setBatchProgress({ current: i + 1, total: discardablePaths.length })
      }

      await refreshStatus(currentWorkspace.path)
      setSelectedFiles(new Set())
    } finally {
      setIsBatchOperating(false)
      setBatchProgress(null)
    }
  }, [currentWorkspace, selectedFiles, status, discardChanges, refreshStatus])

  const handleInitRepository = useCallback(async () => {
    if (!currentWorkspace) return

    setIsInitializing(true)
    try {
      await initRepository(currentWorkspace.path, initBranchName)
      setShowInitPrompt(false)
      setInitBranchName('main')
    } catch (err) {
      logger.error('[GitPanel] 初始化仓库失败:', err)
    } finally {
      setIsInitializing(false)
    }
  }, [currentWorkspace, initBranchName, initRepository])

  const useInternalDiff = !onOpenDiffInTab

  useEffect(() => {
    if (currentWorkspace) {
      refreshStatus(currentWorkspace.path)
    }
  }, [currentWorkspace?.path])

  const hasChanges =
    status &&
    (status.staged.length > 0 ||
     status.unstaged.length > 0 ||
     status.untracked.length > 0)

  const tabs = [
    { id: 'changes' as const, icon: FileText, label: t('tabs.changes'), count: hasChanges ? (status.staged.length + status.unstaged.length + status.untracked.length) : 0 },
    { id: 'history' as const, icon: History, label: t('tabs.history'), count: 0 },
    { id: 'stash' as const, icon: Archive, label: t('tabs.stash'), count: 0 },
  ]

  if (!status) {
    return (
      <aside
        className={`flex flex-col bg-background-elevated border-l border-border ${className}`}
        style={{ width: width ? `${width}px` : '320px' }}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
          <div className="flex items-center gap-2">
            <GitPullRequest size={16} className="text-primary" />
            <span className="text-sm font-medium text-text-primary">Git</span>
          </div>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center py-12 px-4 gap-4">
          <FolderGit2 size={48} className="text-text-tertiary opacity-50" />
          <div className="text-text-tertiary text-sm text-center">{t('notGitRepo')}</div>
          {error && (
            <div className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg p-3 text-center max-w-full break-all">
              {error}
            </div>
          )}
          {currentWorkspace && (
            <>
              <div className="text-xs text-text-tertiary break-all text-center max-w-full">
                {t('workspacePath')}: {currentWorkspace.path}
              </div>
              
              {!showInitPrompt ? (
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setShowInitPrompt(true)}
                  className="mt-2"
                >
                  <GitBranch size={14} className="mr-1" />
                  {t('init.button')}
                </Button>
              ) : (
                <div className="w-full max-w-[280px] bg-background-surface border border-border rounded-lg p-3 mt-2">
                  <div className="text-xs text-text-secondary mb-2">{t('init.title')}</div>
                  <div className="flex items-center gap-2 mb-3">
                    <input
                      type="text"
                      value={initBranchName}
                      onChange={(e) => setInitBranchName(e.target.value)}
                      placeholder="main"
                      className="flex-1 px-2 py-1 text-sm bg-background border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
                    />
                  </div>
                  <div className="text-xs text-text-tertiary mb-3">{t('init.branchHint')}</div>
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setShowInitPrompt(false)
                        setInitBranchName('main')
                      }}
                      disabled={isInitializing}
                    >
                      {t('init.cancel')}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={handleInitRepository}
                      disabled={isInitializing || !initBranchName.trim()}
                    >
                      {isInitializing ? t('init.initializing') : t('init.confirm')}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    )
  }

  return (
    <aside
      className={`flex flex-col bg-background-elevated border-l border-border ${className}`}
      style={{ width: width ? `${width}px` : '320px' }}
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle shrink-0">
        <div className="flex items-center gap-2">
          <GitPullRequest size={16} className="text-primary" />
          <span className="text-sm font-medium text-text-primary">{t('title')}</span>
        </div>
        {useInternalDiff && selectedDiff && (
          <button
            onClick={handleCloseDiff}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-all"
            title={t('closeDiff')}
          >
            <X size={14} />
          </button>
        )}
        {!(useInternalDiff && selectedDiff) && <ChevronRight size={14} className="text-text-tertiary" />}
      </div>

      {useInternalDiff && selectedDiff && (
        <div className="flex-1 overflow-hidden flex flex-col border-b border-border-subtle">
          {isDiffLoading ? (
            <div className="flex-1 flex items-center justify-center text-text-tertiary text-sm">
              {t('loading')}
            </div>
          ) : (
            <div className="h-full">
              <div className="px-4 py-2 text-xs font-medium text-text-secondary bg-background-surface border-b border-border-subtle">
                {selectedDiff.file_path}
              </div>
              <div className="h-[calc(100%-32px)]">
                <DiffViewer
                  oldContent={selectedDiff.old_content}
                  newContent={selectedDiff.new_content}
                  changeType={selectedDiff.change_type}
                  statusHint={selectedDiff.status_hint}
                  contentOmitted={selectedDiff.content_omitted ?? false}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {!(useInternalDiff && selectedDiff) && (
        <>
          <div className="flex items-center border-b border-border-subtle">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-2 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'text-primary border-b-2 border-primary bg-primary/5'
                    : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
                }`}
              >
                <tab.icon size={12} />
                <span>{tab.label}</span>
                {tab.count > 0 && (
                  <span className="flex items-center justify-center min-w-[16px] h-4 px-1 text-[10px] bg-primary/20 text-primary rounded-full">
                    {tab.count}
                  </span>
                )}
              </button>
            ))}
          </div>

          {activeTab === 'changes' && (
            <>
              <GitStatusHeader
                status={status}
                isLoading={isLoading}
                onRefresh={() => currentWorkspace && refreshStatus(currentWorkspace.path)}
              />

              {selectedFiles.size > 0 && (
                <div className="px-3 py-2 bg-primary/5 border-b border-primary/20 flex items-center justify-between gap-2">
                  <span className="text-xs text-text-secondary flex-1 truncate">
                    {batchProgress
                      ? t('batchProgress', { current: batchProgress.current, total: batchProgress.total })
                      : t('selectedFiles', { count: selectedFiles.size })
                    }
                  </span>

                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={handleBatchStage}
                      disabled={isBatchOperating || isLoading}
                      className="px-2"
                      title={t('stageSelected')}
                    >
                      <Check size={14} />
                    </Button>

                    <DropdownMenu
                      trigger={
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={isBatchOperating || isLoading}
                          className="px-2"
                          title={t('moreActions')}
                        >
                          <MoreHorizontal size={14} />
                        </Button>
                      }
                      align="right"
                      items={[
                        {
                          key: 'unstage',
                          label: t('unstage'),
                          icon: <X size={14} />,
                          onClick: handleBatchUnstage,
                        },
                        {
                          key: 'discard',
                          label: t('discard'),
                          icon: <RotateCcw size={14} />,
                          variant: 'danger',
                          onClick: handleBatchDiscard,
                        },
                      ]}
                    />
                  </div>
                </div>
              )}

              <FileChangesList
                staged={status.staged}
                unstaged={status.unstaged}
                untracked={status.untracked}
                workspacePath={currentWorkspace?.path || ''}
                onFileClick={handleFileClick}
                onUntrackedFileClick={handleUntrackedFileClick}
                selectedFiles={selectedFiles}
                onToggleFileSelection={toggleFileSelection}
                onSelectAll={toggleSelectAll}
                isSelectionDisabled={isBatchOperating}
              />

              {error && (
                <div className="px-4 py-2 mx-4 mb-2 text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg">
                  {error}
                </div>
              )}

              {hasChanges && <CommitInput selectedFiles={selectedFiles} />}
              <QuickActions hasChanges={hasChanges ?? false} />
            </>
          )}

          {activeTab === 'history' && <HistoryTab />}
          {activeTab === 'stash' && <StashTab />}
        </>
      )}
    </aside>
  )
}
