/**
 * 分支列表组件
 *
 * 显示本地和远程分支，支持分支切换和创建
 */

import { useState, useEffect, useCallback } from 'react'
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
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitBranch } from '@/types/git'

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
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const stashSave = useGitStore((s) => s.stashSave)
  const currentWorkspace = useWorkspaceStore((s) => s.getCurrentWorkspace())
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
  }, [currentWorkspace, getBranches, toast])

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
    [currentWorkspace, checkoutBranch, refreshStatus, loadBranches, toast]
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
    } catch (err) {
      console.error('Failed to stash and switch:', err)
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
    const invalidChars = /[\s~^:?*\[\\]/
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
  }, [currentWorkspace, newBranchName, checkoutNewBranch, branches, createBranch, loadBranches, refreshStatus, toast])

  const localBranches = branches.filter((b) => !b.isRemote)
  const remoteBranches = branches.filter((b) => b.isRemote)

  const getChangesCount = () => {
    if (!status) return 0
    return status.staged.length + status.unstaged.length + status.untracked.length
  }

  const formatTime = (timestamp?: number) => {
    if (!timestamp) return ''
    const date = new Date(timestamp * 1000)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / 86400000)
    if (diffDays < 7) {
      return t('history.daysAgo', { count: diffDays })
    }
    return date.toLocaleDateString()
  }

  const renderBranchItem = (branch: GitBranch, isRemote = false) => {
    const isCurrent = branch.isCurrent
    return (
      <button
        key={branch.name}
        onClick={() => !isRemote && handleSwitchBranch(branch.name)}
        disabled={isSwitching || isCurrent || isRemote}
        className={`w-full px-4 py-3 text-left flex items-start gap-3 hover:bg-background-hover transition-colors border-b border-border-subtle ${
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
        <div className="flex-1 min-w-0">
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
        {!isRemote && (
          <ChevronRightIcon
            size={14}
            className={`flex-shrink-0 mt-1 ${
              isCurrent ? 'text-primary/50' : 'text-text-tertiary'
            }`}
          />
        )}
      </button>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
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

      <div className="flex-1 overflow-y-auto">
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
              {t('branch.local')}
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
    </div>
  )
}

// ChevronRight 图标组件
function ChevronRightIcon({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}