/**
 * 推送对话框组件
 *
 * 支持选择远程仓库、本地分支和远程分支进行推送
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Upload,
  X,
  Loader2,
  AlertTriangle,
  GitBranch as GitBranchIcon,
  Globe,
  Check,
  ArrowRight,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { useToastStore } from '@/stores/toastStore'
import type { GitPushResult } from '@/types/git'

interface PushDialogProps {
  isOpen: boolean
  onClose: () => void
  defaultRemote?: string
  defaultBranch?: string
}

export function PushDialog({ isOpen, onClose, defaultRemote, defaultBranch }: PushDialogProps) {
  const { t } = useTranslation('git')

  // 状态
  const [selectedRemote, setSelectedRemote] = useState('')
  const [selectedBranch, setSelectedBranch] = useState('')
  const [remoteBranchName, setRemoteBranchName] = useState('')
  const [useCustomRemoteBranch, setUseCustomRemoteBranch] = useState(false)
  const [force, setForce] = useState(false)
  const [setUpstream, setSetUpstream] = useState(false)
  const [isPushing, setIsPushing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showRemoteDropdown, setShowRemoteDropdown] = useState(false)
  const [showBranchDropdown, setShowBranchDropdown] = useState(false)
  const [showRemoteBranchDropdown, setShowRemoteBranchDropdown] = useState(false)

  // Store
  const remotes = useGitStore((s) => s.remotes)
  const branches = useGitStore((s) => s.branches)
  const status = useGitStore((s) => s.status)
  const push = useGitStore((s) => s.push)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const getRemotes = useGitStore((s) => s.getRemotes)
  const getBranches = useGitStore((s) => s.getBranches)

  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find((w) => w.id === currentWorkspaceId) || null
  })

  const toast = useToastStore()

  // 过滤本地分支和远程分支
  const localBranches = useMemo(() => branches.filter((b) => !b.isRemote), [branches])
  const remoteBranches = useMemo(() => branches.filter((b) => b.isRemote), [branches])

  // 过滤当前选中远程仓库的分支
  const remoteBranchesForSelectedRemote = useMemo(() => {
    if (!selectedRemote) return []
    return remoteBranches
      .filter((b) => b.name.startsWith(`${selectedRemote}/`))
      .map((b) => ({
        ...b,
        displayName: b.name.replace(`${selectedRemote}/`, ''),
      }))
  }, [remoteBranches, selectedRemote])

  // 初始化选择 - 打开时先刷新数据,再基于最新状态计算默认值
  useEffect(() => {
    if (!isOpen || !currentWorkspace) return

    // 先同步重置 UI 状态,避免残留上次的勾选/错误
    setRemoteBranchName('')
    setUseCustomRemoteBranch(false)
    setForce(false)
    setSetUpstream(false)
    setError(null)

    let cancelled = false
    const workspacePath = currentWorkspace.path

    void (async () => {
      // 关键:await 刷新,确保默认值基于最新数据而非旧的 store 快照
      await Promise.all([
        getRemotes(workspacePath),
        getBranches(workspacePath),
        refreshStatus(workspacePath),
      ])
      if (cancelled) return

      const state = useGitStore.getState()

      // 远程默认值
      if (defaultRemote) {
        setSelectedRemote(defaultRemote)
      } else if (state.remotes.length > 0) {
        const origin = state.remotes.find((r) => r.name === 'origin')
        setSelectedRemote(origin?.name || state.remotes[0].name)
      }

      // 分支默认值:优先 status,其次从分支列表反查 isCurrent 兜底
      if (defaultBranch) {
        setSelectedBranch(defaultBranch)
      } else {
        setSelectedBranch(
          state.status?.branch ||
            state.branches.find((b) => b.isCurrent && !b.isRemote)?.name ||
            ''
        )
      }
    })()

    return () => {
      cancelled = true
    }
  }, [isOpen, currentWorkspace, defaultRemote, defaultBranch, getRemotes, getBranches, refreshStatus])

  // 当本地分支改变时，同步远程分支名（如果未自定义）
  useEffect(() => {
    if (!useCustomRemoteBranch && selectedBranch) {
      setRemoteBranchName(selectedBranch)
    }
  }, [selectedBranch, useCustomRemoteBranch])

  // 处理推送
  const handlePush = useCallback(async () => {
    if (!currentWorkspace || !selectedRemote || !selectedBranch) {
      setError(t('push.noRemote') || t('push.noBranch'))
      return
    }

    setIsPushing(true)
    setError(null)

    // 确定远程分支名
    const targetRemoteBranch = useCustomRemoteBranch ? remoteBranchName : selectedBranch

    try {
      const result: GitPushResult = await push(
        currentWorkspace.path,
        selectedBranch,
        selectedRemote,
        force,
        setUpstream,
        useCustomRemoteBranch ? targetRemoteBranch : undefined
      )

      if (result.success) {
        await refreshStatus(currentWorkspace.path)
        toast.success(t('remote.pushSuccess'), t('remote.pushSuccessDetail', { commits: result.pushedCommits }))
        onClose()
      } else if (result.needsUpstream) {
        setSetUpstream(true)
        setError(t('remote.pushNeedsUpstream'))
      } else if (result.rejected) {
        setForce(true)
        setError(t('remote.pushNeedsForce'))
      } else {
        setError(result.error || t('errors.pushFailed'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setIsPushing(false)
    }
  }, [
    currentWorkspace,
    selectedRemote,
    selectedBranch,
    force,
    setUpstream,
    useCustomRemoteBranch,
    remoteBranchName,
    push,
    refreshStatus,
    toast,
    t,
    onClose,
  ])

  // 键盘事件
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !isPushing) {
        handlePush()
      } else if (e.key === 'Escape') {
        onClose()
      }
    },
    [handlePush, isPushing, onClose]
  )

  if (!isOpen) return null

  const isCurrentBranch = selectedBranch === status?.branch

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onKeyDown={handleKeyDown}>
      <div className="bg-background-elevated rounded-xl w-full max-w-md border border-border shadow-lg">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <div className="flex items-center gap-3">
            <Upload size={20} className="text-primary" />
            <h2 className="text-lg font-semibold text-text-primary">{t('push.dialogTitle')}</h2>
          </div>
          <button
            onClick={onClose}
            disabled={isPushing}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="px-6 py-4 space-y-4">
          {/* 错误提示 */}
          {error && (
            <div className="px-3 py-2 bg-danger/10 border border-danger/20 rounded-lg flex items-start gap-2">
              <AlertTriangle size={16} className="text-danger shrink-0 mt-0.5" />
              <span className="text-sm text-danger">{error}</span>
            </div>
          )}

          {/* 远程仓库选择 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">{t('push.selectRemote')}</label>
            {remotes.length === 0 ? (
              <div className="px-3 py-2 bg-warning/10 border border-warning/20 rounded-lg text-sm text-warning">
                {t('push.noRemote')}
              </div>
            ) : remotes.length === 1 ? (
              <div className="px-3 py-2 bg-background-surface border border-border rounded-lg">
                <div className="flex items-center gap-2">
                  <Globe size={14} className="text-primary" />
                  <span className="text-sm font-medium text-text-primary">{remotes[0].name}</span>
                </div>
                {remotes[0].fetchUrl && (
                  <div className="mt-1 text-xs text-text-tertiary font-mono truncate">{remotes[0].fetchUrl}</div>
                )}
              </div>
            ) : (
              <div className="relative">
                <button
                  onClick={() => setShowRemoteDropdown(!showRemoteDropdown)}
                  disabled={isPushing}
                  className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-left flex items-center justify-between hover:bg-background-hover transition-colors disabled:opacity-50"
                >
                  <div className="flex items-center gap-2">
                    <Globe size={14} className="text-primary" />
                    <span className="text-sm text-text-primary">{selectedRemote || t('push.selectRemote')}</span>
                  </div>
                  <X size={14} className="text-text-tertiary rotate-45" />
                </button>

                {showRemoteDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-background-surface border border-border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                    {remotes.map((remote) => (
                      <button
                        key={remote.name}
                        onClick={() => {
                          setSelectedRemote(remote.name)
                          setShowRemoteDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-left hover:bg-background-hover transition-colors ${
                          selectedRemote === remote.name ? 'bg-primary/10' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {selectedRemote === remote.name && <Check size={12} className="text-primary" />}
                          <Globe
                            size={14}
                            className={selectedRemote === remote.name ? 'text-primary ml-0' : 'text-text-tertiary ml-4'}
                          />
                          <span className="text-sm text-text-primary">{remote.name}</span>
                        </div>
                        {remote.fetchUrl && (
                          <div className="ml-6 mt-0.5 text-xs text-text-tertiary font-mono truncate">
                            {remote.fetchUrl}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 本地分支选择 */}
          <div>
            <label className="block text-sm text-text-secondary mb-1.5">{t('push.selectBranch')}</label>
            <div className="relative">
              <button
                onClick={() => setShowBranchDropdown(!showBranchDropdown)}
                disabled={isPushing || localBranches.length === 0}
                className="w-full px-3 py-2 bg-background-surface border border-border rounded-lg text-left flex items-center justify-between hover:bg-background-hover transition-colors disabled:opacity-50"
              >
                <div className="flex items-center gap-2">
                  <GitBranchIcon size={14} className="text-primary" />
                  <span className="text-sm text-text-primary">{selectedBranch || t('push.selectBranch')}</span>
                  {isCurrentBranch && (
                    <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                      {t('push.currentBranch')}
                    </span>
                  )}
                </div>
                <X size={14} className="text-text-tertiary rotate-45" />
              </button>

              {showBranchDropdown && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-background-surface border border-border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                  {localBranches.map((branch) => (
                    <button
                      key={branch.name}
                      onClick={() => {
                        setSelectedBranch(branch.name)
                        setShowBranchDropdown(false)
                      }}
                      className={`w-full px-3 py-2 text-left hover:bg-background-hover transition-colors ${
                        selectedBranch === branch.name ? 'bg-primary/10' : ''
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        {selectedBranch === branch.name && <Check size={12} className="text-primary" />}
                        <GitBranchIcon
                          size={14}
                          className={selectedBranch === branch.name ? 'text-primary ml-0' : 'text-text-tertiary ml-4'}
                        />
                        <span className="text-sm text-text-primary">{branch.name}</span>
                        {branch.isCurrent && (
                          <span className="text-xs px-1.5 py-0.5 bg-primary/20 text-primary rounded">
                            {t('push.currentBranch')}
                          </span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* 远程分支名（可选自定义） */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-sm text-text-secondary">{t('push.remoteBranch')}</label>
              <button
                onClick={() => setUseCustomRemoteBranch(!useCustomRemoteBranch)}
                className="text-xs text-primary hover:text-primary/80 transition-colors"
              >
                {useCustomRemoteBranch ? t('push.useSameName') : t('push.useDifferentName')}
              </button>
            </div>

            {useCustomRemoteBranch ? (
              <div className="relative">
                {/* 可以选择已有远程分支或输入新名称 */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={remoteBranchName}
                    onChange={(e) => setRemoteBranchName(e.target.value)}
                    placeholder={selectedBranch}
                    disabled={isPushing}
                    className="flex-1 px-3 py-2 text-sm bg-background-surface border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 font-mono"
                  />
                  {remoteBranchesForSelectedRemote.length > 0 && (
                    <button
                      onClick={() => setShowRemoteBranchDropdown(!showRemoteBranchDropdown)}
                      disabled={isPushing}
                      className="p-2 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
                      title={t('push.selectExistingBranch')}
                    >
                      <GitBranchIcon size={14} />
                    </button>
                  )}
                </div>

                {showRemoteBranchDropdown && remoteBranchesForSelectedRemote.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-background-surface border border-border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
                    {remoteBranchesForSelectedRemote.map((branch) => (
                      <button
                        key={branch.name}
                        onClick={() => {
                          setRemoteBranchName(branch.displayName)
                          setShowRemoteBranchDropdown(false)
                        }}
                        className={`w-full px-3 py-2 text-left hover:bg-background-hover transition-colors ${
                          remoteBranchName === branch.displayName ? 'bg-primary/10' : ''
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          {remoteBranchName === branch.displayName && <Check size={12} className="text-primary" />}
                          <GitBranchIcon
                            size={14}
                            className={
                              remoteBranchName === branch.displayName ? 'text-primary ml-0' : 'text-text-tertiary ml-4'
                            }
                          />
                          <span className="text-sm text-text-primary">{branch.displayName}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="px-3 py-2 bg-background-surface border border-border rounded-lg flex items-center gap-2">
                <GitBranchIcon size={14} className="text-text-tertiary" />
                <span className="text-sm text-text-primary">{selectedBranch || '-'}</span>
                <span className="text-xs text-text-tertiary">({t('push.sameAsLocal')})</span>
              </div>
            )}
          </div>

          {/* 推送映射预览 */}
          {selectedBranch && selectedRemote && (
            <div className="px-3 py-2 bg-primary/5 border border-primary/20 rounded-lg">
              <div className="flex items-center justify-center gap-2 text-sm">
                <span className="text-text-primary font-medium">{selectedBranch}</span>
                <ArrowRight size={14} className="text-primary" />
                <span className="text-primary font-medium">
                  {selectedRemote}/{useCustomRemoteBranch && remoteBranchName ? remoteBranchName : selectedBranch}
                </span>
              </div>
            </div>
          )}

          {/* 推送选项 */}
          <div className="space-y-2">
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
                disabled={isPushing}
                className="mt-0.5 w-4 h-4 rounded border-border text-danger focus:ring-danger/50"
              />
              <div>
                <span className="text-sm text-text-primary">{t('push.forcePush')}</span>
                <span className="block text-xs text-text-tertiary">{t('push.forcePushDesc')}</span>
              </div>
            </label>

            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={setUpstream}
                onChange={(e) => setSetUpstream(e.target.checked)}
                disabled={isPushing}
                className="mt-0.5 w-4 h-4 rounded border-border text-primary focus:ring-primary/50"
              />
              <div>
                <span className="text-sm text-text-primary">{t('push.setUpstream')}</span>
                <span className="block text-xs text-text-tertiary">{t('push.setUpstreamDesc')}</span>
              </div>
            </label>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border">
          <button
            onClick={onClose}
            disabled={isPushing}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors disabled:opacity-50"
          >
            {t('cancel', { ns: 'common' })}
          </button>
          <button
            onClick={handlePush}
            disabled={isPushing || !selectedRemote || !selectedBranch}
            className="px-4 py-2 text-sm text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
          >
            {isPushing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                {t('push.pushing')}
              </>
            ) : (
              <>
                <Upload size={14} />
                {t('push.push')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
