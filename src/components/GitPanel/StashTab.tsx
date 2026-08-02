/**
 * Stash 列表组件
 *
 * 显示 Git stash 列表，支持 apply/drop 操作
 */

import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Archive, Check, RefreshCw, Loader2, Inbox } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { formatGitTimestamp } from '@/utils/gitFormat'
import type { GitStashEntry } from '@/types/git'

export function StashTab() {
  const { t } = useTranslation('git')
  const [stashes, setStashes] = useState<GitStashEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [operatingIndex, setOperatingIndex] = useState<number | null>(null)

  const getStashList = useGitStore((s) => s.getStashList)
  const stashPop = useGitStore((s) => s.stashPop)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })

  const loadStashes = useCallback(async () => {
    if (!currentWorkspace) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await getStashList(currentWorkspace.path)
      setStashes(result)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [currentWorkspace, getStashList])

  useEffect(() => {
    loadStashes()
  }, [loadStashes])

  const handleApply = async (index: number) => {
    if (!currentWorkspace) return

    setOperatingIndex(index)
    setError(null)
    try {
      await stashPop(currentWorkspace.path, index)
      await loadStashes()
      await refreshStatus(currentWorkspace.path)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
    } finally {
      setOperatingIndex(null)
    }
  }

  // 使用共享的时间格式化函数
  const formatTime = (timestamp: number) => formatGitTimestamp(timestamp, t)

  return (
    <div className="flex flex-col h-full min-h-0">
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
                    <button
                      onClick={() => handleApply(stash.index)}
                      disabled={operatingIndex !== null}
                      className="p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                      title={t('stash.pop')}
                    >
                      {operatingIndex === stash.index ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Check size={14} />
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
