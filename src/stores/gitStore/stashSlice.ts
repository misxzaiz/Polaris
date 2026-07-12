/**
 * Stash 操作 Slice
 *
 * 负责 Git Stash 管理：保存、应用、删除
 */

import { invoke } from '@/services/transport'
import type { StashSlice } from './types'
import { parseGitError } from './types'
import type { GitStashEntry } from '@/types/git'

/**
 * 创建 Stash 操作 Slice
 */
export const createStashSlice: StashSlice = (set, get) => ({
  // ===== 状态 =====
  stashList: [],

  // ===== 方法 =====

  // 保存 Stash
  async stashSave(
    workspacePath: string,
    message?: string,
    includeUntracked = false
  ) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<string>('git_stash_save', {
        workspacePath,
        message: message || null,
        includeUntracked,
      })
      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 应用 Stash
  async stashPop(workspacePath: string, index?: number) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_stash_pop', {
        workspacePath,
        index: index ?? null,
      })
      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 删除 Stash
  async stashDrop(workspacePath: string, index: number) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_stash_drop', {
        workspacePath,
        index,
      })
      const stashList = await invoke<GitStashEntry[]>('git_stash_list', {
        workspacePath,
      })
      set({ stashList, isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 获取 Stash 列表
  async getStashList(workspacePath: string) {
    try {
      const stashList = await invoke<GitStashEntry[]>('git_stash_list', {
        workspacePath,
      })
      set({ stashList })
      return stashList
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },
})
