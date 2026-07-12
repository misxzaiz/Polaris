/**
 * Tag 操作 Slice
 *
 * 负责标签管理：创建、删除、获取列表
 */

import { invoke } from '@/services/transport'
import type { TagSlice } from './types'
import { parseGitError } from './types'
import type { GitTag } from '@/types/git'

/**
 * 创建 Tag 操作 Slice
 */
export const createTagSlice: TagSlice = (set, get) => ({
  // ===== 状态 =====
  tags: [],

  // ===== 方法 =====

  // 获取标签列表
  async getTags(workspacePath: string) {
    try {
      const tags = await invoke<GitTag[]>('git_get_tags', {
        workspacePath,
      })

      set({ tags })
      return tags
    } catch (err) {
      set({ error: parseGitError(err), tags: [] })
      return []
    }
  },

  // 创建标签
  async createTag(workspacePath: string, name: string, commitish?: string, message?: string) {
    set({ isLoading: true, error: null })

    try {
      const tag = await invoke<GitTag>('git_create_tag', {
        workspacePath,
        name,
        commitish: commitish || null,
        message: message || null,
      })

      // 刷新标签列表
      await get().getTags(workspacePath)

      set({ isLoading: false })
      return tag
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 删除标签
  async deleteTag(workspacePath: string, name: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_delete_tag', {
        workspacePath,
        name,
      })

      // 刷新标签列表
      await get().getTags(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },
})
