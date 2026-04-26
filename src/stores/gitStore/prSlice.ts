/**
 * PR 操作 Slice
 *
 * 负责 Pull Request 相关操作
 */

import { invoke } from '@/services/transport'
import type { PRSlice } from './types'
import { parseGitError } from './types'
import type { PullRequest, CreatePROptions } from '@/types/git'

/**
 * 创建 PR 操作 Slice
 */
export const createPRSlice: PRSlice = (set, _get) => ({
  // ===== 状态 =====
  currentPR: null,

  // ===== 方法 =====

  // 创建 PR
  async createPR(workspacePath: string, options: CreatePROptions) {
    set({ isLoading: true, error: null })

    try {
      const pr = await invoke<PullRequest>('git_create_pr', {
        workspacePath,
        options,
      })

      set({ currentPR: pr, isLoading: false })
      return pr
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false, currentPR: null })
      throw err
    }
  },

  // 获取 PR 状态
  async getPRStatus(workspacePath: string, prNumber: number) {
    set({ isLoading: true, error: null })

    try {
      const pr = await invoke<PullRequest>('git_get_pr_status', {
        workspacePath,
        prNumber,
      })

      set({ currentPR: pr, isLoading: false })
      return pr
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})
