/**
 * 远程仓库列表组件
 *
 * 显示远程仓库信息，支持添加、删除远程仓库
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Globe,
  RefreshCw,
  Loader2,
  Cloud,
  CloudOff,
  ExternalLink,
  Copy,
  Plus,
  Trash2,
  X,
  ArrowDown,
  ArrowUp,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { useGitActiveWorkspace } from './useGitActiveWorkspace'
import { useGitRepoStatus } from './useGitRepoStatus'
import { PushDialog } from './PushDialog'
import { ConflictPredictionCard } from './ConflictPredictionCard'
import type { GitRemote } from '@/types/git'
import { openExternalLink } from '@/services/linkExternal'

/** auto-fetch 开关持久化键（P1：本地设置项，默认关） */
const AUTO_FETCH_STORAGE_KEY = 'polaris.git.autoFetch'
/** auto-fetch 间隔（ms）：对齐 IDEA 建议的 20 分钟 */
const AUTO_FETCH_INTERVAL_MS = 20 * 60 * 1000

interface RemoteTabProps {
  /** 多仓库模式下生效的仓库路径（子仓库）；缺省时回退到当前工作区 */
  workspacePath?: string
}

export function RemoteTab({ workspacePath: workspacePathProp }: RemoteTabProps) {
  const { t } = useTranslation('git')
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 添加远程仓库状态
  const [showAddRemote, setShowAddRemote] = useState(false)
  const [newRemoteName, setNewRemoteName] = useState('')
  const [newRemoteUrl, setNewRemoteUrl] = useState('')
  const [isAdding, setIsAdding] = useState(false)

  // 删除远程仓库状态
  const [showDeleteConfirm, setShowDeleteConfirm] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // 拉取状态
  const [isPulling, setIsPulling] = useState(false)
  const [pullingRemote, setPullingRemote] = useState<string | null>(null)

  // 获取状态
  const [isFetching, setIsFetching] = useState(false)
  const [fetchingRemote, setFetchingRemote] = useState<string | null>(null)
  // auto-fetch 设置（localStorage 持久化，默认关）
  const [autoFetch, setAutoFetch] = useState(() => {
    try {
      return localStorage.getItem(AUTO_FETCH_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  // 推送对话框状态
  const [showPushDialog, setShowPushDialog] = useState(false)
  const [pushTargetRemote, setPushTargetRemote] = useState<string | null>(null)

  const getRemotes = useGitStore((s) => s.getRemotes)
  const addRemote = useGitStore((s) => s.addRemote)
  const removeRemote = useGitStore((s) => s.removeRemote)
  const pull = useGitStore((s) => s.pull)
  const fetchRemote = useGitStore((s) => s.fetchRemote)
  const predictConflicts = useGitStore((s) => s.predictConflicts)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const getBranches = useGitStore((s) => s.getBranches)
  const branches = useGitStore((s) => s.branches)
  const currentWorkspace = useGitActiveWorkspace()
  const toast = useToastStore()

  // 多仓库模式下生效的仓库路径：优先使用父级传入的子仓库路径，否则回退当前工作区
  const workspacePath = workspacePathProp ?? currentWorkspace?.path ?? ''

  const status = useGitRepoStatus(workspacePath)

  const loadRemotes = useCallback(async () => {
    if (!workspacePath) return

    setIsLoading(true)
    setError(null)
    try {
      await getRemotes(workspacePath)
      // 从 store 获取更新后的 remotes
      const storeRemotes = useGitStore.getState().remotes
      setRemotes(storeRemotes)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('errors.getRemotesFailed'), errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath, getRemotes, t, toast])

  useEffect(() => {
    loadRemotes()
  }, [loadRemotes])

  // 优化：使用 useMemo 预计算所有远程仓库的分支数
  const remoteBranchCounts = useMemo(() => {
    const counts = new Map<string, number>()
    branches.forEach(branch => {
      if (branch.isRemote) {
        const remoteName = branch.name.split('/')[0]
        counts.set(remoteName, (counts.get(remoteName) || 0) + 1)
      }
    })
    return counts
  }, [branches])

  // 提取域名用于显示图标
  const getHostFromUrl = (url?: string) => {
    if (!url) return null
    try {
      // 处理 SSH URL (git@github.com:user/repo.git)
      if (url.startsWith('git@')) {
        const match = url.match(/git@([^:]+):/)
        return match ? match[1] : null
      }
      // 处理 HTTPS URL
      const urlObj = new URL(url)
      return urlObj.hostname
    } catch {
      return null
    }
  }

  // 复制 URL 到剪贴板
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('remote.copied'))
    } catch {
      toast.error(t('errors.copyFailed'))
    }
  }

  // 在浏览器中打开远程仓库
  const openRemoteUrl = (url?: string) => {
    if (!url) return
    let openUrl = url
    // 转换 SSH URL 为 HTTPS
    if (url.startsWith('git@')) {
      openUrl = url.replace('git@', 'https://').replace(':', '/').replace('.git', '')
    }
    // 移除 .git 后缀
    openUrl = openUrl.replace(/\.git$/, '')
    void openExternalLink(openUrl)
  }

  // 添加远程仓库
  const handleAddRemote = async () => {
    if (!workspacePath) return

    const name = newRemoteName.trim()
    const url = newRemoteUrl.trim()

    if (!name || !url) {
      toast.error(t('remote.addRemoteRequired'))
      return
    }

    // 简单的名称验证
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      toast.error(t('remote.invalidName'))
      return
    }

    setIsAdding(true)
    try {
      await addRemote(workspacePath, name, url)
      toast.success(t('remote.addSuccess', { name }))
      setShowAddRemote(false)
      setNewRemoteName('')
      setNewRemoteUrl('')
      // 刷新列表
      await loadRemotes()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('remote.addFailed'), errorMsg)
    } finally {
      setIsAdding(false)
    }
  }

  // 删除远程仓库
  const handleDeleteRemote = async (name: string) => {
    if (!workspacePath) return

    setIsDeleting(true)
    try {
      await removeRemote(workspacePath, name)
      toast.success(t('remote.deleteSuccess', { name }))
      setShowDeleteConfirm(null)
      // 刷新列表
      await loadRemotes()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('remote.deleteFailed'), errorMsg)
    } finally {
      setIsDeleting(false)
    }
  }

  // 拉取远程更新
  const handlePull = async (remoteName?: string) => {
    if (!workspacePath) return

    const remote = remoteName || 'origin'
    setIsPulling(true)
    setPullingRemote(remote)

    try {
      const result = await pull(workspacePath, remote)

      // 并发执行：刷新状态和分支列表（独立操作可以并行）
      await Promise.all([
        refreshStatus(workspacePath),
        getBranches(workspacePath)
      ])

      // 显示拉取结果
      if (result.conflicts && result.conflicts.length > 0) {
        toast.warning(
          t('pull.conflict'),
          t('pull.conflictDesc')
        )
      } else if (result.pulledCommits > 0) {
        toast.success(
          t('remote.pullSuccess'),
          t('remote.pullSuccessDetail', {
            commits: result.pulledCommits,
            files: result.filesChanged,
          })
        )
      } else {
        toast.info(t('remote.pullNoChanges'))
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('errors.pullFailed'), errorMsg)
    } finally {
      setIsPulling(false)
      setPullingRemote(null)
    }
  }

  // 打开推送对话框
  const handleOpenPushDialog = (remoteName?: string) => {
    setPushTargetRemote(remoteName || null)
    setShowPushDialog(true)
  }

  // 获取远程更新（不合并；仅刷新 refs 与 ahead/behind）
  const handleFetch = async (remoteName?: string) => {
    if (!workspacePath) return

    const remote = remoteName || 'origin'
    setIsFetching(true)
    setFetchingRemote(remote)

    try {
      await fetchRemote(workspacePath, remote, false)
      await Promise.all([
        refreshStatus(workspacePath),
        getBranches(workspacePath),
        // FR-P2-AI4 冲突预测：fetch 后确定性计算风险清单（0 token，与刷新并行）
        predictConflicts(workspacePath),
      ])
      toast.success(t('remote.fetchSuccess'))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('remote.fetchFailed'), errorMsg)
    } finally {
      setIsFetching(false)
      setFetchingRemote(null)
    }
  }

  // auto-fetch 开关（持久化到 localStorage）
  const handleToggleAutoFetch = useCallback(() => {
    setAutoFetch((prev) => {
      const next = !prev
      try {
        localStorage.setItem(AUTO_FETCH_STORAGE_KEY, next ? '1' : '0')
      } catch {
        // localStorage 不可用时静默
      }
      toast.success(next ? t('remote.autoFetchOn') : t('remote.autoFetchOff'))
      return next
    })
  }, [t, toast])

  // auto-fetch 定时拉取（默认关；开启后每 20 分钟 fetch 首个 remote）
  useEffect(() => {
    if (!autoFetch || !workspacePath || remotes.length === 0) return
    const timer = window.setInterval(() => {
      void handleFetch(remotes[0]?.name)
    }, AUTO_FETCH_INTERVAL_MS)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFetch, workspacePath, remotes.length])

  const renderRemoteItem = (remote: GitRemote) => {
    const host = getHostFromUrl(remote.fetchUrl || remote.pushUrl)
    const branchCount = remoteBranchCounts.get(remote.name) || 0
    const displayUrl = remote.fetchUrl || remote.pushUrl || t('remote.noUrl')

    return (
      <div
        key={remote.name}
        className="w-full px-4 py-3 hover:bg-background-hover transition-colors border-b border-border-subtle group"
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center bg-primary/10">
            {host ? (
              <Cloud size={16} className="text-primary" />
            ) : (
              <Globe size={16} className="text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-sm font-medium text-text-primary">
                {remote.name}
              </span>
              <span className="text-[10px] px-1.5 py-0.5 bg-info/20 text-info rounded">
                {t('remote.remote')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-text-tertiary mb-1">
              <span className="font-mono truncate max-w-[200px]" title={displayUrl}>
                {displayUrl}
              </span>
              {remote.fetchUrl && (
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  {/* 推送按钮 */}
                  {status && status.ahead > 0 && (
                    <button
                      onClick={() => handleOpenPushDialog(remote.name)}
                      className="p-0.5 text-text-tertiary hover:text-success hover:bg-success/10 rounded transition-colors"
                      title={t('remote.pushTo', { remote: remote.name })}
                    >
                      <ArrowUp size={12} />
                    </button>
                  )}
                  {/* 拉取按钮 */}
                  <button
                    onClick={() => handlePull(remote.name)}
                    disabled={isPulling}
                    className="p-0.5 text-text-tertiary hover:text-success hover:bg-success/10 rounded transition-colors disabled:opacity-50"
                    title={t('remote.pullFrom', { remote: remote.name })}
                  >
                    {pullingRemote === remote.name ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <ArrowDown size={12} />
                    )}
                  </button>
                  {/* 获取按钮（P1：不合并，仅刷新 refs） */}
                  <button
                    onClick={() => handleFetch(remote.name)}
                    disabled={isFetching}
                    className="p-0.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                    title={t('remote.fetchFrom', { remote: remote.name })}
                  >
                    {fetchingRemote === remote.name ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <RefreshCw size={12} />
                    )}
                  </button>
                  <button
                    onClick={() => remote.fetchUrl && copyToClipboard(remote.fetchUrl)}
                    className="p-0.5 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-colors"
                    title={t('remote.copyUrl')}
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    onClick={() => openRemoteUrl(remote.fetchUrl)}
                    className="p-0.5 text-text-tertiary hover:text-text-primary hover:bg-background-surface rounded transition-colors"
                    title={t('remote.openInBrowser')}
                  >
                    <ExternalLink size={12} />
                  </button>
                  <button
                    onClick={() => setShowDeleteConfirm(remote.name)}
                    className="p-0.5 text-text-tertiary hover:text-danger hover:bg-danger/10 rounded transition-colors"
                    title={t('remote.deleteRemote')}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-text-tertiary">
              {branchCount > 0 && (
                <span className="flex items-center gap-1">
                  <Globe size={10} />
                  <span>{t('remote.branchCount', { count: branchCount })}</span>
                </span>
              )}
              {remote.pushUrl && remote.pushUrl !== remote.fetchUrl && (
                <span className="text-text-tertiary">
                  {t('remote.pushUrl')}: {remote.pushUrl}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">
          {t('remote.title')}
          {remotes.length > 0 && (
            <span className="ml-2 text-xs text-text-tertiary">
              ({remotes.length})
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {/* 推送按钮 */}
          {remotes.length > 0 && status && status.ahead > 0 && (
            <button
              onClick={() => handleOpenPushDialog()}
              disabled={isLoading}
              className="p-1 text-text-tertiary hover:text-success hover:bg-success/10 rounded transition-colors disabled:opacity-50"
              title={t('remote.push')}
            >
              <ArrowUp size={14} />
            </button>
          )}
          {/* 拉取按钮 */}
          {remotes.length > 0 && (
            <button
              onClick={() => handlePull()}
              disabled={isPulling || isLoading}
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
              title={t('remote.pull')}
            >
              {isPulling ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowDown size={14} />
              )}
            </button>
          )}
          <button
            onClick={() => setShowAddRemote(true)}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors"
            title={t('remote.addRemote')}
          >
            <Plus size={14} />
          </button>
          <button
            onClick={loadRemotes}
            disabled={isLoading}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
            title={t('refresh', { ns: 'common' })}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </button>
          {/* auto-fetch 开关（P1：默认关；开启后每 20 分钟 fetch） */}
          <button
            onClick={handleToggleAutoFetch}
            className={`p-1 rounded transition-colors ${
              autoFetch
                ? 'text-primary bg-primary/10 hover:bg-primary/20'
                : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover'
            }`}
            title={t('remote.autoFetchDesc')}
            aria-label={t('remote.autoFetch')}
          >
            <RefreshCw size={14} className={autoFetch ? '' : 'opacity-40'} />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-2 text-xs text-danger bg-danger/10 border-b border-danger/20">
          {error}
        </div>
      )}

      {/* FR-P2-AI4 冲突预测卡片：fetch 后由 handleFetch 填充；无预测时自动隐藏 */}
      {workspacePath && <ConflictPredictionCard workspacePath={workspacePath} />}

      {/* 添加远程仓库弹窗 */}
      {showAddRemote && (
        <div className="px-4 py-3 border-b border-border-subtle bg-background-surface">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium text-text-primary">
              {t('remote.addRemote')}
            </span>
            <button
              onClick={() => {
                setShowAddRemote(false)
                setNewRemoteName('')
                setNewRemoteUrl('')
              }}
              className="p-0.5 text-text-tertiary hover:text-text-primary rounded transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="space-y-2">
            <input
              type="text"
              placeholder={t('remote.namePlaceholder')}
              value={newRemoteName}
              onChange={(e) => setNewRemoteName(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddRemote()
                } else if (e.key === 'Escape') {
                  setShowAddRemote(false)
                  setNewRemoteName('')
                  setNewRemoteUrl('')
                }
              }}
            />
            <input
              type="text"
              placeholder={t('remote.urlPlaceholder')}
              value={newRemoteUrl}
              onChange={(e) => setNewRemoteUrl(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-background-surface border border-border rounded focus:outline-none focus:ring-1 focus:ring-primary font-mono text-xs"
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleAddRemote()
                } else if (e.key === 'Escape') {
                  setShowAddRemote(false)
                  setNewRemoteName('')
                  setNewRemoteUrl('')
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <button
                onClick={() => {
                  setShowAddRemote(false)
                  setNewRemoteName('')
                  setNewRemoteUrl('')
                }}
                className="px-3 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
              >
                {t('cancel', { ns: 'common' })}
              </button>
              <button
                onClick={handleAddRemote}
                disabled={isAdding || !newRemoteName.trim() || !newRemoteUrl.trim()}
                className="px-3 py-1 text-xs bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
              >
                {isAdding && <Loader2 size={12} className="animate-spin" />}
                {t('remote.add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 删除确认弹窗 */}
      {showDeleteConfirm && (
        <div className="px-4 py-3 border-b border-danger/30 bg-danger/5">
          <div className="text-sm text-text-primary mb-2">
            {t('remote.deleteConfirm', { name: showDeleteConfirm })}
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowDeleteConfirm(null)}
              className="px-3 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors"
            >
              {t('cancel', { ns: 'common' })}
            </button>
            <button
              onClick={() => handleDeleteRemote(showDeleteConfirm)}
              disabled={isDeleting}
              className="px-3 py-1 text-xs bg-danger text-white rounded hover:bg-danger/90 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isDeleting && <Loader2 size={12} className="animate-spin" />}
              {t('remote.delete')}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && remotes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : remotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <CloudOff size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('remote.empty')}</span>
            <span className="text-xs mt-1 text-text-tertiary">{t('remote.emptyHint')}</span>
            <button
              onClick={() => setShowAddRemote(true)}
              className="mt-3 px-3 py-1.5 text-xs bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors flex items-center gap-1"
            >
              <Plus size={12} />
              {t('remote.addRemote')}
            </button>
          </div>
        ) : (
          remotes.map((remote) => renderRemoteItem(remote))
        )}
      </div>

      {/* 推送对话框 */}
      <PushDialog
        isOpen={showPushDialog}
        onClose={() => {
          setShowPushDialog(false)
          setPushTargetRemote(null)
        }}
        defaultRemote={pushTargetRemote || undefined}
        workspacePath={workspacePath}
      />
    </div>
  )
}
