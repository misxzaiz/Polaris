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

  /** 是否已初始化（索引加载流程已完成） */
  initialized: boolean

  /** 知识库是否尚未初始化（索引文件不存在） */
  notInitialized: boolean

  /** 当前选中的模块 ID（用于详情弹窗） */
  selectedModuleId: string | null

  /** 已加载的模块文档缓存 */
  moduleDocuments: Map<string, string>

  /** 文档加载中 */
  docLoading: boolean
}

interface KnowledgeActions {
  /** 加载指定工作区的知识索引（首次加载，防重复） */
  loadIndex: (workspacePath: string) => Promise<void>

  /** 强制刷新知识索引（忽略缓存，用于手动刷新） */
  refreshIndex: (workspacePath: string) => Promise<void>

  /** 初始化知识库（创建目录结构和空索引） */
  initKnowledge: (workspacePath: string) => Promise<void>

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
  notInitialized: false,
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

    set({ loading: true, error: null, notInitialized: false })

    try {
      const service = getKnowledgeService()
      const result = await service.loadIndex(workspacePath)
      const index = service.getIndex()

      if (result.status === 'not_initialized') {
        set({
          workspacePath,
          index: null,
          loading: false,
          error: null,
          initialized: true,
          notInitialized: true,
        })
        log.info('知识库尚未初始化')
        return
      }

      if (result.status === 'error') {
        set({
          loading: false,
          error: result.error ?? '未知错误',
          initialized: false,
          notInitialized: false,
        })
        log.error('知识索引加载失败', new Error(result.error ?? '未知错误'))
        return
      }

      set({
        workspacePath,
        index,
        loading: false,
        error: null,
        initialized: true,
        notInitialized: false,
      })

      log.info(`知识索引加载完成: ${index?.modules.length ?? 0} 个模块`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      set({
        loading: false,
        error: errorMsg,
        initialized: false,
        notInitialized: false,
      })
      log.error('知识索引加载失败', err instanceof Error ? err : new Error(errorMsg))
    }
  },

  refreshIndex: async (workspacePath: string) => {
    // 重置初始化状态，绕过防重复守卫
    set({ initialized: false, loading: true, error: null, notInitialized: false })
    // 清空文档缓存
    set({ moduleDocuments: new Map() })

    try {
      const service = getKnowledgeService()
      const result = await service.loadIndex(workspacePath)
      const index = service.getIndex()

      if (result.status === 'not_initialized') {
        set({
          workspacePath,
          index: null,
          loading: false,
          error: null,
          initialized: true,
          notInitialized: true,
        })
        return
      }

      if (result.status === 'error') {
        set({
          loading: false,
          error: result.error ?? '未知错误',
          initialized: false,
          notInitialized: false,
        })
        return
      }

      set({
        workspacePath,
        index,
        loading: false,
        error: null,
        initialized: true,
        notInitialized: false,
      })

      // 同步刷新过期模块
      await get().loadStaleModules()

      log.info(`知识索引刷新完成: ${index?.modules.length ?? 0} 个模块`)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      set({
        loading: false,
        error: errorMsg,
        initialized: false,
        notInitialized: false,
      })
      log.error('知识索引刷新失败', err instanceof Error ? err : new Error(errorMsg))
    }
  },

  initKnowledge: async (workspacePath: string) => {
    set({ loading: true, error: null })
    try {
      const service = getKnowledgeService()
      await service.initKnowledge(workspacePath)
      const index = service.getIndex()

      set({
        workspacePath,
        index,
        loading: false,
        error: null,
        initialized: true,
        notInitialized: false,
      })

      log.info('知识库初始化完成')
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      set({
        loading: false,
        error: errorMsg,
        initialized: false,
        notInitialized: false,
      })
      log.error('知识库初始化失败', err instanceof Error ? err : new Error(errorMsg))
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
