/**
 * 快捷操作组件
 *
 * 常用 Git 操作按钮
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Download, RefreshCw, AlertTriangle, ArrowUp, ArrowDown, ScanSearch, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/Common/Button'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { invoke } from '@/services/transport'
import { PushDialog } from './PushDialog'

interface QuickActionsProps {
  hasChanges: boolean
}

type PullState =
  | { type: 'idle' }
  | { type: 'confirming'; message: string }
  | { type: 'pulling' }

type ReviewState =
  | { type: 'idle' }
  | { type: 'running' }
  | { type: 'done'; content: string }
  | { type: 'error'; message: string }

/** 去除终端 ANSI 转义序列（CLI 在非 TTY 下通常不输出颜色，此处兜底防乱码） */
function stripAnsi(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/\[[0-9;]*m/g, '')
}

export function QuickActions({ hasChanges: _hasChanges }: QuickActionsProps) {
  const { t } = useTranslation('git')
  const { isLoading, refreshStatus, status } = useGitStore()
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s
    return workspaces.find(w => w.id === currentWorkspaceId) || null
  })

  const [isPulling, setIsPulling] = useState(false)
  const [showPushDialog, setShowPushDialog] = useState(false)
  const [pullState, setPullState] = useState<PullState>({ type: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [reviewState, setReviewState] = useState<ReviewState>({ type: 'idle' })

  const handlePush = () => {
    setShowPushDialog(true)
  }

  const handlePull = async () => {
    if (!currentWorkspace) return

    setError(null)
    setIsPulling(true)
    setPullState({ type: 'pulling' })

    try {
      const result = await invoke<{ success: boolean; fastForward: boolean; message?: string }>('git_pull', {
        workspacePath: currentWorkspace.path,
        remoteName: 'origin',
        branchName: status?.branch || null,
      })

      if (!result.success && result.message) {
        if (result.message.includes('conflict')) {
          setPullState({ type: 'confirming', message: result.message })
        } else {
          setError(`${t('errors.pullFailed')}: ${result.message}`)
          setPullState({ type: 'idle' })
        }
      } else {
        await refreshStatus(currentWorkspace.path)
        setPullState({ type: 'idle' })
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)

      if (errorMsg.includes('conflict')) {
        setPullState({ type: 'confirming', message: errorMsg })
      } else {
        setError(`${t('errors.pullFailed')}: ${errorMsg}`)
        setPullState({ type: 'idle' })
      }
    } finally {
      setIsPulling(false)
    }
  }

  const handleRefresh = () => {
    if (currentWorkspace) {
      refreshStatus(currentWorkspace.path)
    }
  }

  const handleReview = async () => {
    if (!currentWorkspace) return

    setReviewState({ type: 'running' })
    try {
      const output = await invoke<string>('cli_run_ultrareview', {
        workspaceDir: currentWorkspace.path,
        target: status?.branch ?? null,
        timeoutMins: 30,
      })
      setReviewState({ type: 'done', content: stripAnsi(output).trim() })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setReviewState({ type: 'error', message: msg })
    }
  }

  const isOperating = isLoading || isPulling
  const isReviewing = reviewState.type === 'running'

  return (
    <>
      <div className="px-4 py-3 border-t border-border-subtle">
        {error && (
          <div className="mb-2 px-3 py-2 text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg">
            {error}
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={handleRefresh}
            disabled={isOperating}
            className="px-2"
            title={t('refreshStatus')}
          >
            <RefreshCw size={14} className={isLoading ? 'animate-spin' : ''} />
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={handlePull}
            disabled={isOperating || !currentWorkspace}
            className="flex-1"
          >
            <Download size={14} />
            {t('actions.pull')}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={handlePush}
            disabled={isOperating || !currentWorkspace}
            className="flex-1"
          >
            <Upload size={14} />
            {t('actions.push')}
          </Button>
        </div>

        {/* AI 代码审查（云端 ultrareview） */}
        <Button
          size="sm"
          variant="secondary"
          onClick={handleReview}
          disabled={isOperating || isReviewing || !currentWorkspace}
          className="w-full mt-2"
          title={status?.branch ? t('ultraReview.currentBranch', { branch: status.branch }) : undefined}
        >
          {isReviewing ? <Loader2 size={14} className="animate-spin" /> : <ScanSearch size={14} />}
          {isReviewing ? t('ultraReview.reviewing') : t('ultraReview.button')}
        </Button>
        {isReviewing && (
          <div className="mt-1.5 text-[11px] text-text-tertiary leading-relaxed">
            {t('ultraReview.reviewingHint')}
          </div>
        )}

        {status?.ahead && status.ahead > 0 && (
          <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
            <ArrowUp size={12} className="text-primary" />
            <span>{t('sync.ahead', { count: status.ahead })}</span>
          </div>
        )}
        {status?.behind && status.behind > 0 && (
          <div className="mt-1 flex items-center gap-1 text-xs text-text-tertiary">
            <ArrowDown size={12} className="text-warning" />
            <span>{t('sync.behind', { count: status.behind })}</span>
          </div>
        )}
      </div>

      {/* 推送对话框 */}
      <PushDialog
        isOpen={showPushDialog}
        onClose={() => setShowPushDialog(false)}
      />

      {/* 拉取冲突提示 */}
      {pullState.type === 'confirming' && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-background-elevated rounded-xl p-6 w-full max-w-md border border-border shadow-lg">
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle size={20} className="text-warning shrink-0 mt-0.5" />
              <div>
                <h2 className="text-lg font-semibold text-text-primary mb-1">
                  {t('pull.conflict')}
                </h2>
                <p className="text-sm text-text-secondary whitespace-pre-wrap">
                  {pullState.message}
                </p>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                onClick={() => setPullState({ type: 'idle' })}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary hover:bg-background-hover rounded-lg transition-colors"
              >
                {t('close', { ns: 'common' })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI 审查结果 / 错误 */}
      {(reviewState.type === 'done' || reviewState.type === 'error') && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-background-elevated rounded-xl w-full max-w-2xl max-h-[80vh] border border-border shadow-lg flex flex-col">
            <div className="flex items-center justify-between px-5 py-3 border-b border-border-subtle shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <ScanSearch size={16} className="text-primary shrink-0" />
                <h2 className="text-sm font-semibold text-text-primary">{t('ultraReview.title')}</h2>
                {status?.branch && (
                  <span className="text-xs text-text-tertiary truncate">· {status.branch}</span>
                )}
              </div>
              <button
                onClick={() => setReviewState({ type: 'idle' })}
                className="p-1 text-text-tertiary hover:text-text-primary hover:bg-background-hover rounded transition-colors shrink-0"
                title={t('ultraReview.close')}
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-5 py-4 min-h-0">
              {reviewState.type === 'error' ? (
                <div className="text-sm text-danger whitespace-pre-wrap break-words">
                  {t('ultraReview.failed')}: {reviewState.message}
                </div>
              ) : reviewState.content ? (
                <pre className="text-xs text-text-secondary whitespace-pre-wrap break-words font-mono leading-relaxed">
                  {reviewState.content}
                </pre>
              ) : (
                <div className="text-sm text-text-tertiary">{t('ultraReview.empty')}</div>
              )}
            </div>

            <div className="flex justify-end gap-2 px-5 py-3 border-t border-border-subtle shrink-0">
              <Button size="sm" variant="secondary" onClick={() => setReviewState({ type: 'idle' })}>
                {t('ultraReview.close')}
              </Button>
              <Button size="sm" variant="primary" onClick={handleReview} disabled={!currentWorkspace}>
                {t('ultraReview.rerun')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
