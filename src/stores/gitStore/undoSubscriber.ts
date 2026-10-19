/**
 * FR-P2-3 · Undo 通知条订阅
 *
 * 消费后端 `git-undo-snapshot` 事件（cap.git 危险操作成功后 emit），弹出
 * toast「撤销」通知条：
 * - 事件载荷携带 wsPath + snapshotRef（每次到达独立，无陈旧闭包问题）
 * - 点击「撤销」→ restoreUndoSnapshot（stash apply / 重建被删分支 ref），
 *   成功后自动刷新 status/branches/log（undoSlice 内已做）；遇冲突 toast.error 提示
 * - toast 常驻 20s（撤销操作不紧迫，比 error 短比 info 长），可手动关闭
 *
 * 边界（见 plans/git-panel-p2-undo-spec.md §四）：
 * - 不做快照比对/自动恢复（P3 冲突合并器）；仅通知 + 一键恢复入口
 * - 恢复失败（冲突等）不抛 alert，以 toast.error 平铺展示 conflictedFiles
 */

import { listen } from '@/services/transport'
import { useToastStore } from '@/stores/toastStore'
import { useGitStore } from '@/stores/gitStore'
import { createLogger } from '@/utils/logger'
import type { UndoSnapshotEvent } from '@/types/git'

/** transport.listen 返回的取消监听函数 */
type UnlistenFn = () => void

const log = createLogger('GitUndoSubscriber')

/** 「撤销」通知条内触发操作的中文文案（按 context 呈现） */
const CONTEXT_LABEL: Record<string, string> = {
  discard: '丢弃变更',
  reset_hard: '硬重置',
  checkout: '切换分支/提交',
  branch_delete: '删除分支',
  rebase: '变基',
  undo: '操作',
}

const contextLabel = (context: string): string => CONTEXT_LABEL[context] ?? 'git 操作'

/**
 * 订阅 git-undo-snapshot → toast「撤销」。
 * @returns 清理函数（取消监听）
 */
export function initUndoToastSubscriber(): () => void {
  let unlisten: UnlistenFn | null = null
  let disposed = false

  const onUndoSnapshot = (event: UndoSnapshotEvent) => {
    if (disposed) return
    const { wsPath, snapshotRef, context } = event
    if (!wsPath || !snapshotRef) {
      log.warn('git-undo-snapshot 载荷不完整，跳过', {
        wsPath,
        snapshotRef,
        context,
      })
      return
    }

    const toast = useToastStore.getState()
    toast.addToast({
      type: 'info',
      // 例：已撤销「丢弃变更」—— 可一键恢复
      title: `已${contextLabel(context)}，可一键撤销`,
      message: context === 'branch_delete'
        ? '分支已删除，可恢复其提交与工作区状态'
        : '已自动保存操作前快照，可恢复至操作前状态',
      duration: 20000,
      action: {
        label: '撤销',
        onClick: () => {
          void useGitStore.getState()
            .restoreUndoSnapshot(wsPath, snapshotRef)
            .then((outcome) => {
              if (outcome.ok) {
                useToastStore.getState().success('撤销成功', '已恢复到操作前状态')
              } else {
                const files = (outcome.conflictedFiles ?? []).join('、')
                useToastStore.getState().error(
                  '撤销遇到冲突',
                  outcome.conflictMessage
                    ?? `以下文件冲突，请手动处理：${files || '未知'}`
                )
              }
            })
            .catch((err) => {
              log.error('撤销快照恢复失败', err)
              useToastStore.getState().error('撤销失败', String(err?.message ?? err))
            })
        },
      },
    })
  }

  listen<UndoSnapshotEvent>('git-undo-snapshot', onUndoSnapshot).then((fn) => {
    if (disposed) {
      fn()
      return
    }
    unlisten = fn
  })

  return () => {
    disposed = true
    unlisten?.()
    unlisten = null
  }
}