/**
 * 工具方法 Slice
 *
 * 负责 Git 工具方法：检查仓库、初始化、Blame 等
 */

import { invoke } from '@/services/transport'
import type { UtilitySlice } from './types'
import { parseGitError } from './types'
import type { GitBlameResult } from '@/types/git'

/**
 * 创建工具方法 Slice
 */
export const createUtilitySlice: UtilitySlice = (set, get) => ({
  // ===== 方法（无状态） =====

  // 检查是否为 Git 仓库
  async isRepository(workspacePath: string) {
    try {
      return await invoke<boolean>('git_is_repository', { workspacePath })
    } catch {
      return false
    }
  },

  // 初始化仓库
  async initRepository(workspacePath: string, initialBranch = 'main') {
    set({ isLoading: true, error: null })

    try {
      const commit = await invoke<string>('git_init_repository', {
        workspacePath,
        initialBranch,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return commit
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 获取文件 Blame 信息
  async blameFile(workspacePath: string, filePath: string) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitBlameResult>('git_blame_file', {
        workspacePath,
        filePath,
      })

      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // P1：读取 reflog（branch 省略 = HEAD；一键恢复由 UI 调 checkoutCommit 完成）
  async getReflog(workspacePath: string, branch?: string | null, limit = 30) {
    try {
      return await invoke<import('@/types/git').GitReflogEntry[]>('git_get_reflog', {
        workspacePath,
        branch: branch || null,
        limit,
      })
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },
})
