/**
 * 高级操作 Slice
 *
 * 负责 Cherry-pick 和 Revert 等高级 Git 操作
 */

import { invoke } from '@/services/transport'
import type { AdvancedSlice } from './types'
import { parseGitError } from './types'
import type { GitCherryPickResult, GitRevertResult } from '@/types/git'

/**
 * 创建高级操作 Slice
 */
export const createAdvancedSlice: AdvancedSlice = (set, get) => ({
  // ===== 方法（无状态） =====

  // Cherry-pick 提交
  async cherryPick(workspacePath: string, commitSha: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitCherryPickResult>('git_cherry_pick', {
        workspacePath,
        commitSha,
      })

      // 刷新状态和提交历史
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 中止 Cherry-pick
  async cherryPickAbort(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_cherry_pick_abort', {
        workspacePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 继续 Cherry-pick
  async cherryPickContinue(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitCherryPickResult>('git_cherry_pick_continue', {
        workspacePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // Revert 提交
  async revert(workspacePath: string, commitSha: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitRevertResult>('git_revert', {
        workspacePath,
        commitSha,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 中止 Revert
  async revertAbort(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_revert_abort', {
        workspacePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 继续 Revert
  async revertContinue(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitRevertResult>('git_revert_continue', {
        workspacePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // Git Reset
  async reset(workspacePath: string, mode: 'soft' | 'mixed' | 'hard', commitSha: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_reset', {
        workspacePath,
        mode,
        commitSha,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})
