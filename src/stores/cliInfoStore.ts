/**
 * CLI 动态信息 Store
 *
 * 管理 CLI 的动态数据：Agent 列表、认证状态、版本号
 * 数据来源：Tauri 后端调用 claude agents / claude auth status / claude --version
 */

import { create } from 'zustand'
import { createLogger } from '../utils/logger'

const log = createLogger('CliInfoStore')

// ============================================================
// 类型定义
// ============================================================

/** CLI Agent 信息 */
export interface CliAgentInfo {
  /** Agent ID */
  id: string
  /** 显示名称 */
  name: string
  /** 来源: "builtin" | "plugin" */
  source: string
  /** 默认模型 (undefined = inherit) */
  defaultModel?: string
}

/** 认证状态 */
export interface CliAuthStatus {
  /** 是否已登录 */
  loggedIn: boolean
  /** 认证方式 */
  authMethod: string
  /** API 提供商 */
  apiProvider: string
}

// ============================================================
// Store 状态
// ============================================================

interface CliInfoState {
  /** Agent 列表 (动态获取) */
  agents: CliAgentInfo[]
  /** 认证状态 */
  authStatus: CliAuthStatus | null
  /** CLI 版本 */
  version: string | null
  /** 加载状态 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 上次获取时间戳 */
  lastFetched: number | null

  // 操作
  /** 获取 Agent 列表 */
  fetchAgents: () => Promise<void>
  /** 获取认证状态 */
  fetchAuthStatus: () => Promise<void>
  /** 获取 CLI 版本 */
  fetchVersion: () => Promise<void>
  /** 获取全部信息 */
  fetchAll: () => Promise<void>
  /** 重置状态 */
  reset: () => void
}

// ============================================================
// Tauri invoke 封装
// ============================================================

async function invokeCliGetAgents(): Promise<CliAgentInfo[]> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('cli_get_agents')
}

async function invokeCliGetAuthStatus(): Promise<CliAuthStatus> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('cli_get_auth_status')
}

async function invokeCliGetVersion(): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke('cli_get_version')
}

// ============================================================
// Store 创建
// ============================================================

export const useCliInfoStore = create<CliInfoState>((set, get) => ({
  agents: [],
  authStatus: null,
  version: null,
  loading: false,
  error: null,
  lastFetched: null,

  fetchAgents: async () => {
    try {
      log.debug('获取 CLI Agent 列表...')
      const agents = await invokeCliGetAgents()
      log.debug(`获取到 ${agents.length} 个 Agent`)
      set({ agents, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('获取 Agent 列表失败', { error: msg })
      set({ error: msg })
    }
  },

  fetchAuthStatus: async () => {
    try {
      log.debug('获取认证状态...')
      const authStatus = await invokeCliGetAuthStatus()
      log.debug(`认证状态: loggedIn=${authStatus.loggedIn}, method=${authStatus.authMethod}`)
      set({ authStatus, error: null })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('获取认证状态失败', { error: msg })
      set({ error: msg })
    }
  },

  fetchVersion: async () => {
    try {
      const version = await invokeCliGetVersion()
      set({ version })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log.warn('获取版本失败', { error: msg })
    }
  },

  fetchAll: async () => {
    if (get().loading) return
    set({ loading: true, error: null })
    log.debug('开始获取全部 CLI 信息...')

    try {
      // 并行获取，不互相阻塞
      await Promise.allSettled([
        get().fetchAgents(),
        get().fetchAuthStatus(),
        get().fetchVersion(),
      ])
      set({ lastFetched: Date.now(), loading: false })
      log.debug('CLI 信息获取完成')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      set({ error: msg, loading: false })
    }
  },

  reset: () => {
    set({
      agents: [],
      authStatus: null,
      version: null,
      loading: false,
      error: null,
      lastFetched: null,
    })
  },
}))
