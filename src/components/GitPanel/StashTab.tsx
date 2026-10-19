/**
 * Stash 列表组件
 *
 * 显示 Git stash 列表，支持 apply/drop 操作
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Archive,
  Check,
  RefreshCw,
  Loader2,
  Inbox,
  Eye,
  FileDiff,
  X,
  Play,
} from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useGitActiveWorkspace } from './useGitActiveWorkspace'
import { formatGitTimestamp } from '@/utils/gitFormat'
import type { GitStashEntry } from '@/types/git'

interface StashTabProps {
  /** 多仓库模式下生效的仓库路径（子仓库）；缺省时回退到当前工作区 */
  workspacePath?: string
}

export function StashTab({ workspacePath: workspacePathProp }: StashTabProps) {
  const { t } = useTranslation('git')
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operatingIndex, setOperatingIndex] = useState<number | null>(null)
  const [showPatchIndex, setShowPatchIndex] = useState<number | null>(null)
  const [patchContent, setPatchContent] = useState<string>('')
  const [isPatchLoading, setIsPatchLoading] = useState(false)
  const [patchError, setPatchError] = useState<string | null>(null)

  const getStashList = useGitStore((s) => s.getStashList)
  const stashPop = useGitStore((s) => s.stashPop)
  const stashApply = useGitStore((s) => s.stashApply)
  const stashShow = useGitStore((s) => s.stashShow)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const currentWorkspace = useGitActiveWorkspace()

  // 多仓库模式下生效的仓库路径：优先使用父级传入的子仓库路径，否则回退当前工作区
  const workspacePath = workspacePathProp ?? currentWorkspace?.path ?? ''

  const loadStashes = useCallback(async () => {
    if (!workspacePath) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await getStashList(workspacePath)
      setStashes(result)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath, getStashList])

  useEffect(() => {
    loadStashes()
  }, [loadStashes])

  const handleApply = async (index: number) => {
    if (!workspacePath) return

    setOperatingIndex(index)
    setError(null)
    try {
      await stashPop(workspacePath, index)
      await loadStashes()
      await refreshStatus(workspacePath)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setOperatingIndex(null)
    }
  }

  // P1：apply —— 应用但不移除（保留在列表）
  const handleStashApply = async (index: number) => {
    if (!workspacePath) return

    setOperatingIndex(index)
    setError(null)
    try {
      await stashApply(workspacePath, index)
      await refreshStatus(workspacePath)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setOperatingIndex(null)
    }
  }

  // P1：show —— 查看 patch 内容
  const handleShow = async (index: number) => {
    if (!workspacePath) return

    setShowPatchIndex(index)
    setIsPatchLoading(true)
    setPatchError(null)
    try {
      const content = await stashShow(workspacePath, index)
      setPatchContent(content)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setPatchError(errorMsg)
      setPatchContent('')
    } finally {
      setIsPatchLoading(false)
    }
  }

  // 使用共享的时间格式化函数
  const formatTime = (timestamp: number) => formatGitTimestamp(timestamp, t)

  return (
    <div className="relative flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between">
        <span className="text-sm font-medium text-text-primary">{t('stash.title')}</span>
        <button
          onClick={loadStashes}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
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

      <div className="flex-1 overflow-y-auto min-h-0">
        {isLoading && stashes.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : stashes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Inbox size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('stash.empty')}</span>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {stashes.map((stash) => (
              <div
                key={stash.index}
                className="px-4 py-3 hover:bg-background-hover transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-warning/10 flex items-center justify-center">
                    <Archive size={12} className="text-warning" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
                        {`stash@{${stash.index}}`}
                      </span>
                    </div>
                    <div className="text-sm text-text-primary font-medium truncate mb-1">
                      {stash.message}
                    </div>
                    <div className="text-xs text-text-tertiary">
                      {stash.branch} · {formatTime(stash.timestamp)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {/* P1：三动作 —— 查看 / 应用(保留) / 恢复并移除 */}
                    <button
                      onClick={() => handleShow(stash.index)}
                      disabled={operatingIndex !== null}
                      className="p-1.5 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
                      title={t('stash.showTitle')}
                    >
                      <Eye size={14} />
                    </button>
                    <button
                      onClick={() => handleStashApply(stash.index)}
                      disabled={operatingIndex !== null}
                      className="p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                      title={t('stash.applyTitle')}
                    >
                      {operatingIndex === stash.index ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Play size={14} />
                      )}
                    </button>
                    <button
                      onClick={() => handleApply(stash.index)}
                      disabled={operatingIndex !== null}
                      className="p-1.5 text-text-tertiary hover:text-danger hover:bg-danger/10 rounded transition-colors disabled:opacity-50"
                      title={t('stash.popTitle')}
                    >
                      <Check size={14} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* P1：stash show —— patch 查看对话框 */}
      {showPatchIndex !== null && (
        <div className="absolute inset-0 z-modal bg-background-elevated flex flex-col border-t border-border">
          <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <FileDiff size={14} className="text-warning shrink-0" />
              <span className="text-sm font-medium text-text-primary truncate">
                {t('stash.show')} · stash@{'{'}{showPatchIndex}{'}'}
              </span>
            </div>
            <button
              onClick={() => {
                setShowPatchIndex(null)
                setPatchContent('')
                setPatchError(null)
              }}
              className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors shrink-0"
              title={t('cancel', { ns: 'common' })}
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-auto min-h-0 px-4 py-3">
            {isPatchLoading ? (
              <div className="flex items-center justify-center py-8 text-text-tertiary">
                <Loader2 size={18} className="animate-spin mr-2" />
                <span className="text-xs">{t('loading', { ns: 'common' })}</span>
              </div>
            ) : patchError ? (
              <div className="text-xs text-danger">{patchError}</div>
            ) : patchContent ? (
              <pre className="text-xs font-mono text-text-secondary whitespace-pre-wrap break-all leading-relaxed">
                {patchContent}
              </pre>
            ) : (
              <div className="text-xs text-text-tertiary">{t('stash.showEmpty')}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
