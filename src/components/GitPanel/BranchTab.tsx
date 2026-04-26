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
  AlertTriangle,
  Archive,
  Plus,
  X,
  Trash2,
  Edit2,
  GitMerge,
  AlertCircle,
  GitCompare,
  Square,
  Play,
  ChevronRight,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import { formatGitTimestamp } from '@/utils/gitFormat'
import type { GitBranch, GitMergeResult, GitRebaseResult } from '@/types/git'

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
  const [newBranchName, setNewBranchName] = useState('')
  const [checkoutNewBranch, setCheckoutNewBranch] = useState(true)
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
      // 从 store 获取更新后的 branches
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
      // 忽略错误，doSwitchBranch 已经处理
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

  const handleCreateBranch = useCallback(async () => {
    if (!currentWorkspace || !newBranchName.trim()) return

    // 验证分支名称（简单验证）
    const branchName = newBranchName.trim()
    const invalidChars = /[\s~:?*[\\]/
    if (invalidChars.test(branchName)) {
      toast.error(t('errors.createBranchFailed'), t('branch.invalidName'))
      return
    }

    // 检查分支是否已存在
    if (branches.some(b => b.name === branchName)) {
      toast.error(t('errors.createBranchFailed'), t('branch.alreadyExists'))
      return
    }

    setIsCreating(true)
    setError(null)
    try {
      await createBranch(currentWorkspace.path, branchName, checkoutNewBranch)
      await loadBranches()
      await refreshStatus(currentWorkspace.path)
      setShowCreateDialog(false)
      setNewBranchName('')
      setCheckoutNewBranch(true)
      toast.success(t('branch.createSuccess', { branch: branchName }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.createBranchFailed'), errorMsg)
    } finally {
      setIsCreating(false)
    }
  }, [currentWorkspace, newBranchName, checkoutNewBranch, branches, createBranch, loadBranches, refreshStatus, t, toast])

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
      // 如果是未合并分支错误，显示强制删除选项
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
  const [renamedBranchName, setRenamedBranchName] = useState('')
  const [isRenaming, setIsRenaming] = useState(false)

  const handleRenameBranch = useCallback(async () => {
    if (!currentWorkspace || !branchToRename || !renamedBranchName.trim()) return

    // 验证分支名称
    const branchName = renamedBranchName.trim()
    const invalidChars = /[\s~^:?*[\\]/
    if (invalidChars.test(branchName)) {
      toast.error(t('errors.renameBranchFailed'), t('branch.invalidName'))
      return
    }

    // 检查新名称是否与旧名称相同
    if (branchName === branchToRename) {
      toast.error(t('errors.renameBranchFailed'), t('branch.sameName'))
      return
    }

    // 检查新名称是否已存在
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
      setRenamedBranchName('')
      toast.success(t('branch.renameSuccess', { oldBranch: branchToRename, newBranch: branchName }))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.renameBranchFailed'), errorMsg)
    } finally {
      setIsRenaming(false)
    }
  }, [currentWorkspace, branchToRename, renamedBranchName, branches, renameBranch, loadBranches, refreshStatus, t, toast])

  const openRenameDialog = useCallback((branchName: string) => {
    setBranchToRename(branchName)
    setRenamedBranchName(branchName)
    setShowRenameDialog(true)
  }, [])

  // 合并分支状态
  const [showMergeDialog, setShowMergeDialog] = useState(false)
  const [branchToMerge, setBranchToMerge] = useState<string | null>(null)
  const [isMerging, setIsMerging] = useState(false)
  const [noFF, setNoFF] = useState(false)
  const [mergeResult, setMergeResult] = useState<GitMergeResult | null>(null)

  const handleMergeBranch = useCallback(async () => {
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
        // 成功后关闭弹窗
        if (!result.hasConflicts) {
          setShowMergeDialog(false)
          setBranchToMerge(null)
          setNoFF(false)
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.mergeBranchFailed'), errorMsg)
    } finally {
      setIsMerging(false)
    }
  }, [currentWorkspace, branchToMerge, noFF, mergeBranch, loadBranches, t, toast, status?.branch])

  const openMergeDialog = useCallback((branchName: string) => {
    setBranchToMerge(branchName)
    setNoFF(false)
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
        // 成功后关闭弹窗
        if (!result.hasConflicts) {
          setShowRebaseDialog(false)
          setBranchToRebase(null)
        }
      } else if (result.hasConflicts) {
        // 冲突时保持弹窗打开
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

  // 优化：使用 useMemo 避免每次渲染都重新计算分支列表
  const localBranches = useMemo(() =>
    branches.filter((b) => !b.isRemote),
    [branches]
  )

  const remoteBranches = useMemo(() =>
    branches.filter((b) => b.isRemote),
    [branches]
  )

  const getChangesCount = () => {
    if (!status) return 0
    return status.staged.length + status.unstaged.length + status.untracked.length
  }

  // 使用共享的时间格式化函数
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
            {/* 本地分支 */}
            <div className="px-4 py-1.5 text-xs font-medium text-text-tertiary bg-background-surface border-b border-border-subtle sticky top-0">
              {t('branch.local')} ({localBranches.length})
            </div>
            {localBranches.map((branch) => renderBranchItem(branch, false))}

            {/* 远程分支 */}
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

      {/* 切换分支确认弹窗 */}
      {switchState.type === 'confirming' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">
                  {t('branch.uncommittedChanges')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {t('branch.uncommittedChangesDesc', { count: getChangesCount() })}
                </p>
              </div>
            </div>

            <div className="space-y-2 mb-6">
              <button
                onClick={handleStashAndSwitch}
                disabled={isSwitching}
                className="w-full px-4 py-3 text-left text-sm bg-background-surface hover:bg-background-hover border border-border rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <Archive size={16} className="text-primary" />
                <div>
                  <div className="font-medium text-text-primary">
                    {t('branch.stashAndSwitch')}
                  </div>
                  <div className="text-xs text-text-tertiary">
                    {t('branch.stashAndSwitchDesc')}
                  </div>
                </div>
              </button>

              <button
                onClick={handleForceSwitch}
                disabled={isSwitching}
                className="w-full px-4 py-3 text-left text-sm bg-danger/10 hover:bg-danger/20 border border-danger/30 rounded-lg transition-colors flex items-center gap-3 disabled:opacity-50"
              >
                <AlertTriangle size={16} className="text-danger" />
                <div>
                  <div className="font-medium text-danger">{t('branch.forceSwitch')}</div>
                  <div className="text-xs text-danger/70">{t('branch.forceSwitchDesc')}</div>
                </div>
              </button>
            </div>

            <div className="flex justify-end">
              <button
                onClick={handleCancelSwitch}
                disabled={isSwitching}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
            </div>

            {isSwitching && (
              <div className="absolute inset-0 bg-background-elevated/80 flex items-center justify-center rounded-xl">
                <Loader2 size={24} className="animate-spin text-primary" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* 创建分支弹窗 */}
      {showCreateDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">
                {t('branch.create')}
              </h2>
              <button
                onClick={() => {
                  setShowCreateDialog(false)
                  setNewBranchName('')
                  setCheckoutNewBranch(true)
                }}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-text-secondary mb-1.5">
                  {t('branch.nameLabel')}
                </label>
                <input
                  type="text"
                  value={newBranchName}
                  onChange={(e) => setNewBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleCreateBranch()
                    }
                  }}
                  placeholder={t('branch.newBranchPlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  autoFocus
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checkoutNewBranch}
                  onChange={(e) => setCheckoutNewBranch(e.target.checked)}
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
                />
                <span className="text-sm text-text-secondary">
                  {t('branch.checkoutAfterCreate')}
                </span>
              </label>

              <div className="text-xs text-text-tertiary">
                {t('branch.createFrom', { branch: status?.branch || 'HEAD' })}
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowCreateDialog(false)
                  setNewBranchName('')
                  setCheckoutNewBranch(true)
                }}
                disabled={isCreating}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleCreateBranch}
                disabled={isCreating || !newBranchName.trim()}
                className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isCreating && <Loader2 size={14} className="animate-spin" />}
                {t('branch.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除分支确认弹窗 */}
      {showDeleteDialog && branchToDelete && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">
                  {t('branch.delete')}
                </h2>
                <p className="text-sm text-text-secondary">
                  {t('branch.deleteConfirm', { branch: branchToDelete })}
                </p>
              </div>
            </div>

            {forceDelete && (
              <div className="mb-4 px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
                <p className="text-sm text-warning">
                  {t('branch.notMergedWarning')}
                </p>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowDeleteDialog(false)
                  setBranchToDelete(null)
                  setForceDelete(false)
                }}
                disabled={isDeleting}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleDeleteBranch}
                disabled={isDeleting}
                className="px-4 py-2 text-sm bg-danger text-white rounded-lg hover:bg-danger/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isDeleting && <Loader2 size={14} className="animate-spin" />}
                {forceDelete ? t('branch.forceDelete') : t('branch.delete')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 重命名分支弹窗 */}
      {showRenameDialog && branchToRename && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">
                {t('branch.rename')}
              </h2>
              <button
                onClick={() => {
                  setShowRenameDialog(false)
                  setBranchToRename(null)
                  setRenamedBranchName('')
                }}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-sm text-text-secondary mb-1.5">
                  {t('branch.currentName')}
                </label>
                <div className="px-3 py-2 text-sm bg-background-surface border border-border rounded-lg text-text-tertiary">
                  {branchToRename}
                </div>
              </div>

              <div>
                <label className="block text-sm text-text-secondary mb-1.5">
                  {t('branch.newNameLabel')}
                </label>
                <input
                  type="text"
                  value={renamedBranchName}
                  onChange={(e) => setRenamedBranchName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleRenameBranch()
                    }
                  }}
                  placeholder={t('branch.newNamePlaceholder')}
                  className="w-full px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  autoFocus
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowRenameDialog(false)
                  setBranchToRename(null)
                  setRenamedBranchName('')
                }}
                disabled={isRenaming}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleRenameBranch}
                disabled={isRenaming || !renamedBranchName.trim() || renamedBranchName === branchToRename}
                className="px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isRenaming && <Loader2 size={14} className="animate-spin" />}
                {t('branch.rename')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 合并分支弹窗 */}
      {showMergeDialog && branchToMerge && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">
                {t('branch.merge')}
              </h2>
              <button
                onClick={() => {
                  if (!isMerging) {
                    setShowMergeDialog(false)
                    setBranchToMerge(null)
                    setNoFF(false)
                    setMergeResult(null)
                  }
                }}
                disabled={isMerging}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="px-4 py-3 bg-background-surface border border-border rounded-lg">
                <div className="text-sm text-text-secondary mb-1">{t('branch.mergeSource')}</div>
                <div className="flex items-center gap-2">
                  <GitBranchIcon size={14} className="text-success" />
                  <span className="text-sm font-medium text-text-primary">{branchToMerge}</span>
                </div>
              </div>

              <div className="flex items-center justify-center text-text-tertiary">
                <span className="text-2xl">↓</span>
              </div>

              <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-lg">
                <div className="text-sm text-text-secondary mb-1">{t('branch.mergeTarget')}</div>
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-primary" />
                  <span className="text-sm font-medium text-text-primary">{status?.branch || 'current'}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                    {t('branch.current')}
                  </span>
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={noFF}
                  onChange={(e) => setNoFF(e.target.checked)}
                  disabled={isMerging}
                  className="w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
                />
                <div>
                  <span className="text-sm text-text-secondary">
                    {t('branch.mergeNoFF')}
                  </span>
                  <span className="text-xs text-text-tertiary block">
                    {t('branch.mergeNoFFDesc')}
                  </span>
                </div>
              </label>

              {/* 合并结果 - 冲突 */}
              {mergeResult?.hasConflicts && (
                <div className="px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-warning">
                        {t('branch.mergeConflicts')}
                      </div>
                      <div className="text-xs text-warning/70 mt-1">
                        {t('branch.mergeConflictsDesc', { count: mergeResult.conflicts.length })}
                      </div>
                      <div className="mt-2 max-h-24 overflow-y-auto">
                        {mergeResult.conflicts.map((file, idx) => (
                          <div key={idx} className="text-xs text-text-tertiary font-mono">
                            {file}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  if (!isMerging) {
                    setShowMergeDialog(false)
                    setBranchToMerge(null)
                    setNoFF(false)
                    setMergeResult(null)
                  }
                }}
                disabled={isMerging}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleMergeBranch}
                disabled={isMerging}
                className="px-4 py-2 text-sm bg-success text-white rounded-lg hover:bg-success/90 transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                {isMerging && <Loader2 size={14} className="animate-spin" />}
                <GitMerge size={14} />
                {t('branch.merge')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 变基分支弹窗 */}
      {showRebaseDialog && branchToRebase && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-text-primary">
                {t('branch.rebase')}
              </h2>
              <button
                onClick={() => {
                  if (!isRebasing) {
                    setShowRebaseDialog(false)
                    setBranchToRebase(null)
                    setRebaseResult(null)
                  }
                }}
                disabled={isRebasing}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
              >
                <X size={16} />
              </button>
            </div>

            <div className="space-y-4">
              <div className="px-4 py-3 bg-primary/5 border border-primary/20 rounded-lg">
                <div className="text-sm text-text-secondary mb-1">{t('branch.rebaseCurrentBranch')}</div>
                <div className="flex items-center gap-2">
                  <Check size={14} className="text-primary" />
                  <span className="text-sm font-medium text-text-primary">{status?.branch || 'current'}</span>
                  <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                    {t('branch.current')}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-center text-text-tertiary">
                <span className="text-2xl">↓</span>
              </div>

              <div className="px-4 py-3 bg-background-surface border border-border rounded-lg">
                <div className="text-sm text-text-secondary mb-1">{t('branch.rebaseOnto')}</div>
                <div className="flex items-center gap-2">
                  <GitBranchIcon size={14} className="text-info" />
                  <span className="text-sm font-medium text-text-primary">{branchToRebase}</span>
                </div>
              </div>

              {/* 变基结果 - 冲突 */}
              {rebaseResult?.hasConflicts && (
                <div className="px-3 py-2 bg-warning/10 border border-warning/30 rounded-lg">
                  <div className="flex items-start gap-2">
                    <AlertCircle size={16} className="text-warning shrink-0 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-warning">
                        {t('branch.rebaseConflicts')}
                      </div>
                      <div className="text-xs text-warning/70 mt-1">
                        {t('branch.rebaseConflictsDesc', { count: rebaseResult.conflicts.length })}
                      </div>
                      <div className="mt-2 max-h-24 overflow-y-auto">
                        {rebaseResult.conflicts.map((file, idx) => (
                          <div key={idx} className="text-xs text-text-tertiary font-mono">
                            {file}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* 变基进度 */}
              {rebaseResult && !rebaseResult.finished && !rebaseResult.hasConflicts && (
                <div className="px-3 py-2 bg-info/10 border border-info/30 rounded-lg">
                  <div className="flex items-center gap-2">
                    <Loader2 size={14} className="animate-spin text-info" />
                    <span className="text-sm text-info">
                      {t('branch.rebaseProgress', { current: rebaseResult.currentStep, total: rebaseResult.totalSteps })}
                    </span>
                  </div>
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-6">
              {rebaseResult?.hasConflicts ? (
                <>
                  <button
                    onClick={handleRebaseAbort}
                    disabled={isRebasing}
                    className="px-4 py-2 text-sm text-danger hover:bg-danger/10 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    <Square size={14} />
                    {t('branch.rebaseAbort')}
                  </button>
                  <button
                    onClick={handleRebaseContinue}
                    disabled={isRebasing}
                    className="px-4 py-2 text-sm bg-info text-white rounded-lg hover:bg-info/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {isRebasing && <Loader2 size={14} className="animate-spin" />}
                    <Play size={14} />
                    {t('branch.rebaseContinue')}
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => {
                      if (!isRebasing) {
                        setShowRebaseDialog(false)
                        setBranchToRebase(null)
                        setRebaseResult(null)
                      }
                    }}
                    disabled={isRebasing}
                    className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
                  >
                    {t('cancel', { ns: 'common' })}
                  </button>
                  <button
                    onClick={handleRebaseBranch}
                    disabled={isRebasing}
                    className="px-4 py-2 text-sm bg-info text-white rounded-lg hover:bg-info/90 transition-colors disabled:opacity-50 flex items-center gap-2"
                  >
                    {isRebasing && <Loader2 size={14} className="animate-spin" />}
                    <GitCompare size={14} />
                    {t('branch.rebase')}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}