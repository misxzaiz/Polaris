/**
 * Commit 操作 Slice
 *
 * 负责提交和暂存操作：提交、暂存、取消暂存、丢弃变更
 */

import { invoke } from '@/services/transport'
import type { CommitSlice } from './types'
import { parseGitError } from './types'
import type { CommitState } from './types'
import type { GitCommit, GitCommitDetails, GitFileHistoryEntry, GitDiffEntry, BatchStageResult, BatchOpResult, GitLogSearchFilter, GitLogPage, GitCommitRiskReport } from '@/types/git'
import { createLogger } from '@/utils/logger'

const log = createLogger('GitStore')

/**
 * 创建 Commit 操作 Slice
 */
export const createCommitSlice: CommitSlice = (set, get) => ({
  // ===== 状态 =====
  commits: [],
  // P1.5 分片：keyed 只读数据域（新 UI 消费）
  commitsByWs: {},
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

  // AI-2：按组原子提交（只提交组内文件，index 其它已暂存内容不受影响）
  async commitGroup(workspacePath: string, message: string, files: string[]) {
    set({ isLoading: true, error: null })

    try {
      const sha = await invoke<string>('git_commit_group', {
        workspacePath,
        message,
        files,
      })

      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
      return sha
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
    }
  },

  // P1：amend HEAD（message 省略 = --no-edit 语义，仅合并 staged 内容）
  async amendCommit(
    workspacePath: string,
    message?: string,
    stageAll = false,
    selectedFiles?: string[]
  ) {
    set({ isLoading: true, error: null })

    try {
      const sha = await invoke<string>('git_amend_commit', {
        workspacePath,
        message: message ?? null,
        stageAll,
        selectedFiles: selectedFiles?.length ? selectedFiles : null,
      })

      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
      return sha
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

  // 批量取消暂存（与 batchStage 同构：单次调用 + 单次刷新，部分成功不整体失败）
  async batchUnstage(workspacePath: string, filePaths: string[]) {
    try {
      const result = await invoke<BatchOpResult>('git_batch_unstage', {
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

  // 批量丢弃变更（后端对真危险动作自动建撤销快照，前端 toastWithUndo 可一键恢复）
  async batchDiscard(workspacePath: string, filePaths: string[]) {
    try {
      const result = await invoke<BatchOpResult>('git_batch_discard', {
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

  // 对比两个提交（base→target 方向的 tree-to-tree diff；只读）
  async compareCommits(workspacePath: string, baseSha: string, targetSha: string) {
    try {
      return await invoke<GitDiffEntry[]>('git_get_diffs', {
        workspacePath,
        baseCommit: baseSha,
        compareTo: targetSha,
      })
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
      // P1.5 分片：keyed 写 + 旧镜像域保留（未迁移 UI）
      set({
        commits,
        commitsByWs: { ...(get() as CommitState).commitsByWs, [workspacePath]: commits },
      })
      return commits
    } catch (err) {
      set({ error: parseGitError(err) })
      return []
    }
  },

  // P2 泳道图：commits（含 refs 装饰）+ rows（lane 数据）同一次返回
  async getLogWithLanes(
    workspacePath: string,
    limit = 500,
    skip = 0,
    branch?: string
  ): Promise<GitLogPage> {
    try {
      const page = await invoke<GitLogPage>('git_get_log_with_lanes', {
        workspacePath,
        limit,
        skip,
        branch: branch || null,
      })
      // 与 getLog 同构：写常规 commits 镜像（泳道图与详细视图共用）
      set({
        commits: page.commits,
        commitsByWs: { ...(get() as CommitState).commitsByWs, [workspacePath]: page.commits },
      })
      return page
    } catch (err) {
      set({ error: parseGitError(err) })
      return { commits: [], rows: [] }
    }
  },

  // P1：提交历史搜索（grep/author/pickaxe/since/分支范围；不写 commits 镜像 —— 搜索结果与常规 log 视图分离）
  async searchLog(
    workspacePath: string,
    filter: GitLogSearchFilter,
    limit = 50,
    skip = 0
  ): Promise<GitCommit[]> {
    try {
      return await invoke<GitCommit[]>('git_search_log', {
        workspacePath,
        filter,
        limit,
        skip,
      })
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

  // P3 AI-3：提交前风险扫描（Review 门；只读，纯本地零 AI）
  async scanCommitRisk(workspacePath: string) {
    const report = await invoke<GitCommitRiskReport>('git_scan_commit_risk', {
      workspacePath,
    })
    set((state) => ({
      riskScanByWs: { ...(state.riskScanByWs ?? {}), [workspacePath]: report },
    }))
    return report
  },
})
