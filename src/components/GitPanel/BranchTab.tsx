/**
 * 分支列表组件
 *
 * 显示本地和远程分支，支持分支切换和创建
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  GitBranch as GitBranchIcon,
  Check,
  RefreshCw,
  Loader2,
  GitCommit,
  Globe,
  FolderGit2,
  Plus,
  Edit2,
  GitMerge,
  GitCompare,
  Trash2,
  ChevronRight,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { formatGitTimestamp } from '@/utils/gitFormat'
import type { GitBranch, GitMergeResult, GitRebaseResult } from '@/types/git'
import {
  SwitchConfirmDialog,
  CreateBranchDialog,
  DeleteBranchDialog,
  RenameBranchDialog,
  MergeBranchDialog,
  RebaseBranchDialog,
} from './BranchDialogs'
import { validateBranchName, getChangesCount } from './branchTabUtils'

type SwitchState =
  | { type: 'idle' }
  | { type: 'confirming'; targetBranch: string; hasChanges: boolean }

export function BranchTab() {
  const { t } = useTranslation('git')
  const [branches, setBranches] = useState<GitBranch[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSwitching, setIsSwitching] = useState(false)
  const [switchState, setSwitchState] = useState<SwitchState>({ type: 'idle' })
  const [error, setError] = useState<string | null>(null)

  // 创建分支状态
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  const status = useGitStore((s) => s.status)
  const getBranches = useGitStore((s) => s.getBranches)
  const checkoutBranch = useGitStore((s) => s.checkoutBranch)
  const createBranch = useGitStore((s) => s.createBranch)
  const deleteBranch = useGitStore((s) => s.deleteBranch)
  const renameBranch = useGitStore((s) => s.renameBranch)
  const mergeBranch = useGitStore((s) => s.mergeBranch)
  const rebaseBranch = useGitStore((s) => s.rebaseBranch)
  const rebaseAbort = useGitStore((s) => s.rebaseAbort)
  const rebaseContinue = useGitStore((s) => s.rebaseContinue)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const stashSave = useGitStore((s) => s.stashSave)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })
  const toast = useToastStore()

  const loadBranches = useCallback(async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    setError(null)
    try {
      await getBranches(currentWorkspace.path)
      const storeBranches = useGitStore.getState().branches
      setBranches(storeBranches)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.getBranchesFailed'), errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, getBranches, t, toast])

  useEffect(() => {
    loadBranches()
  }, [loadBranches])

  const hasUncommittedChanges = useCallback(() => {
    if (!status) return false
    return (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0
    )
  }, [status])

  const doSwitchBranch = useCallback(
    async (branchName: string) => {
      if (!currentWorkspace) return

      setIsSwitching(true)
      setError(null)
      try {
        await checkoutBranch(currentWorkspace.path, branchName)
        await refreshStatus(currentWorkspace.path)
        await loadBranches()
        setSwitchState({ type: 'idle' })
        toast.success(t('branch.switchSuccess', { branch: branchName }))
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err)
        setError(errorMsg)
        toast.error(t('errors.switchBranchFailed'), errorMsg)
      } finally {
        setIsSwitching(false)
      }
    },
    [currentWorkspace, checkoutBranch, refreshStatus, loadBranches, t, toast]
  )

  const handleSwitchBranch = useCallback(
    async (branchName: string) => {
      if (!currentWorkspace || branchName === status?.branch) return

      if (hasUncommittedChanges()) {
        setSwitchState({
          type: 'confirming',
          targetBranch: branchName,
          hasChanges: true,
        })
      } else {
        await doSwitchBranch(branchName)
      }
    },
    [currentWorkspace, status?.branch, hasUncommittedChanges, doSwitchBranch]
  )

  const handleStashAndSwitch = useCallback(async () => {
    if (!currentWorkspace || switchState.type !== 'confirming') return

    const targetBranch = switchState.targetBranch
    setIsSwitching(true)
    try {
      await stashSave(currentWorkspace.path, `WIP: switching to ${targetBranch}`, true)
      await doSwitchBranch(targetBranch)
    } catch {
      // doSwitchBranch 已处理错误
    } finally {
      setIsSwitching(false)
    }
  }, [currentWorkspace, switchState, stashSave, doSwitchBranch])

  const handleForceSwitch = useCallback(async () => {
    if (switchState.type !== 'confirming') return
    await doSwitchBranch(switchState.targetBranch)
  }, [switchState, doSwitchBranch])

  const handleCancelSwitch = useCallback(() => {
    setSwitchState({ type: 'idle' })
    setError(null)
  }, [])

  const handleCreateBranch = useCallback(async (name: string, checkout: boolean) => {
    if (!currentWorkspace || !name.trim()) return

    const branchName = name.trim()
    const validation = validateBranchName(branchName)
    if (validation === 'invalid') {
      toast.error(t('errors.createBranchFailed'), t('branch.invalidName'))
      return
    }
    if (branches.some(b => b.name === branchName)) {
      toast.error(t('errors.createBranchFailed'), t('branch.alreadyExists'))
      return
    }

    setIsCreating(true)
    setError(null)
    try {
      await createBranch(currentWorkspace.path, branchName, checkout)
      await loadBranches()
      await refreshStatus(currentWorkspace.path)
      setShowCreateDialog(false)
      toast.success(t('branch.createSuccess', { branch: branchName }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.createBranchFailed'), errorMsg)
    } finally {
      setIsCreating(false)
    }
  }, [currentWorkspace, branches, createBranch, loadBranches, refreshStatus, t, toast])

  // 删除分支状态
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [branchToDelete, setBranchToDelete] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [forceDelete, setForceDelete] = useState(false)

  const handleDeleteBranch = useCallback(async () => {
    if (!currentWorkspace || !branchToDelete) return

    setIsDeleting(true)
    setError(null)
    try {
      await deleteBranch(currentWorkspace.path, branchToDelete, forceDelete)
      await loadBranches()
      setShowDeleteDialog(false)
      setBranchToDelete(null)
      setForceDelete(false)
      toast.success(t('branch.deleteSuccess', { branch: branchToDelete }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      if (errorMsg.includes('not fully merged')) {
        setForceDelete(true)
        toast.error(t('errors.deleteBranchFailed'), t('branch.notMerged'))
      } else {
        setError(errorMsg)
        toast.error(t('errors.deleteBranchFailed'), errorMsg)
      }
    } finally {
      setIsDeleting(false)
    }
  }, [currentWorkspace, branchToDelete, forceDelete, deleteBranch, loadBranches, t, toast])

  const openDeleteDialog = useCallback((branchName: string) => {
    setBranchToDelete(branchName)
    setForceDelete(false)
    setShowDeleteDialog(true)
  }, [])

  // 重命名分支状态
  const [showRenameDialog, setShowRenameDialog] = useState(false)
  const [branchToRename, setBranchToRename] = useState<string | null>(null)
  const [isRenaming, setIsRenaming] = useState(false)

  const handleRenameBranch = useCallback(async (newName: string) => {
    if (!currentWorkspace || !branchToRename || !newName.trim()) return

    const branchName = newName.trim()
    const validation = validateBranchName(branchName, true)
    if (validation === 'invalid') {
      toast.error(t('errors.renameBranchFailed'), t('branch.invalidName'))
      return
    }
    if (branchName === branchToRename) {
      toast.error(t('errors.renameBranchFailed'), t('branch.sameName'))
      return
    }
    if (branches.some(b => b.name === branchName)) {
      toast.error(t('errors.renameBranchFailed'), t('branch.alreadyExists'))
      return
    }

    setIsRenaming(true)
    setError(null)
    try {
      await renameBranch(currentWorkspace.path, branchToRename, branchName)
      await loadBranches()
      await refreshStatus(currentWorkspace.path)
      setShowRenameDialog(false)
      setBranchToRename(null)
      toast.success(t('branch.renameSuccess', { oldBranch: branchToRename, newBranch: branchName }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.renameBranchFailed'), errorMsg)
    } finally {
      setIsRenaming(false)
    }
  }, [currentWorkspace, branchToRename, branches, renameBranch, loadBranches, refreshStatus, t, toast])

  const openRenameDialog = useCallback((branchName: string) => {
    setBranchToRename(branchName)
    setShowRenameDialog(true)
  }, [])

  // 合并分支状态
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [branchToMerge, setBranchToMerge] = useState<string | null>(null)
  const [isMerging, setIsMerging] = useState(false)
  const [mergeResult, setMergeResult] = useState<GitMergeResult | null>(null)

  const handleMergeBranch = useCallback(async (noFF: boolean) => {
    if (!currentWorkspace || !branchToMerge) return

    setIsMerging(true)
    setError(null)
    setMergeResult(null)
    try {
      const result = await mergeBranch(currentWorkspace.path, branchToMerge, noFF)
      setMergeResult(result)

      if (result.success) {
        await loadBranches()
        toast.success(
          t('branch.mergeSuccess', { source: branchToMerge, target: status?.branch || 'current' }),
          result.fastForward
            ? t('branch.mergeFastForward')
            : t('branch.mergeCommits', { count: result.mergedCommits })
        )
        if (!result.hasConflicts) {
          setShowMergeDialog(false)
          setBranchToMerge(null)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.mergeBranchFailed'), errorMsg)
    } finally {
      setIsMerging(false)
    }
  }, [currentWorkspace, branchToMerge, mergeBranch, loadBranches, t, toast, status?.branch])

  const openMergeDialog = useCallback((branchName: string) => {
    setBranchToMerge(branchName)
    setMergeResult(null)
    setShowMergeDialog(true)
  }, [])

  // 变基分支状态
  const [showRebaseDialog, setShowRebaseDialog] = useState(false)
  const [branchToRebase, setBranchToRebase] = useState<string | null>(null)
  const [isRebasing, setIsRebasing] = useState(false)
  const [rebaseResult, setRebaseResult] = useState<GitRebaseResult | null>(null)

  const handleRebaseBranch = useCallback(async () => {
    if (!currentWorkspace || !branchToRebase) return

    setIsRebasing(true)
    setError(null)
    setRebaseResult(null)
    try {
      const result = await rebaseBranch(currentWorkspace.path, branchToRebase)
      setRebaseResult(result)

      if (result.success) {
        await loadBranches()
        toast.success(
          t('branch.rebaseSuccess', { source: branchToRebase }),
          t('branch.rebaseCommits', { count: result.rebasedCommits })
        )
        if (!result.hasConflicts) {
          setShowRebaseDialog(false)
          setBranchToRebase(null)
        }
      } else if (result.hasConflicts) {
        toast.warning(
          t('branch.rebaseConflicts'),
          t('branch.rebaseConflictsDesc', { count: result.conflicts.length })
        )
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.rebaseBranchFailed'), errorMsg)
    } finally {
      setIsRebasing(false)
    }
  }, [currentWorkspace, branchToRebase, rebaseBranch, loadBranches, t, toast])

  const handleRebaseAbort = useCallback(async () => {
    if (!currentWorkspace) return

    setIsRebasing(true)
    try {
      await rebaseAbort(currentWorkspace.path)
      await loadBranches()
      setShowRebaseDialog(false)
      setBranchToRebase(null)
      setRebaseResult(null)
      toast.info(t('branch.rebaseAborted'))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.rebaseAbortFailed'), errorMsg)
    } finally {
      setIsRebasing(false)
    }
  }, [currentWorkspace, rebaseAbort, loadBranches, t, toast])

  const handleRebaseContinue = useCallback(async () => {
    if (!currentWorkspace) return

    setIsRebasing(true)
    try {
      const result = await rebaseContinue(currentWorkspace.path)
      setRebaseResult(result)

      if (result.success) {
        await loadBranches()
        toast.success(t('branch.rebaseSuccess', { source: branchToRebase || 'branch' }))
        setShowRebaseDialog(false)
        setBranchToRebase(null)
        setRebaseResult(null)
      } else if (result.hasConflicts) {
        toast.warning(
          t('branch.rebaseConflicts'),
          t('branch.rebaseConflictsDesc', { count: result.conflicts.length })
        )
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.rebaseContinueFailed'), errorMsg)
    } finally {
      setIsRebasing(false)
    }
  }, [currentWorkspace, rebaseContinue, loadBranches, t, toast, branchToRebase])

  const openRebaseDialog = useCallback((branchName: string) => {
    setBranchToRebase(branchName)
    setRebaseResult(null)
    setShowRebaseDialog(true)
  }, [])

  const localBranches = useMemo(() =>
    branches.filter((b) => !b.isRemote),
    [branches]
  )

  const remoteBranches = useMemo(() =>
    branches.filter((b) => b.isRemote),
    [branches]
  )

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return ''
    return formatGitTimestamp(timestamp, t)
  }

  const renderBranchItem = (branch: GitBranch, isRemote = false) => {
    const isCurrent = branch.isCurrent
    return (
      <div
        key={branch.name}
        className={`w-full px-4 py-3 flex items-start gap-3 hover:bg-background-hover transition-colors border-b border-border-subtle group ${
          isCurrent ? 'bg-primary/5' : ''
        } ${isRemote ? 'opacity-70' : ''}`}
      >
        <div
          className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${
            isCurrent ? 'bg-primary/20' : isRemote ? 'bg-info/10' : 'bg-background-surface'
          }`}
        >
          {isCurrent ? (
            <Check size={12} className="text-primary" />
          ) : isRemote ? (
            <Globe size={12} className="text-info" />
          ) : (
            <GitBranchIcon size={12} className="text-text-tertiary" />
          )}
        </div>
        <div className="flex-1 min-w-0 cursor-pointer" onClick={() => !isRemote && handleSwitchBranch(branch.name)}>
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-sm font-medium truncate ${
                isCurrent ? 'text-primary' : 'text-text-primary'
              }`}
            >
              {branch.name}
            </span>
            {isCurrent && (
              <span className="text-[10px] px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                {t('branch.current')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-tertiary">
            {branch.commit && (
              <span className="flex items-center gap-1">
                <GitCommit size={10} />
                <span className="font-mono">{branch.commit.slice(0, 7)}</span>
              </span>
            )}
            {branch.lastCommitDate && (
              <span>{formatTime(branch.lastCommitDate)}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {!isRemote && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                openRenameDialog(branch.name)
              }}
              disabled={isSwitching || isRenaming}
              className="p-1 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
              title={t('branch.rename')}
            >
              <Edit2 size={14} />
            </button>
          )}
          {!isRemote && !isCurrent && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                openMergeDialog(branch.name)
              }}
              disabled={isSwitching || isMerging}
              className="p-1 text-text-tertiary hover:text-success hover:bg-success/10 rounded transition-colors disabled:opacity-50"
              title={t('branch.merge')}
            >
              <GitMerge size={14} />
            </button>
          )}
          {!isRemote && !isCurrent && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                openRebaseDialog(branch.name)
              }}
              disabled={isSwitching || isRebasing}
              className="p-1 text-text-tertiary hover:text-info hover:bg-info/10 rounded transition-colors disabled:opacity-50"
              title={t('branch.rebase')}
            >
              <GitCompare size={14} />
            </button>
          )}
          {!isRemote && !isCurrent && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                openDeleteDialog(branch.name)
              }}
              disabled={isSwitching || isDeleting}
              className="p-1 text-text-tertiary hover:text-danger hover:bg-danger/10 rounded transition-colors disabled:opacity-50"
              title={t('branch.delete')}
            >
              <Trash2 size={14} />
            </button>
          )}
          {!isRemote && (
            <ChevronRight
              size={14}
              className={`flex-shrink-0 mt-1 ${
                isCurrent ? 'text-primary/50' : 'text-text-tertiary'
              }`}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between shrink-0">
        <span className="text-sm font-medium text-text-primary">
          {t('branch.title')}
          {localBranches.length > 0 && (
            <span className="ml-2 text-xs text-text-tertiary">
              ({localBranches.length})
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowCreateDialog(true)}
            disabled={isLoading || isSwitching}
            className="p-1 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
            title={t('branch.create')}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={loadBranches}
            disabled={isLoading}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
            title={t('refresh', { ns: 'common' })}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && branches.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : branches.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <FolderGit2 size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('branch.empty')}</span>
          </div>
        ) : (
          <>
            <div className="px-4 py-1.5 text-xs font-medium text-text-tertiary bg-background-surface border-b border-border-subtle sticky top-0">
              {t('branch.local')} ({localBranches.length})
            </div>
            {localBranches.map((branch) => renderBranchItem(branch, false))}

            {remoteBranches.length > 0 && (
              <>
                <div className="px-4 py-1.5 text-xs font-medium text-text-tertiary bg-background-surface border-b border-border-subtle sticky top-0 mt-1">
                  {t('branch.remote')} ({remoteBranches.length})
                </div>
                {remoteBranches.map((branch) => renderBranchItem(branch, true))}
              </>
            )}
          </>
        )}
      </div>

      {switchState.type === 'confirming' && (
        <SwitchConfirmDialog
          changesCount={status ? getChangesCount(status.staged, status.unstaged, status.untracked) : 0}
          isSwitching={isSwitching}
          onStashAndSwitch={handleStashAndSwitch}
          onForceSwitch={handleForceSwitch}
          onCancel={handleCancelSwitch}
        />
      )}

      {showCreateDialog && (
        <CreateBranchDialog
          currentBranch={status?.branch || 'HEAD'}
          isCreating={isCreating}
          onConfirm={handleCreateBranch}
          onClose={() => setShowCreateDialog(false)}
        />
      )}

      {showDeleteDialog && branchToDelete && (
        <DeleteBranchDialog
          branchName={branchToDelete}
          isDeleting={isDeleting}
          forceDelete={forceDelete}
          onConfirm={handleDeleteBranch}
          onClose={() => {
            setShowDeleteDialog(false)
            setBranchToDelete(null)
            setForceDelete(false)
          }}
        />
      )}

      {showRenameDialog && branchToRename && (
        <RenameBranchDialog
          branchName={branchToRename}
          isRenaming={isRenaming}
          onConfirm={handleRenameBranch}
          onClose={() => {
            setShowRenameDialog(false)
            setBranchToRename(null)
          }}
        />
      )}

      {showMergeDialog && branchToMerge && (
        <MergeBranchDialog
          sourceBranch={branchToMerge}
          currentBranch={status?.branch || 'current'}
          isMerging={isMerging}
          mergeResult={mergeResult}
          onConfirm={handleMergeBranch}
          onClose={() => {
            setShowMergeDialog(false)
            setBranchToMerge(null)
            setMergeResult(null)
          }}
        />
      )}

      {showRebaseDialog && branchToRebase && (
        <RebaseBranchDialog
          sourceBranch={branchToRebase}
          currentBranch={status?.branch || 'current'}
          isRebasing={isRebasing}
          rebaseResult={rebaseResult}
          onConfirm={handleRebaseBranch}
          onAbort={handleRebaseAbort}
          onContinue={handleRebaseContinue}
          onClose={() => {
            setShowRebaseDialog(false)
            setBranchToRebase(null)
            setRebaseResult(null)
          }}
        />
      )}
    </div>
  )
}
