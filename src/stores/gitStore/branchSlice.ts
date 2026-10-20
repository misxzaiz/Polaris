/**
 * 分支操作 Slice
 *
 * 负责分支管理：创建、删除、切换、合并、变基等操作
 */

import { invoke } from '@/services/transport'
import type { BranchSlice } from './types'
import { parseGitError } from './types'
import type { BranchState } from './types'
import type {
  GitMergeResult, GitRebasePlan, GitRebaseSuggestion, GitRebaseResult, GitRebaseTodoItem,
} from '@/types/git'

/**
 * 创建分支操作 Slice
 */
export const createBranchSlice: BranchSlice = (set, get) => ({
  // ===== 状态 =====
  branches: [],

  // ===== 方法 =====

  // 获取分支列表
  async getBranches(workspacePath: string) {
    // P1.5 分片：keyed 域随返回写入（旧 branches 镜像保留给未迁移 UI）
    const setBranches = (branches: import('@/types/git').GitBranch[]) => {
      set({
        branches,
        branchesByWs: { ...(get() as BranchState).branchesByWs, [workspacePath]: branches },
      })
    }

    try {
      const branches = await invoke<import('@/types/git').GitBranch[]>('git_get_branches', {
        workspacePath,
      })

      setBranches(branches)
    } catch (err) {
      set({ error: parseGitError(err), branches: [] })
      setBranches([])
    }
  },

  // 创建分支
  async createBranch(workspacePath: string, name: string, checkout = false, startPoint?: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_create_branch', {
        workspacePath,
        name,
        checkout,
        startPoint,
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

  // 面板化 Interactive Rebase：拉取预览计划（只读，只 guard 不改仓库）
  async planInteractiveRebase(workspacePath: string, baseCommitish: string) {
    return invoke<GitRebasePlan>('git_plan_interactive_rebase', {
      workspacePath,
      baseCommitish,
    })
  },

  // 面板化 Interactive Rebase：确认执行（写类；冲突走后续 rebase_continue + 冲突合并器闭环）
  async startInteractiveRebase(
    workspacePath: string,
    baseCommitish: string,
    todos: GitRebaseTodoItem[],
    autosquash: boolean,
  ) {
    set({ isLoading: true, error: null })
    try {
      const result = await invoke<GitRebaseResult>('git_start_interactive_rebase', {
        workspacePath,
        baseCommitish,
        todos,
        autosquash,
      })
      await get().refreshStatus(workspacePath)
      await get().getBranches(workspacePath)
      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // P3 AI-8：fixup!/squash! 整理建议（只读，纯本地；建议序列可直接喂 startInteractiveRebase）
  async suggestRebaseTodos(workspacePath: string, baseCommitish: string) {
    return invoke<GitRebaseSuggestion>('git_suggest_rebase_todos', {
      workspacePath,
      baseCommitish,
    })
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
