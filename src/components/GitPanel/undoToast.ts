/**
 * 危险操作成功 toast 的「撤销」按钮联动（A3，FR-P2-3 复债清偿）
 *
 * - 危险操作（discard/reset_hard/checkout/rebase/branch_delete）成功后，
 *   拉一次该 workspace 的撤销快照列表；存在快照 → toast.success 携「撤销」action。
 * - 点击 action 走 undoSlice.restoreUndoSnapshot（同 UndoBar 一键恢复路径，
 *   冲突分级 toast ok/conflict/error 完全复用既有语义）。
 * - 快照不可得 / 恢复入口抛错 → 降级为普通 success toast，不阻断主流程。
 */

import { useGitStore } from '@/stores/gitStore'
import { useToastStore } from '@/stores/toastStore'
import i18n from '@/i18n'
import type { UndoSnapshotMeta } from '@/types/git'

const tGit = (key: string, vars?: Record<string, unknown>) =>
  i18n.t(key, { ns: 'git', ...(vars ?? {}) })

export async function toastWithUndo(workspacePath: string, title: string, message?: string): Promise<void> {
  const toast = useToastStore.getState()

  let snap: UndoSnapshotMeta | undefined
  try {
    await useGitStore.getState().listUndoSnapshots(workspacePath)
    const st = useGitStore.getState()
    snap = (st.undoSnapshotsByWs?.[workspacePath] ?? st.undoSnapshots ?? [])[0]
  } catch {
    snap = undefined
  }

  if (!snap) {
    toast.success(title, message)
    return
  }

  toast.addToast({
    type: 'success',
    title,
    message,
    duration: 8000,
    action: {
      label: tGit('undo.toastUndoLabel'),
      onClick: async () => {
        const snapshotRef = snap!.name
        const git = useGitStore.getState()
        const toasts = useToastStore.getState()
        try {
          const outcome = await git.restoreUndoSnapshot(workspacePath, snapshotRef)
          if (!outcome.ok) {
            toasts.error(outcome.conflictMessage ?? tGit('undo.restoreFailed'))
          } else if (outcome.conflictedFiles.length > 0) {
            toasts.warning(tGit('undo.restoreConflict', { count: outcome.conflictedFiles.length }))
          } else {
            toasts.success(tGit('undo.restored'))
          }
          await git.listUndoSnapshots(workspacePath)
        } catch (err) {
          toasts.error(String(err))
        }
      },
    },
  })
}
