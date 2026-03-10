/**
 * Git Store
 *
 * Git 操作的状态管理
 */

import { create } from 'zustand'
import { invoke } from '@tauri-apps/api/core'
import type {
  GitRepositoryStatus,
  GitDiffEntry,
  GitBranch,
  GitRemote,
  GitHostType,
  PullRequest,
  CreatePROptions,
  GitPullResult,
  GitPushResult,
  GitMergeResult,
  GitRebaseResult,
  GitCherryPickResult,
  GitRevertResult,
  GitCommit,
  GitTag,
  BatchStageResult,
  GitStashEntry,
  GitError,
} from '@/types/git'

function parseGitError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'object' && err !== null) {
    const gitErr = err as GitError
    if (gitErr.message) {
      return gitErr.details 
        ? `${gitErr.message} (${gitErr.details})`
        : gitErr.message
    }
    try {
      return JSON.stringify(err)
    } catch {
      return '[object Object]'
    }
  }
  return String(err)
}

interface GitState {
  // 状态数据
  status: GitRepositoryStatus | null
  diffs: GitDiffEntry[]
  worktreeDiffs: GitDiffEntry[]
  indexDiffs: GitDiffEntry[]
  branches: GitBranch[]
  remotes: GitRemote[]
  tags: GitTag[]
  currentPR: PullRequest | null
  commits: GitCommit[]
  stashList: GitStashEntry[]

  // UI 状态
  isLoading: boolean
  error: string | null
  selectedFilePath: string | null
  selectedDiff: GitDiffEntry | null

  // 内部状态（用于防抖和请求管理）
  _refreshPromises: Map<string, Promise<void>>
  _refreshTimeouts: Map<string, NodeJS.Timeout>

  // 操作方法
  refreshStatus: (workspacePath: string) => Promise<void>
  refreshStatusDebounced: (workspacePath: string, delay?: number) => Promise<void>
  getDiffs: (workspacePath: string, baseCommit: string) => Promise<void>
  getWorktreeDiff: (workspacePath: string) => Promise<void>
  getIndexDiff: (workspacePath: string) => Promise<void>
  getWorktreeFileDiff: (workspacePath: string, filePath: string) => Promise<GitDiffEntry>
  getIndexFileDiff: (workspacePath: string, filePath: string) => Promise<GitDiffEntry>
  getBranches: (workspacePath: string) => Promise<void>
  getRemotes: (workspacePath: string) => Promise<void>
  getTags: (workspacePath: string) => Promise<GitTag[]>
  getLog: (workspacePath: string, limit?: number, skip?: number, branch?: string) => Promise<GitCommit[]>
  getStashList: (workspacePath: string) => Promise<GitStashEntry[]>

  // Git 操作
  isRepository: (workspacePath: string) => Promise<boolean>
  initRepository: (workspacePath: string, initialBranch?: string) => Promise<string>
  createBranch: (workspacePath: string, name: string, checkout?: boolean) => Promise<void>
  deleteBranch: (workspacePath: string, name: string, force?: boolean) => Promise<void>
  renameBranch: (workspacePath: string, oldName: string, newName: string) => Promise<void>
  mergeBranch: (workspacePath: string, sourceBranch: string, noFF?: boolean) => Promise<GitMergeResult>
  rebaseBranch: (workspacePath: string, sourceBranch: string) => Promise<GitRebaseResult>
  rebaseAbort: (workspacePath: string) => Promise<void>
  rebaseContinue: (workspacePath: string) => Promise<GitRebaseResult>
  cherryPick: (workspacePath: string, commitSha: string) => Promise<GitCherryPickResult>
  cherryPickAbort: (workspacePath: string) => Promise<void>
  cherryPickContinue: (workspacePath: string) => Promise<GitCherryPickResult>
  revert: (workspacePath: string, commitSha: string) => Promise<GitRevertResult>
  revertAbort: (workspacePath: string) => Promise<void>
  revertContinue: (workspacePath: string) => Promise<GitRevertResult>
  checkoutBranch: (workspacePath: string, name: string) => Promise<void>
  commitChanges: (workspacePath: string, message: string, stageAll?: boolean, selectedFiles?: string[]) => Promise<string>
  stageFile: (workspacePath: string, filePath: string) => Promise<void>
  unstageFile: (workspacePath: string, filePath: string) => Promise<void>
  discardChanges: (workspacePath: string, filePath: string) => Promise<void>
  detectHostAsync: (remoteUrl: string) => Promise<GitHostType>
  batchStage: (workspacePath: string, filePaths: string[]) => Promise<BatchStageResult>

