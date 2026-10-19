/**
 * Reflog（操作日志）视图
 *
 * P1 · 超越差异点 #1（parity-plan §三.1）：IDEA 无 reflog 浏览界面。
 * 展示 reflog 条目（selector / subject / shortSha / 相对时间 / branch 徽标），
 * 支持「恢复到该提交」一键恢复（checkout 到 detached HEAD，二次确认）。
 *
 * 消费 slice：useGitStore.getReflog / checkoutCommit / refreshStatus
 */

import { useState, useCallback, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { History, Loader2, RefreshCw, Undo2, ArrowLeft, Inbox } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore/index'
import { useToastStore } from '@/stores/toastStore'
import { formatRelativeTime } from './historyTabUtils'
import { parseGitError } from '@/stores/gitStore/types'
import type { GitReflogEntry } from '@/types/git'

interface ReflogViewProps {
  /** 多仓库模式下生效的仓库路径（子仓库）；缺省时回退到当前工作区 */
  workspacePath?: string
  /** 返回提交历史 */
  onBack: () => void
}

export function ReflogView({ workspacePath, onBack }: ReflogViewProps) {
  const { t } = useTranslation('git')
  const [entries, setEntries] = useState<GitReflogEntry[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isRestoring, setIsRestoring] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmIndex, setConfirmIndex] = useState<number | null>(null)

  const getReflog = useGitStore((s) => s.getReflog)
  const checkoutCommit = useGitStore((s) => s.checkoutCommit)
  const refreshStatus = useGitStore((s) => s.refreshStatus)
  const toast = useToastStore()

  const loadReflog = useCallback(async () => {
    if (!workspacePath) return

    setIsLoading(true)
    setError(null)
    try {
      const result = await getReflog(workspacePath, null, 100)
      setEntries(result)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      setError(errorMsg)
      toast.error(t('history.reflogLoadFailed'), errorMsg)
    } finally {
      setIsLoading(false)
    }
  }, [workspacePath, getReflog, t, toast])

  useEffect(() => {
    void loadReflog()
  }, [loadReflog])

  // 恢复到该提交（checkout 到 detached HEAD，二次确认后执行）
  const handleRestore = useCallback(async (entry: GitReflogEntry) => {
    if (!workspacePath) return

    setIsRestoring(entry.timestamp)
    setConfirmIndex(null)
    try {
      await checkoutCommit(workspacePath, entry.sha)
      await refreshStatus(workspacePath)
      toast.success(t('history.reflogRestoreSuccess'))
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      toast.error(t('history.reflogRestoreFailed'), parseGitError(err) || errorMsg)
    } finally {
      setIsRestoring(null)
    }
  }, [workspacePath, checkoutCommit, refreshStatus, toast, t])

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-2 border-b border-border-subtle flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors shrink-0"
            title={t('history.backToCommitHistory')}
          >
            <ArrowLeft size={14} />
          </button>
          <div className="flex items-center gap-2 min-w-0">
            <History size={14} className="text-text-tertiary shrink-0" />
            <span className="text-sm font-medium text-text-primary truncate">
              {t('history.reflogTitle')}
            </span>
          </div>
        </div>
        <button
          onClick={loadReflog}
          disabled={isLoading}
          className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors disabled:opacity-50"
          title={t('refreshStatus')}
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
        {isLoading && entries.length === 0 ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-text-tertiary" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-text-tertiary">
            <Inbox size={24} className="mb-2 opacity-50" />
            <span className="text-sm">{t('history.reflogEmpty')}</span>
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {entries.map((entry, index) => (
              <div
                key={`${entry.selector}:${entry.timestamp}:${index}`}
                className="px-4 py-2.5 hover:bg-background-hover transition-colors"
              >
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-6 h-6 rounded-full bg-info/10 flex items-center justify-center mt-0.5">
                    <History size={11} className="text-info" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[11px] font-mono text-text-tertiary bg-background-surface px-1.5 py-0.5 rounded">
                        {entry.selector}
                      </span>
                      {entry.branch && (
                        <span className="text-[10px] px-1.5 py-0.5 bg-primary/10 text-primary rounded">
                          {entry.branch}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-text-tertiary shrink-0">
                        {entry.shortSha}
                      </span>
                    </div>
                    <div className="text-sm text-text-secondary truncate" title={entry.subject}>
                      {entry.subject}
                    </div>
                    <div className="text-[11px] text-text-tertiary mt-0.5">
                      {formatRelativeTime(entry.timestamp, t)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => setConfirmIndex(entry.timestamp)}
                      disabled={isRestoring !== null}
                      className="p-1.5 text-text-tertiary hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                      title={t('history.reflogRestoreTitle', { subject: entry.subject })}
                    >
                      {isRestoring === entry.timestamp ? (
                        <Loader2 size={14} className="animate-spin" />
                      ) : (
                        <Undo2 size={14} />
                      )}
                    </button>
                  </div>
                </div>

                {confirmIndex === entry.timestamp && (
                  <div className="mt-2 px-3 py-2 bg-warning/10 border border-warning/20 rounded-lg">
                    <div className="text-xs text-text-secondary mb-2 whitespace-pre-line">
                      {t('history.reflogRestoreConfirm')}
                    </div>
                    <div className="flex justify-end gap-2">
                      <button
                        onClick={() => setConfirmIndex(null)}
                        disabled={isRestoring !== null}
                        className="px-3 py-1 text-xs text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-50"
                      >
                        {t('cancel', { ns: 'common' })}
                      </button>
                      <button
                        onClick={() => handleRestore(entry)}
                        disabled={isRestoring !== null}
                        className="px-3 py-1 text-xs bg-primary text-white rounded hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-1"
                      >
                        <Undo2 size={12} />
                        {t('history.reflogRestore')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
