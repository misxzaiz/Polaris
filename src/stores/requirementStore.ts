/**
 * 需求队列状态管理
 *
 * 包装 RequirementService，提供 React 组件可用的响应式状态
 * 模式与 SchedulerStore 一致：loading/error 状态、筛选器、工作区驱动
 */

import { create } from 'zustand'
import { requirementService, type QueryScopeType } from '@/services/requirementService'
import type {
  Requirement,
  RequirementFilter,
  RequirementCreateParams,
  RequirementUpdateParams,
  RequirementStats,
} from '@/types/requirement'
import { createLogger } from '@/utils/logger'

const log = createLogger('RequirementStore')

interface RequirementState {
  /** 需求列表 */
  requirements: Requirement[]
  /** 加载状态 */
  loading: boolean
  /** 错误信息 */
  error: string | null
  /** 是否已初始化工作区 */
  initialized: boolean
  /** 当前筛选器 */
  filter: RequirementFilter
  /** 当前选中的需求 ID */
  selectedId: string | null
  /** 统计信息 */
  stats: RequirementStats | null
  /** 查询范围：all = 显示所有需求，workspace = 仅当前工作区 */
  scope: QueryScopeType

  // --- Actions ---

  /** 设置工作区并加载数据 */
  init: (workspacePath: string) => Promise<void>
  /** 强制重新加载 */
  reload: () => Promise<void>
  /** 更新筛选器 */
  setFilter: (filter: Partial<RequirementFilter>) => void
  /** 重置筛选器 */
  resetFilter: () => void
  /** 选中需求 */
  selectRequirement: (id: string | null) => void
  /** 设置查询范围 */
  setScope: (scope: QueryScopeType) => void
  /** 创建需求 */
  createRequirement: (params: RequirementCreateParams) => Promise<Requirement>
  /** 更新需求 */
  updateRequirement: (id: string, updates: RequirementUpdateParams) => Promise<void>
  /** 删除需求 */
  deleteRequirement: (id: string) => Promise<void>
  /** 批量删除需求 */
  batchDeleteRequirements: (ids: string[]) => Promise<void>
  /** 批量审核：批准 */
  approveRequirements: (ids: string[]) => Promise<void>
  /** 批量审核：拒绝 */
  rejectRequirements: (ids: string[], reason?: string) => Promise<void>
  /** 获取筛选后的需求列表 */
  getFilteredRequirements: () => Requirement[]
  /** 获取选中的需求 */
  getSelectedRequirement: () => Requirement | undefined
  /** 保存原型 */
  savePrototype: (id: string, html: string) => Promise<string>
  /** 读取原型 */
  readPrototype: (prototypePath: string) => Promise<string>
}

const DEFAULT_FILTER: RequirementFilter = {
  status: 'all',
  search: '',
}

/** 默认查询范围：显示所有需求 */
const DEFAULT_SCOPE: QueryScopeType = 'all'

/** 服务订阅取消句柄，防止重复订阅 */
let unsubscribeService: (() => void) | null = null

