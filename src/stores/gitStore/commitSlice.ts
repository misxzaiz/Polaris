/**
 * Commit 操作 Slice
 *
 * 负责提交和暂存操作：提交、暂存、取消暂存、丢弃变更
 */

import { invoke } from '@/services/transport'
import type { CommitSlice } from './types'
import { parseGitError } from './types'
import type { GitCommit, GitCommitDetails, GitFileHistoryEntry, BatchStageResult } from '@/types/git'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitStore')

/**
 * 创建 Commit 操作 Slice
 */
export const createCommitSlice: CommitSlice = (set, get) => ({
  // ===== 状态 =====
  commits: [],
  commitDetails: {},

  // ===== 方法 =====

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
    log.debug('stageFile start', { workspacePath, filePath })
    set({ isLoading: true, error: null })

    try {
      const params = {
        workspacePath,
        filePath,
      }
      log.debug('Calling git_stage_file', params)
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

  // 获取单个提交详情
  async getCommitDetails(workspacePath: string, commitSha: string) {
    try {
      const details = await invoke<GitCommitDetails>('git_get_commit_details', {
        workspacePath,
        commitSha,
      })
      set((state) => ({
        commitDetails: {
          ...state.commitDetails,
          [details.commit.sha]: details,
          [details.commit.shortSha]: details,
        },
      }))
      return details
    } catch (err) {
      set({ error: parseGitError(err) })
      throw err
    }
  },

  // 获取单文件提交历史
  async getFileHistory(workspacePath: string, filePath: string, limit = 50, skip = 0, branch?: string) {
    try {
      return await invoke<GitFileHistoryEntry[]>('git_get_file_history', {
        workspacePath,
        filePath,
        limit,
        skip,
        branch: branch || null,
      })
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },

  // 检出指定提交（detached HEAD）
  async checkoutCommit(workspacePath: string, commitSha: string) {
    set({ isLoading: true, error: null })

    try {
      await invoke('git_checkout_commit', {
        workspacePath,
        commitSha,
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
})
