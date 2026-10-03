/**
 * 快捷操作组件
 *
 * 常用 Git 操作按钮
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Upload, Download, RefreshCw, AlertTriangle, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from '@/components/Common/Button'
import { useGitStore } from '@/stores/gitStore/index'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import { invoke } from '@/services/transport'
import { PushDialog } from './PushDialog'

interface QuickActionsProps {
  hasChanges: boolean
  /** 多仓库模式下生效的仓库路径（子仓库）；缺省时回退到当前工作区 */
  workspacePath?: string
}

type PullState =
  | { type: 'idle' }
  | { type: 'confirming'; message: string }
  | { type: 'pulling' }

export function QuickActions({ hasChanges: _hasChanges, workspacePath: workspacePathProp }: QuickActionsProps) {
  const { t } = useTranslation('git')
  const { isLoading, refreshStatus, status } = useGitStore()
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId, viewingWorkspaceId } = s
    const targetId = viewingWorkspaceId || currentWorkspaceId
    return workspaces.find(w => w.id === targetId) || null
  })

  // 多仓库模式下生效的仓库路径：优先使用父级传入的子仓库路径，否则回退当前工作区
  const workspacePath = workspacePathProp ?? currentWorkspace?.path ?? ''

  const [isPulling, setIsPulling] = useState(false)
  const [showPushDialog, setShowPushDialog] = useState(false)
  const [pullState, setPullState] = useState<PullState>({ type: 'idle' })
  const [error, setError] = useState<string | null>(null)

  const handlePush = () => {
    setShowPushDialog(true)
  }

  const handlePull = async () => {
    if (!workspacePath) return

    setError(null)
    setIsPulling(true)
    setPullState({ type: 'pulling' })

    try {
      const result = await invoke<{ success: boolean; fastForward: boolean; message?: string }>('git_pull', {
        workspacePath: workspacePath,
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
        await refreshStatus(workspacePath)
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
    if (workspacePath) {
      refreshStatus(workspacePath)
    }
  }

  const isOperating = isLoading || isPulling

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
            disabled={isOperating || !workspacePath}
            className="flex-1"
          >
            <Download size={14} />
            {t('actions.pull')}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={handlePush}
            disabled={isOperating || !workspacePath}
            className="flex-1"
          >
            <Upload size={14} />
            {t('actions.push')}
          </Button>
        </div>

        {status && status.ahead > 0 && (
          <div className="mt-2 flex items-center gap-1 text-xs text-text-tertiary">
            <ArrowUp size={12} className="text-primary" />
            <span>{t('sync.ahead', { count: status.ahead })}</span>
          </div>
        )}
        {status && status.behind > 0 && (
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
        workspacePath={workspacePath}
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
    </>
  )
}