export const useRequirementStore = create<RequirementState>((set, get) => ({
  requirements: [],
  loading: false,
  error: null,
  initialized: false,
  filter: { ...DEFAULT_FILTER },
  selectedId: null,
  stats: null,
  scope: DEFAULT_SCOPE,

  init: async (workspacePath: string) => {
    set({ loading: true, error: null })
    try {
      // 先设置 scope，再设置 workspace（避免被覆盖）
      const currentScope = get().scope
      requirementService.setScope(currentScope)
      await requirementService.setWorkspace(workspacePath, true)
      const requirements = requirementService.getAllRequirements()
      const stats = requirementService.getStats()

      // 订阅服务变化，自动同步状态（先取消旧订阅防止泄漏）
      unsubscribeService?.()
      unsubscribeService = requirementService.subscribe(() => {
        const state = get()
        if (!state.initialized) return
        const fresh = requirementService.getAllRequirements()
        const freshStats = requirementService.getStats()
        set({ requirements: fresh, stats: freshStats })
      })

      set({
        requirements,
        stats,
        loading: false,
        initialized: true,
      })
      log.info(`需求队列初始化完成，共 ${requirements.length} 条`)
    } catch (e) {
      const error = e instanceof Error ? e.message : '初始化需求队列失败'
      set({ error, loading: false })
      log.error('初始化需求队列失败:', e instanceof Error ? e : new Error(String(e)))
    }
  },

  reload: async () => {
    set({ loading: true, error: null })
    try {
      const workspacePath = requirementService.getCurrentWorkspacePath()
      if (!workspacePath) {
        set({ loading: false, error: 'Workspace not initialized' })
        return
      }
      await requirementService.setWorkspace(workspacePath, true)
      const requirements = requirementService.getAllRequirements()
      const stats = requirementService.getStats()
      set({ requirements, stats, loading: false })
    } catch (e) {
      const error = e instanceof Error ? e.message : '重新加载失败'
      set({ error, loading: false })
      log.error('重新加载需求失败:', e instanceof Error ? e : new Error(String(e)))
    }
  },

  setFilter: (partial: Partial<RequirementFilter>) => {
    set(state => ({ filter: { ...state.filter, ...partial } }))
  },

  resetFilter: () => {
    set({ filter: { ...DEFAULT_FILTER } })
  },

  selectRequirement: (id: string | null) => {
    set({ selectedId: id })
  },

  setScope: (scope: QueryScopeType) => {
    set({ scope })
    requirementService.setScope(scope)
    // scope 变化后重新加载
    const requirements = requirementService.getAllRequirements()
    const stats = requirementService.getStats()
    set({ requirements, stats })
  },

  createRequirement: async (params: RequirementCreateParams) => {
    set({ error: null })
    try {
      const newReq = await requirementService.createRequirement(params)
      set({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
      })
      log.info(`创建需求成功: ${newReq.id}`)
      return newReq
    } catch (e) {
      const error = e instanceof Error ? e.message : '创建需求失败'
      set({ error })
      throw new Error(error)
    }
  },

  updateRequirement: async (id: string, updates: RequirementUpdateParams) => {
    set({ error: null })
    try {
      await requirementService.updateRequirement(id, updates)
      set({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
      })
    } catch (e) {
      const error = e instanceof Error ? e.message : '更新需求失败'
      set({ error })
      throw new Error(error)
    }
  },

  deleteRequirement: async (id: string) => {
    set({ error: null })
    try {
      await requirementService.deleteRequirement(id)
      set(state => ({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
        selectedId: state.selectedId === id ? null : state.selectedId,
      }))
    } catch (e) {
      const error = e instanceof Error ? e.message : '删除需求失败'
      set({ error })
      throw new Error(error)
    }
  },

  batchDeleteRequirements: async (ids: string[]) => {
    set({ error: null })
    try {
      await requirementService.batchDeleteRequirements(ids)
      set(state => ({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
        selectedId: state.selectedId && ids.includes(state.selectedId) ? null : state.selectedId,
      }))
    } catch (e) {
      const error = e instanceof Error ? e.message : '批量删除失败'
      set({ error })
      throw new Error(error)
    }
  },

  approveRequirements: async (ids: string[]) => {
    set({ error: null })
    try {
      await Promise.all(
        ids.map(id => requirementService.updateRequirement(id, { status: 'approved' }))
      )
      set({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
      })
      log.info(`批量批准 ${ids.length} 条需求`)
    } catch (e) {
      const error = e instanceof Error ? e.message : '批量批准失败'
      set({ error })
      throw new Error(error)
    }
  },

  rejectRequirements: async (ids: string[], reason?: string) => {
    set({ error: null })
    try {
      await Promise.all(
        ids.map(id => requirementService.updateRequirement(id, {
          status: 'rejected',
          reviewNote: reason,
        }))
      )
      set({
        requirements: requirementService.getAllRequirements(),
        stats: requirementService.getStats(),
      })
      log.info(`批量拒绝 ${ids.length} 条需求`)
    } catch (e) {
      const error = e instanceof Error ? e.message : '批量拒绝失败'
      set({ error })
      throw new Error(error)
    }
  },

  getFilteredRequirements: () => {
    const { filter } = get()
    return requirementService.queryRequirements(filter)
  },

  getSelectedRequirement: () => {
    const { selectedId } = get()
    if (!selectedId) return undefined
    return requirementService.getRequirementById(selectedId)
  },

  savePrototype: async (id: string, html: string) => {
    set({ error: null })
    try {
      const prototypePath = await requirementService.savePrototype(id, html)
      set({
        requirements: requirementService.getAllRequirements(),
      })
      return prototypePath
    } catch (e) {
      const error = e instanceof Error ? e.message : '保存原型失败'
      set({ error })
      throw new Error(error)
    }
  },

  readPrototype: async (prototypePath: string) => {
    set({ error: null })
    try {
      return await requirementService.readPrototype(prototypePath)
    } catch (e) {
      const error = e instanceof Error ? e.message : '读取原型失败'
      set({ error })
      throw new Error(error)
    }
  },
}))
