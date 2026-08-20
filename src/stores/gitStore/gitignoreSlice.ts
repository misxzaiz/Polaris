/**
 * Gitignore 操作 Slice
 *
 * 负责 .gitignore 文件管理
 */

import { invoke } from '@/services/transport'
import type { GitignoreSlice } from './types'
import { parseGitError } from './types'
import type { GitIgnoreResult, GitIgnoreTemplate } from '@/types/git'
import { createLogger } from '@/utils/logger'

/**
 * 创建 Gitignore 操作 Slice
 */
const log = createLogger('GitGitignoreSlice')

export const createGitignoreSlice: GitignoreSlice = (set, get) => ({
  // ===== 方法（无状态） =====

  // 获取 .gitignore 文件内容
  async getGitignore(workspacePath: string) {
    try {
      const result = await invoke<GitIgnoreResult>('git_get_gitignore', {
        workspacePath,
      })
      return result
    } catch (err) {
      throw new Error(parseGitError(err))
    }
  },

  // 保存 .gitignore 文件内容
  async saveGitignore(workspacePath: string, content: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_save_gitignore', {
        workspacePath,
        content,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 添加忽略规则到 .gitignore
  async addToGitignore(workspacePath: string, rules: string[]) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_add_to_gitignore', {
        workspacePath,
        rules,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 获取常用忽略规则模板
  async getGitignoreTemplates() {
    try {
      const templates = await invoke<GitIgnoreTemplate[]>('git_get_gitignore_templates')
      return templates
    } catch (err) {
      log.error('getGitignoreTemplates failed:', err instanceof Error ? err : new Error(String(err)))
      return []
    }
  },
})
