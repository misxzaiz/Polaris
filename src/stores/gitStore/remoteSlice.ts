/**
 * 远程操作 Slice
 *
 * 负责远程仓库管理：添加、删除、推送、拉取等操作
 */

import { invoke } from '@/services/transport'
import type { RemoteSlice } from './types'
import { parseGitError } from './types'
import type { RemoteState } from './types'
import type { GitRemote, GitHostType, GitPullResult, GitPushResult } from '@/types/git'

/**
 * 创建远程操作 Slice
 */
export const createRemoteSlice: RemoteSlice = (set, get) => ({
  // ===== 状态 =====
  remotes: [],
  // P1.5 分片：keyed 只读数据域（新 UI 消费）
  remotesByWs: {},

  // ===== 方法 =====

  // 获取远程仓库列表
  async getRemotes(workspacePath: string) {
    // P1.5 分片：keyed 写 + 旧镜像域保留（未迁移 UI）
    const setRemotes = (remotes: GitRemote[]) => {
      set({
        remotes,
        remotesByWs: { ...(get() as RemoteState).remotesByWs, [workspacePath]: remotes },
      })
    }

    try {
      const remotes = await invoke<GitRemote[]>('git_get_remotes', {
        workspacePath,
      })

      setRemotes(remotes)
    } catch (err) {
      set({ error: parseGitError(err), remotes: [] })
      setRemotes([])
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

  // 推送分支到远程（P1： leaseSha 可选 —— force=true 时作为 --force-with-lease=<ref>:<sha> 的期望值）
  async push(
    workspacePath: string,
    branchName: string,
    remoteName = 'origin',
    force = false,
    setUpstream = false,
    remoteBranchName?: string,
    leaseSha?: string
  ): Promise<GitPushResult> {
    set({ isLoading: true, error: null })

    try {
      // 获取当前 ahead 数量（优先该仓库路径的状态，缺省用全局）
      const status = get().statuses[workspacePath] ?? get().status
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
        // 普通推送（P1：leaseSha 仅在显式提供时附加 —— 保持旧 5 键 payload 契约不被改写）
        await invoke('git_push_branch', {
          workspacePath,
          branchName,
          remoteName,
          force,
          remoteBranchName: remoteBranchName || null,
          ...(leaseSha != null ? { leaseSha } : {}),
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

  // P1：force-with-lease 推送（显式期望远端 sha 的安全强推；裸 --force 已在后端除名）
  async pushWithLease(
    workspacePath: string,
    branchName: string,
    remoteName = 'origin',
    remoteBranchName?: string,
    leaseSha?: string
  ): Promise<GitPushResult> {
    return get().push(workspacePath, branchName, remoteName, true, false, remoteBranchName, leaseSha)
  },

  // P1：fetch（不合并到本地分支；auto-fetch 调度默认关 = 面板设置项）
  async fetchRemote(workspacePath: string, remoteName?: string, prune = false): Promise<string> {
    set({ isLoading: true, error: null })

    try {
      const summary = await invoke<string>('git_fetch', {
        workspacePath,
        remoteName: remoteName || null,
        prune,
      })

      // remote-tracking refs 已变 —— 刷新状态（ahead/behind 口径）
      await get().refreshStatus(workspacePath)
      set({ isLoading: false })
      return summary
    } catch (err) {
      set({ error: parseGitError(err), isLoading: false })
      throw err
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
