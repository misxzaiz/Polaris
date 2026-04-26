/**
 * CLI 动态信息 Store
 *
 * 管理 CLI 的动态数据：Agent 列表、认证状态、版本号
 * 数据来源：Tauri 后端调用 claude agents / claude auth status / claude --version
 * 以及 stream-json init 事件的动态补充
 */

import { create } from 'zustand'
import { createLogger } from '../utils/logger'
import { listen } from '@/services/transport'

type UnlistenFn = () => void

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

/** MCP 服务器状态 */
export interface McpServerStatus {
  /** 服务器名称 */
  name: string
  /** 连接状态 */
  status: string
}

/** CLI Init 事件数据 */
export interface CliInitEventData {
  /** 会话 ID */
  sessionId: string
  /** 可用工具列表 */
  tools?: string[]
  /** MCP 服务器状态 */
  mcpServers?: McpServerStatus[]
  /** 可用 Agent 列表 */
  agents?: string[]
  /** 可用技能列表 */
  skills?: string[]
  /** 当前模型 */
  model?: string
  /** CLI 版本 */
  claudeCodeVersion?: string
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
  /** 可用工具列表 */
  tools: string[]
  /** MCP 服务器状态 */
  mcpServers: McpServerStatus[]
  /** 可用技能列表 */
  skills: string[]
  /** 当前模型 */
  currentModel: string | null
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
  /** 从 init 事件更新数据 */
  updateFromInit: (data: CliInitEventData) => void
  /** 重置状态 */
  reset: () => void
  /** 初始化事件监听 */
  initEventListeners: () => () => void
}

import { invoke } from '@/services/transport'

// ============================================================
// Store 创建
// ============================================================

export const useCliInfoStore = create<CliInfoState>((set, get) => ({
  agents: [],
  authStatus: null,
  version: null,
  tools: [],
  mcpServers: [],
  skills: [],
  currentModel: null,
  loading: false,
  error: null,
  lastFetched: null,

  fetchAgents: async () => {
    try {
      log.debug('获取 CLI Agent 列表...')
      const agents = await invoke<CliAgentInfo[]>('cli_get_agents')
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
      const authStatus = await invoke<CliAuthStatus>('cli_get_auth_status')
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
      const version = await invoke<string>('cli_get_version')
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

  updateFromInit: (data: CliInitEventData) => {
    log.debug('从 init 事件更新 CLI 信息', {
      agents: data.agents?.length,
      tools: data.tools?.length,
      mcpServers: data.mcpServers?.length,
    })

    const updates: Partial<CliInfoState> = {}

    // 更新工具列表
    if (data.tools && data.tools.length > 0) {
      updates.tools = data.tools
    }

    // 更新 MCP 服务器状态
    if (data.mcpServers && data.mcpServers.length > 0) {
      updates.mcpServers = data.mcpServers
    }

    // 更新技能列表
    if (data.skills && data.skills.length > 0) {
      updates.skills = data.skills
    }

    // 更新当前模型
    if (data.model) {
      updates.currentModel = data.model
    }

    // 更新版本号
    if (data.claudeCodeVersion) {
      updates.version = data.claudeCodeVersion
    }

    // 更新 Agent 列表（仅当有数据时）
    if (data.agents && data.agents.length > 0) {
      const existingAgents = get().agents
      // 如果已有 Agent 列表，只补充；否则创建新列表
      if (existingAgents.length === 0) {
        updates.agents = data.agents.map(id => ({
          id,
          name: id.split(':').pop() || id,
          source: id.includes(':') ? 'plugin' : 'builtin',
        }))
      }
    }

    if (Object.keys(updates).length > 0) {
      set(updates)
      log.debug('CLI 信息更新完成', updates)
    }
  },

  reset: () => {
    set({
      agents: [],
      authStatus: null,
      version: null,
      tools: [],
      mcpServers: [],
      skills: [],
      currentModel: null,
      loading: false,
      error: null,
      lastFetched: null,
    })
  },

  initEventListeners: () => {
    let unlisten: UnlistenFn | null = null

    // 监听 cli_init 事件
    listen<CliInitEventData>('cli_init', (event) => {
      log.debug('收到 cli_init 事件', { agents: event.agents?.length })
      get().updateFromInit(event)
    }).then((fn) => {
      unlisten = fn
    })

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  },
}))
