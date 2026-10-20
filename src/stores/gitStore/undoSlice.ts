/**
 * Undo 网络 Slice（FR-P2-3：危险操作快照 + 一键恢复）
 *
 * 危险操作（discard/reset hard/checkout/删分支/rebase）执行前，后端 cap.git
 * 自动创建 git-native 快照 ref（refs/polaris-undo/<ws>/<ts>），成功后 emit
 * `git-undo-snapshot` 事件 → 前端 toast「撤销」按钮。本 slice 负责：
 * - listUndoSnapshots：快照列表（通知条下拉 / 恢复面板数据源）
 * - restoreUndoSnapshot：一键恢复（stash apply / 重建被删分支 ref）
 * - dropUndoSnapshot：手动清理快照
 *
 * 数据域按 wsPath 分片（对齐 P1.5 sharded 约定），双面板/多仓互不覆盖。
 */

import { invoke } from '@/services/transport'
import type { UndoSlice } from './types'
import { parseGitError } from './types'
import type {
  UndoSnapshotMeta,
  UndoRestoreOutcome,
} from '@/types/git'

/**
 * 创建 Undo 网络 Slice
 */
export const createUndoSlice: UndoSlice = (set, get) => ({
  // ===== 状态 =====
  undoSnapshots: [],
  undoSnapshotsByWs: {},

  // ===== 方法 =====

  // 列出某 workspace 的全部撤销快照（倒序按时间）
  async listUndoSnapshots(workspacePath: string) {
    try {
      const snapshots = await invoke<UndoSnapshotMeta[]>('git_undo_list', {
        workspacePath,
      })
      // P1.5 分片：keyed 写 + 旧镜像域保留
      set({
        undoSnapshots: snapshots,
        undoSnapshotsByWs: {
          ...(get().undoSnapshotsByWs ?? {}),
          [workspacePath]: snapshots,
        },
      })
      return snapshots
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },

  // 一键恢复（stash apply / 重建被删分支 ref；遇冲突返回 conflictedFiles 不抛错）
  async restoreUndoSnapshot(
    workspacePath: string,
    snapshotRef: string
  ): Promise<UndoRestoreOutcome> {
    set({ isLoading: true, error: null })
    try {
      const outcome = await invoke<UndoRestoreOutcome>('git_undo_restore', {
        workspacePath,
        snapshotRef,
      })
      // 恢复改变了工作区/分支/历史 → 全量刷新
      await Promise.allSettled([
        get().refreshStatus(workspacePath),
        get().getBranches(workspacePath),
        get().getLogWithLanes(workspacePath),
      ])
      set({ isLoading: false })
      return outcome
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 手动清理快照（连同 .restore. note ref）
  async dropUndoSnapshot(workspacePath: string, snapshotRef: string) {
    set({ isLoading: true, error: null })
    try {
      await invoke('git_undo_drop', {
        workspacePath,
        snapshotRef,
      })
      // 同步移除本地缓存项
      const cur = get().undoSnapshotsByWs?.[workspacePath] ?? []
      const next = cur.filter((s) => s.name !== snapshotRef)
      set({
        undoSnapshots: next,
        undoSnapshotsByWs: { ...(get().undoSnapshotsByWs ?? {}), [workspacePath]: next },
        isLoading: false,
      })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})