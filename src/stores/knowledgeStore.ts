/**
 * 知识状态管理 - Zustand Store
 *
 * 管理知识索引的加载和缓存，供 UI 和服务层使用
 */

import { create } from 'zustand'
import { getKnowledgeService, type ModuleIndex, type ModuleIndexEntry, type StaleModule, type DomainDefinition } from '../services/knowledgeService'
import { createLogger } from '../utils/logger'

const log = createLogger('KnowledgeStore')

// ─── State Interface ───────────────────────────────────────────

interface KnowledgeState {
  /** 当前工作区路径 */
  workspacePath: string | null

  /** 模块索引 */
  index: ModuleIndex | null

  /** 过期模块列表 */
  staleModules: StaleModule[]

  /** 加载状态 */
  loading: boolean

  /** 错误信息 */
  error: string | null

  /** 是否已初始化 */
  initialized: boolean

  /** 当前选中的模块 ID（用于详情弹窗） */
  selectedModuleId: string | null

  /** 已加载的模块文档缓存 */
  moduleDocuments: Map<string, string>

  /** 文档加载中 */
  docLoading: boolean
}

interface KnowledgeActions {
  /** 加载指定工作区的知识索引 */
  loadIndex: (workspacePath: string) => Promise<void>

  /** 加载过期模块列表 */
  loadStaleModules: () => Promise<void>

  /** 清除模块过期标记 */
  clearStaleMarker: (id: string) => Promise<boolean>

  /** 清空状态（切换工作区时调用） */
  clear: () => void

  /** 获取所有模块 ID */
  getModuleIds: () => string[]

  /** 搜索模块 */
  searchModules: (query: string) => ModuleIndexEntry[]

  /** 根据模块 ID 获取模块信息 */
  getModule: (id: string) => ModuleIndexEntry | undefined

  /** 选中模块以打开详情弹窗（null 关闭） */
  selectModule: (id: string | null) => void

  /** 加载模块 Markdown 文档 */
  loadModuleDocument: (moduleId: string) => Promise<string | null>

  /** 获取领域定义 */
  getDomains: () => DomainDefinition[]
}

export type KnowledgeStore = KnowledgeState & KnowledgeActions

// ─── Initial State ─────────────────────────────────────────────

const initialState: KnowledgeState = {
  workspacePath: null,
  index: null,
  staleModules: [],
  loading: false,
  error: null,
  initialized: false,
  selectedModuleId: null,
  moduleDocuments: new Map(),
  docLoading: false,
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

  loadStaleModules: async () => {
    try {
      const service = getKnowledgeService()
      const staleModules = await service.getStaleModules()
      set({ staleModules })
      log.info(`过期模块加载完成: ${staleModules.length} 个`)
    } catch (err) {
      log.warn('加载过期模块失败', { error: err instanceof Error ? err.message : String(err) })
    }
  },

  clearStaleMarker: async (id: string) => {
    try {
      const service = getKnowledgeService()
      const success = await service.clearStaleMarker(id)
      if (success) {
        set(state => ({
          staleModules: state.staleModules.filter(m => m.id !== id)
        }))
      }
      return success
    } catch (err) {
      log.warn('清除过期标记失败', { error: err instanceof Error ? err.message : String(err) })
      return false
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

  selectModule: (id: string | null) => {
    set({ selectedModuleId: id })
  },

  loadModuleDocument: async (moduleId: string) => {
    const { moduleDocuments } = get()
    if (moduleDocuments.has(moduleId)) {
      return moduleDocuments.get(moduleId) ?? null
    }

    set({ docLoading: true })
    try {
      const service = getKnowledgeService()
      const content = await service.getModuleDocument(moduleId)
      if (content) {
        set(state => {
          const docs = new Map(state.moduleDocuments)
          docs.set(moduleId, content)
          return { moduleDocuments: docs, docLoading: false }
        })
      } else {
        set({ docLoading: false })
      }
      return content
    } catch {
      set({ docLoading: false })
      return null
    }
  },

  getDomains: () => {
    const { index } = get()
    return index?.domains ?? []
  },
}))
