/**
 * 可撤销快照条（FR-P2-3 收尾：undoSlice 三方法的首个 UI 消费点）
 *
 * 依据 handoff §2.1：cap.git 危险操作（discard/reset_hard/checkout/rebase/branch_delete）
 * 成功后自动建 refs/polaris-undo 快照（后端已落地），此前前端无任何组件消费
 * listUndoSnapshots/restoreUndoSnapshot/dropUndoSnapshot —— 本组件补齐「一键恢复」出口。
 *
 * 形态：GitPanel 变更区下的常驻折叠条（快照 >0 才渲染，不主动打扰）；
 * 恢复遇冲突不抛错（outcome.conflictedFiles → warning toast）。
 */

import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { History as HistoryIcon, RefreshCw, Trash2, Undo2 } from 'lucide-react'
import { useGitStore } from '@/stores/gitStore'
import { useToastStore } from '@/stores/toastStore'
import type { UndoSnapshotMeta } from '@/types/git'

const SHOW_MAX = 3

function formatTime(unixSecs: number): string {
  const d = new Date(unixSecs * 1000)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: '2-digit', day: '2-digit' })
}

export function UndoBar({ workspacePath }: { workspacePath: string }) {
  const { t } = useTranslation('git')
  const toast = useToastStore()
  const snapshots = useGitStore(
    (s) => s.undoSnapshotsByWs?.[workspacePath] ?? s.undoSnapshots ?? [],
  )
  const listUndoSnapshots = useGitStore((s) => s.listUndoSnapshots)
  const restoreUndoSnapshot = useGitStore((s) => s.restoreUndoSnapshot)
  const dropUndoSnapshot = useGitStore((s) => s.dropUndoSnapshot)

  const [expanded, setExpanded] = useState(false)
  /** 两步确认丢弃：持有 ref 则该行按钮进入确认态 */
  const [confirmDropRef, setConfirmDropRef] = useState<string | null>(null)
  const [busyRef, setBusyRef] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    await listUndoSnapshots(workspacePath)
  }, [listUndoSnapshots, workspacePath])

  // 挂载/仓库切换时拉一次快照列表（数条读探针、成本可忽略）
  useEffect(() => {
    void refresh().catch(() => {})
    setExpanded(false)
    setConfirmDropRef(null)
  }, [workspacePath, refresh])

  if (snapshots.length === 0) return null

  const restore = async (snap: UndoSnapshotMeta) => {
    setBusyRef(snap.name)
    try {
      const outcome = await restoreUndoSnapshot(workspacePath, snap.name)
      if (!outcome.ok) {
        toast.error(outcome.conflictMessage ?? t('undo.restoreFailed'))
      } else if (outcome.conflictedFiles.length > 0) {
        toast.warning(t('undo.restoreConflict', { count: outcome.conflictedFiles.length }))
      } else {
        toast.success(t('undo.restored'))
      }
      await refresh()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusyRef(null)
    }
  }

  const drop = async (snap: UndoSnapshotMeta) => {
    // 两步确认：第二次点击才真删（快照是唯一后悔药，防误触）
    if (confirmDropRef !== snap.name) {
      setConfirmDropRef(snap.name)
      return
    }
    setConfirmDropRef(null)
    setBusyRef(snap.name)
    try {
      await dropUndoSnapshot(workspacePath, snap.name)
      await refresh()
    } catch (err) {
      toast.error(String(err))
    } finally {
      setBusyRef(null)
    }
  }

  // 列表后端为倒序（最新在前）；展开最多展示 SHOW_MAX 条
  const visible = expanded ? snapshots.slice(0, SHOW_MAX) : snapshots.slice(0, 1)

  return (
    <div className="px-4 py-2 border-b border-border-subtle bg-background-surface" data-testid="undo-bar">
      <div className="flex items-center gap-1.5 text-xs">
        <HistoryIcon size={12} className="text-text-tertiary" />
        <button
          type="button"
          className="font-semibold text-text-primary flex items-center gap-1 hover:text-primary transition-colors"
          onClick={() => setExpanded((v) => !v)}
          data-testid="undo-bar-toggle"
        >
          {t('undo.title')}
          <span className="text-text-tertiary font-normal">({snapshots.length})</span>
        </button>
        <button
          type="button"
          className="ml-auto p-0.5 text-text-tertiary hover:text-primary rounded transition-colors"
          onClick={() => void refresh()}
          title={t('undo.refresh')}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      <ul className="mt-1.5 space-y-1">
        {visible.map((snap) => (
            <li
              key={snap.name}
              className="flex items-center gap-1.5 text-xs text-text-secondary"
              data-testid="undo-row"
            >
              <span className="text-[11px] text-text-tertiary shrink-0">{formatTime(snap.createdAt)}</span>
              <span className="text-text-primary">
                {t(`undo.ctx.${snap.context}`, { defaultValue: snap.context })}
              </span>
              {snap.branch && <span className="text-[11px] text-text-tertiary truncate">@{snap.branch}</span>}
              {snap.hasChanges && (
                <span className="text-[10px] text-warning shrink-0" title={t('undo.hasChanges')}>
                  ●
                </span>
              )}
              <span className="ml-auto flex items-center gap-0.5 shrink-0">
                <button
                  type="button"
                  className="p-0.5 text-text-tertiary hover:text-primary disabled:opacity-30 transition-colors"
                  disabled={busyRef === snap.name}
                  onClick={() => void restore(snap)}
                  title={t('undo.restore')}
                  data-testid="undo-restore"
                >
                  <Undo2 size={13} />
                </button>
                <button
                  type="button"
                  className={`p-0.5 transition-colors disabled:opacity-30 ${
                    confirmDropRef === snap.name ? 'text-danger hover:text-danger' : 'text-text-tertiary hover:text-danger'
                  }`}
                  disabled={busyRef === snap.name}
                  onClick={() => void drop(snap)}
                  title={confirmDropRef === snap.name ? t('undo.dropConfirm') : t('undo.drop')}
                  data-testid="undo-drop"
                >
                  <Trash2 size={13} />
                </button>
              </span>
            </li>
          ))}
        {snapshots.length > visible.length && (
          <li className="text-[10px] text-text-tertiary">
            {t('undo.more', { count: snapshots.length - visible.length })}
          </li>
        )}
      </ul>
    </div>
  )
}
