/**
 * 分支操作 Slice
 *
 * 负责分支管理：创建、删除、切换、合并、变基等操作
 */

import { invoke } from '@/services/transport'
import type { BranchSlice } from './types'
import { parseGitError } from './types'
import type { GitMergeResult, GitRebaseResult } from '@/types/git'

/**
 * 创建分支操作 Slice
 */
export const createBranchSlice: BranchSlice = (set, get) => ({
  // ===== 状态 =====
  branches: [],

  // ===== 方法 =====

  // 获取分支列表
  async getBranches(workspacePath: string) {
    try {
      const branches = await invoke<import('@/types/git').GitBranch[]>('git_get_branches', {
        workspacePath,
      })

      set({ branches })
    } catch (err) {
      set({ error: parseGitError(err), branches: [] })
    }
  },

  // 创建分支
  async createBranch(workspacePath: string, name: string, checkout = false) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_create_branch', {
        workspacePath,
        name,
        checkout,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 删除分支
  async deleteBranch(workspacePath: string, name: string, force = false) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_delete_branch', {
        workspacePath,
        name,
        force,
      })

      // 刷新分支列表
      await get().getBranches(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 重命名分支
  async renameBranch(workspacePath: string, oldName: string, newName: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_rename_branch', {
        workspacePath,
        oldName,
        newName,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 切换分支
  async checkoutBranch(workspacePath: string, name: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_checkout_branch', {
        workspacePath,
        name,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 合并分支
  async mergeBranch(workspacePath: string, sourceBranch: string, noFF = false) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitMergeResult>('git_merge_branch', {
        workspacePath,
        sourceBranch,
        noFF,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 变基分支
  async rebaseBranch(workspacePath: string, sourceBranch: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitRebaseResult>('git_rebase_branch', {
        workspacePath,
        sourceBranch,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 中止变基
  async rebaseAbort(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_rebase_abort', {
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

  // 继续变基
  async rebaseContinue(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitRebaseResult>('git_rebase_continue', {
        workspacePath,
      })

      // 刷新状态和分支列表
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})