  // 远程操作
  addRemote: (workspacePath: string, name: string, url: string) => Promise<GitRemote>
  removeRemote: (workspacePath: string, name: string) => Promise<void>
  push: (workspacePath: string, branchName: string, remoteName?: string, force?: boolean, setUpstream?: boolean) => Promise<GitPushResult>
  pull: (workspacePath: string, remoteName?: string, branchName?: string) => Promise<GitPullResult>

  // Stash 操作
  stashSave: (workspacePath: string, message?: string, includeUntracked?: boolean) => Promise<string>
  stashPop: (workspacePath: string, index?: number) => Promise<void>
  stashDrop: (workspacePath: string, index: number) => Promise<void>

  // PR 操作
  createPR: (workspacePath: string, options: CreatePROptions) => Promise<PullRequest>
  getPRStatus: (workspacePath: string, prNumber: number) => Promise<PullRequest>

  // 工具方法
  clearError: () => void
  hasChanges: () => boolean
  getChangedFiles: () => string[]
  setSelectedFilePath: (path: string | null) => void
  clearAll: () => void
  setSelectedDiff: (diff: GitDiffEntry | null) => void
}

export const useGitStore = create<GitState>((set, get) => ({
  // 初始状态
  status: null,
  diffs: [],
  worktreeDiffs: [],
  indexDiffs: [],
  branches: [],
  remotes: [],
  tags: [],
  currentPR: null,
  commits: [],
  stashList: [],
  isLoading: false,
  error: null,
  selectedFilePath: null,
  selectedDiff: null,

  // 内部状态初始化
  _refreshPromises: new Map(),
  _refreshTimeouts: new Map(),

  // 刷新仓库状态
  async refreshStatus(workspacePath: string) {
    console.log('[GitStore] refreshStatus 开始', { workspacePath })
    set({ isLoading: true, error: null })

    try {
      console.log('[GitStore] 调用 git_get_status', { workspacePath })
      const status = await invoke<GitRepositoryStatus>('git_get_status', {
        workspacePath,
      })

      console.log('[GitStore] git_get_status 成功', { status })
      set({ status, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      console.error('[GitStore] git_get_status 失败', {
        workspacePath,
        error: message,
        rawError: err,
      })
      set({
        error: message,
        isLoading: false,
        status: null,
      })
    }
  },

  // 防抖的 Git 状态刷新
  async refreshStatusDebounced(workspacePath: string, delay = 500) {
    const state = get()

    // 清除已有的定时器
    const existingTimeout = state._refreshTimeouts.get(workspacePath)
    if (existingTimeout) {
      clearTimeout(existingTimeout)
      state._refreshTimeouts.delete(workspacePath)
    }

    // 创建新的防抖Promise
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(async () => {
        try {
          await get().refreshStatus(workspacePath)
        } finally {
          // 清理
          const currentState = get()
          currentState._refreshTimeouts.delete(workspacePath)
          currentState._refreshPromises.delete(workspacePath)
          resolve()
        }
      }, delay)

      // 保存定时器和Promise
      set({
        _refreshTimeouts: new Map(state._refreshTimeouts).set(workspacePath, timeout)
      })
    })
  },

  // 获取 Diff (HEAD vs base commit)
  async getDiffs(workspacePath: string, baseCommit: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_diffs', {
        workspacePath,
        baseCommit,
      })

      set({ diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        diffs: [],
      })
    }
  },

  // 获取工作区 Diff
  async getWorktreeDiff(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_worktree_diff', {
        workspacePath,
      })

      set({ worktreeDiffs: diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        worktreeDiffs: [],
      })
    }
  },

  // 获取暂存区 Diff
  async getIndexDiff(workspacePath: string) {
    set({ isLoading: true, error: null })

    try {
      const diffs = await invoke<GitDiffEntry[]>('git_get_index_diff', {
        workspacePath,
      })

      set({ indexDiffs: diffs, isLoading: false })
    } catch (err) {
      const message = parseGitError(err)
      set({
        error: message,
        isLoading: false,
        indexDiffs: [],
      })
    }
  },

  // 获取单个文件在工作区的 Diff
  async getWorktreeFileDiff(workspacePath: string, filePath: string) {
    try {
      return await invoke<GitDiffEntry>('git_get_worktree_file_diff', {
        workspacePath,
        filePath,
      })
    } catch (err) {
      throw new Error(parseGitError(err))
    }
  },

  // 获取单个文件在暂存区的 Diff
  async getIndexFileDiff(workspacePath: string, filePath: string) {
    try {
      return await invoke<GitDiffEntry>('git_get_index_file_diff', {
        workspacePath,
        filePath,
      })
    } catch (err) {
      throw new Error(parseGitError(err))
    }
  },

  // 获取分支列表
  async getBranches(workspacePath: string) {
    try {
      const branches = await invoke<GitBranch[]>('git_get_branches', {
        workspacePath,
      })

      set({ branches })
    } catch (err) {
      set({ error: parseGitError(err), branches: [] })
    }
  },

  // 获取远程仓库
  async getRemotes(workspacePath: string) {
    try {
      const remotes = await invoke<GitRemote[]>('git_get_remotes', {
        workspacePath,
      })

      set({ remotes })
    } catch (err) {
      set({ error: parseGitError(err), remotes: [] })
    }
  },

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

  // 添加远程仓库
  async addRemote(workspacePath: string, name: string, url: string) {
    set({ isLoading: true, error: null })

    try {
      const remote = await invoke<GitRemote>('git_add_remote', {
        workspacePath,
        name,
        url,
      })

      // 刷新远程列表
      await get().getRemotes(workspacePath)

      set({ isLoading: false })
      return remote
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 删除远程仓库
  async removeRemote(workspacePath: string, name: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_remove_remote', {
        workspacePath,
        name,
      })

      // 刷新远程列表
      await get().getRemotes(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

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

  // 提交变更
  async commitChanges(
    workspacePath: string,
    message: string,
    stageAll = true,
    selectedFiles?: string[]
  ) {
    set({ isLoading: true, error: null })

    try {
      const commit = await invoke<string>('git_commit_changes', {
        workspacePath,
        message,
        stageAll,
        selectedFiles: selectedFiles || null,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      // 清理选中状态
      set({
        selectedFilePath: null,
        selectedDiff: null
      })

      set({ isLoading: false })
      return commit
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 暂存文件
  async stageFile(workspacePath: string, filePath: string) {
    console.log('[GitStore] stageFile 开始', { workspacePath, filePath })
    set({ isLoading: true, error: null })

    try {
      const params = {
        workspacePath,
        filePath,
      }
      console.log('[GitStore] 调用 git_stage_file，参数:', params)
      await invoke('git_stage_file', params)

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 取消暂存
  async unstageFile(workspacePath: string, filePath: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_unstage_file', {
        workspacePath,
        filePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 丢弃变更
  async discardChanges(workspacePath: string, filePath: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_discard_changes', {
        workspacePath,
        filePath,
      })

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 检测 Git Host
  detectHost(remoteUrl: string) {
    return invoke<GitHostType>('git_detect_host', { remoteUrl })
  },

  // 检测 Git Host (异步)
  async detectHostAsync(remoteUrl: string): Promise<GitHostType> {
    return await invoke<GitHostType>('git_detect_host', { remoteUrl })
  },

  // 推送分支到远程
  async push(
    workspacePath: string,
    branchName: string,
    remoteName = 'origin',
    force = false,
    setUpstream = false
  ): Promise<GitPushResult> {
    set({ isLoading: true, error: null })

    try {
      // 获取当前 ahead 数量
      const status = get().status
      const pushedCommits = status?.ahead || 0

      if (setUpstream) {
        // 推送并设置上游分支
        await invoke('git_push_set_upstream', {
          workspacePath,
          branchName,
          remoteName,
        })
      } else {
        // 普通推送
        await invoke('git_push_branch', {
          workspacePath,
          branchName,
          remoteName,
          force,
        })
      }

      // 刷新状态
      await get().refreshStatus(workspacePath)

      set({ isLoading: false })
      return {
        success: true,
        pushedCommits,
        needsUpstream: false,
        rejected: false,
      }
    } catch (err) {
      const errorMsg = parseGitError(err)
      set({ error: errorMsg, isLoading: false })

      // 分析错误类型
      const needsUpstream = errorMsg.includes('no upstream branch') ||
        errorMsg.includes('no tracking information') ||
        errorMsg.includes('--set-upstream')
      const rejected = errorMsg.includes('rejected') ||
        errorMsg.includes('non-fast-forward') ||
        errorMsg.includes('fetch first')

      return {
        success: false,
        pushedCommits: 0,
        needsUpstream,
        rejected,
        error: errorMsg,
      }
    }
  },

  // 拉取远程更新
  async pull(
    workspacePath: string,
    remoteName = 'origin',
    branchName?: string
  ) {
    set({ isLoading: true, error: null })

    try {
      const result = await invoke<GitPullResult>('git_pull', {
        workspacePath,
        remoteName,
        branchName: branchName || null,
      })

      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
      return result
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // 获取提交历史
  async getLog(
    workspacePath: string,
    limit = 50,
    skip = 0,
    branch?: string
  ) {
    try {
      const commits = await invoke<GitCommit[]>('git_get_log', {
        workspacePath,
        limit,
        skip,
        branch: branch || null,
      })
      set({ commits })
      return commits
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },

  // 批量暂存文件
  async batchStage(workspacePath: string, filePaths: string[]) {
    try {
      const result = await invoke<BatchStageResult>('git_batch_stage', {
        workspacePath,
        filePaths,
      })
      await get().refreshStatus(workspacePath)
      return result
    } catch (err) {
      set({ error: parseGitError(err) })
      throw err
    }
  },

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

  // 清除错误
  clearError() {
    set({ error: null })
  },

  // 检查是否有变更
  hasChanges() {
    const { status } = get()
    if (!status) return false

    return (
      status.staged.length > 0 ||
      status.unstaged.length > 0 ||
      status.untracked.length > 0
    )
  },

  // 获取所有变更文件
  getChangedFiles() {
    const { status } = get()
    if (!status) return []

    return [
      ...status.staged.map((f) => f.path),
      ...status.unstaged.map((f) => f.path),
      ...status.untracked,
    ]
  },

  // 设置选中的文件
  setSelectedFilePath(path: string | null) {
    set({ selectedFilePath: path })
  },

  // 设置选中的 Diff
  setSelectedDiff(diff: GitDiffEntry | null) {
    set({ selectedDiff: diff })
  },

  // 清除所有状态
  clearAll() {
    // 清理定时器
    const state = get()
    state._refreshTimeouts.forEach((timeout) => clearTimeout(timeout))

    set({
      status: null,
      diffs: [],
      worktreeDiffs: [],
      indexDiffs: [],
      branches: [],
      remotes: [],
      tags: [],
      currentPR: null,
      commits: [],
      stashList: [],
      error: null,
      selectedFilePath: null,
      selectedDiff: null,
      _refreshPromises: new Map(),
      _refreshTimeouts: new Map(),
    })
  },
}))
