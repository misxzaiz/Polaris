/**
 * 操作流水 Slice（FR-P2-4：写动作留痕，GitKraken Activity Log 等价）
 *
 * 后端 cap.git 在每次写动作（commit/discard/reset/checkout/undo…）执行后统一收口
 * 记录一条流水（时间 + 操作名 + 耗时 + 来源 + 成败），并经 `git-operation` 事件
 * 实时推送到前端。本 slice 负责：
 * - getOperations：初始拉取（面板打开 / 切换仓库时填充）
 * - clearOperations：清空本 ws 流水（写类动作，清空后本地置空）
 *
 * 数据域按 wsPath 分片（对齐 P1.5 sharded 约定），双面板/多仓互不覆盖。
 */

import { invoke } from '@/services/transport'
import type { OperationsSlice } from './types'
import { parseGitError } from './types'
import type { GitOperationEntry } from '@/types/git'

/**
 * 创建操作流水 Slice
 */
export const createOperationsSlice: OperationsSlice = (set, get) => ({
  // ===== 状态 =====
  operations: [],
  operationsByWs: {},

  // ===== 方法 =====

  // 拉取某 workspace 的操作流水（倒序，上限 50/ws）
  async getOperations(workspacePath: string) {
    try {
      const entries = await invoke<GitOperationEntry[]>('git_get_operations', {
        workspacePath,
      })
      // P1.5 分片：keyed 写 + 旧镜像域保留
      set({
        operations: entries,
        operationsByWs: {
          ...(get().operationsByWs ?? {}),
          [workspacePath]: entries,
        },
      })
      return entries
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },

  // 清空某 workspace 的操作流水（写类动作，后端会记录一条「清空」到流水）
  async clearOperations(workspacePath: string) {
    set({ isLoading: true, error: null })
    try {
      await invoke('git_clear_operations', {
        workspacePath,
      })
      // 清空后本地置空（后端已记录「清空操作流水」一条，后续事件会补上来）
      set({
        operations: [],
        operationsByWs: { ...(get().operationsByWs ?? {}), [workspacePath]: [] },
        isLoading: false,
      })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})
