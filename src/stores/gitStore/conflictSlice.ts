/**
 * 冲突合并器 Slice（P3：序列操作机 + 冲突合并器）
 *
 * 后端 cap.git `get_conflict_state` 归一探测当前序列操作
 * （merge/rebase/cherry-pick/revert 四合一 + 冲突条目 + rebase 步数回读）。
 *
 * 本 slice 负责：
 * - getConflictState：拉取序列状态，按 ws 分片缓存（只读，不进操作流水/撤销快照）
 * - mergerOpen: 合并器对话框打开状态（独立对话框 + 编辑器内嵌两形态由组件控制）
 *
 * 数据域按 wsPath 分片（对齐 P1.5 sharded 约定），多面板/多仓互不覆盖。
 */

import { invoke } from '@/services/transport'
import type { ConflictSlice } from './types'
import { parseGitError } from './types'
import type { GitSequenceState } from '@/types/git'

/**
 * 创建冲突合并器 Slice
 */
export const createConflictSlice: ConflictSlice = (set, get) => ({
  // ===== 状态 =====
  sequenceStatesByWs: {},
  mergerOpen: null,

  // ===== 方法 =====

  // 拉取某 workspace 的序列操作状态（失败置空态不抛错，表格显示空态）
  async getConflictState(workspacePath: string) {
    try {
      const state = await invoke<GitSequenceState>('git_get_conflict_state', {
        workspacePath,
      })
      set({
        sequenceStatesByWs: {
          ...(get().sequenceStatesByWs ?? {}),
          [workspacePath]: state,
        },
      })
      return state
    } catch (err) {
      set({ error: parseGitError(err) })
      return null
    }
  },

  // 打开合并器（独立对话框形态；file 缺省 = 打开文件列表）
  openMerger(wsPath: string, file?: string) {
    set({ mergerOpen: { wsPath, file } })
  },

  // 关闭合并器
  closeMerger() {
    set({ mergerOpen: null })
  },

  // ===== 冲突文件解决（三态，走 cap.git git_resolve_conflict_file）=====

  // 写类解决：编辑器拼合结果 / 删类「保留修改」文本 → 写盘 + add（stage0 取代冲突 stages）
  async resolveConflictFile(workspacePath: string, filePath: string, content: string) {
    try {
      await invoke('git_resolve_conflict_file', {
        workspacePath,
        filePath,
        content,
      })
      await get().refreshStatus(workspacePath)
      return true
    } catch (err) {
      set({ error: parseGitError(err) })
      throw err
    }
  },

  // 删类解决：接受删除（删盘上文件 + 移除 index 冲突 stages）
  async removeConflictFile(workspacePath: string, filePath: string) {
    try {
      await invoke('git_resolve_conflict_file', {
        workspacePath,
        filePath,
        remove: true,
      })
      await get().refreshStatus(workspacePath)
      return true
    } catch (err) {
      set({ error: parseGitError(err) })
      throw err
    }
  },

  // 整文件取舍：还原指定侧 stage 内容（binary / delete-modify 的「保留某侧」）
  async checkoutConflictSide(workspacePath: string, filePath: string, side: 'ours' | 'theirs') {
    try {
      await invoke('git_resolve_conflict_file', {
        workspacePath,
        filePath,
        side,
      })
      await get().refreshStatus(workspacePath)
      return true
    } catch (err) {
      set({ error: parseGitError(err) })
      throw err
    }
  },
})