/**
 * 冲突预测 Slice（FR-P2-AI4：fetch 后确定性风险清单，0 token）
 *
 * 后端 cap.git `predict_conflicts` 在 fetch 后确定性计算
 * 「对方 ahead commits 涉及的文件 ∩ 本地 modified 文件」，纯 git2 只读、
 * 0 token 消耗（AI 解释层已由 master-plan §1.2 砍掉，仅保留规则建议）。
 *
 * 本 slice 负责：
 * - predictConflicts：fetch / pull 后主动调用，填充本 ws 的冲突预测结果
 *
 * 数据域按 wsPath 分片（对齐 P1.5 sharded 约定），双面板/多仓互不覆盖。
 * 只读动作，不进操作流水/撤销快照。
 */

import { invoke } from '@/services/transport'
import type { ConflictPredictSlice } from './types'
import { parseGitError } from './types'
import type { GitConflictPrediction } from '@/types/git'

/**
 * 创建冲突预测 Slice
 */
export const createConflictPredictSlice: ConflictPredictSlice = (set, get) => ({
  // ===== 状态 =====
  conflictPrediction: null,
  conflictPredictionsByWs: {},

  // ===== 方法 =====

  // 预测某 workspace 的冲突风险（branch 缺省 = 当前 HEAD 分支）
  async predictConflicts(workspacePath: string, branch?: string) {
    try {
      const prediction = await invoke<GitConflictPrediction>('git_predict_conflicts', {
        workspacePath,
        ...(branch != null && branch.trim() ? { branch } : {}),
      })
      // P1.5 分片：keyed 写 + 旧镜像域保留
      set({
        conflictPrediction: prediction,
        conflictPredictionsByWs: {
          ...(get().conflictPredictionsByWs ?? {}),
          [workspacePath]: prediction,
        },
      })
      return prediction
    } catch (err) {
      set({ error: parseGitError(err) })
      return null
    }
  },
})
