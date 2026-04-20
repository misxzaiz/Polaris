/**
 * 知识状态管理 - Zustand Store
 *
 * 管理知识索引的加载和缓存，供 UI 和服务层使用
 */

import { create } from 'zustand'
import { getKnowledgeService, type ModuleIndex, type ModuleIndexEntry } from '../services/knowledgeService'
import { createLogger } from '../utils/logger'

const log = createLogger('KnowledgeStore')

// ─── State Interface ───────────────────────────────────────────

interface KnowledgeState {
  /** 当前工作区路径 */
  workspacePath: string | null

  /** 模块索引 */
  index: ModuleIndex | null

  /** 加载状态 */
  loading: boolean

  /** 错误信息 */
  error: string | null

  /** 是否已初始化 */
  initialized: boolean
}

interface KnowledgeActions {
  /** 加载指定工作区的知识索引 */
  loadIndex: (workspacePath: string) => Promise<void>

  /** 清空状态（切换工作区时调用） */
  clear: () => void

  /** 获取所有模块 ID */
  getModuleIds: () => string[]

  /** 搜索模块 */
  searchModules: (query: string) => ModuleIndexEntry[]

  /** 根据模块 ID 获取模块信息 */
  getModule: (id: string) => ModuleIndexEntry | undefined
}

export type KnowledgeStore = KnowledgeState & KnowledgeActions

// ─── Initial State ─────────────────────────────────────────────

const initialState: KnowledgeState = {
  workspacePath: null,
  index: null,
  loading: false,
  error: null,
  initialized: false,
}

// ─── Store Factory ──────────────────────────────────────────────

export const useKnowledgeStore = create<KnowledgeStore>((set, get) => ({
  ...initialState,

  loadIndex: async (workspacePath: string) => {
    // 避免重复加载同一工作区
    const current = get()
    if (current.workspacePath === workspacePath && current.initialized) {
      return
    }

    set({ loading: true, error: null })

    try {
      const service = getKnowledgeService()
      await service.loadIndex(workspacePath)
      const index = service.getIndex()

      set({
        workspacePath,
        index,
        loading: false,
        error: null,
        initialized: true,
      })

      log.info(`知识索引加载完成: ${index?.modules.length ?? 0} 个模块`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      set({
        loading: false,
        error: errorMsg,
        initialized: false,
      })
      log.error('知识索引加载失败', err instanceof Error ? err : new Error(errorMsg))
    }
  },

  clear: () => {
    set(initialState)
  },

  getModuleIds: () => {
    const service = getKnowledgeService()
    return service.getModuleIds()
  },

  searchModules: (query: string) => {
    const service = getKnowledgeService()
    return service.searchModules(query)
  },

  getModule: (id: string) => {
    const { index } = get()
    return index?.modules.find(m => m.id === id)
  },
}))
