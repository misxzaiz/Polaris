/**
 * 远程操作 Slice
 *
 * 负责远程仓库管理：添加、删除、推送、拉取等操作
 */

import { invoke } from '@/services/transport'
import type { RemoteSlice } from './types'
import { parseGitError } from './types'
import type { GitRemote, GitHostType, GitPullResult, GitPushResult } from '@/types/git'

/**
 * 创建远程操作 Slice
 */
export const createRemoteSlice: RemoteSlice = (set, get) => ({
  // ===== 状态 =====
  remotes: [],

  // ===== 方法 =====

  // 获取远程仓库列表
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

  // 推送分支到远程
  async push(
    workspacePath: string,
    branchName: string,
    remoteName = 'origin',
    force = false,
    setUpstream = false,
    remoteBranchName?: string
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
          remoteBranchName: remoteBranchName || null,
        })
      } else {
        // 普通推送
        await invoke('git_push_branch', {
          workspacePath,
          branchName,
          remoteName,
          force,
          remoteBranchName: remoteBranchName || null,
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

  // 检测 Git Host (异步)
  async detectHostAsync(remoteUrl: string): Promise<GitHostType> {
    return await invoke<GitHostType>('git_detect_host', { remoteUrl })
  },
})
