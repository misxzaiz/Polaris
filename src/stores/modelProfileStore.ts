/**
 * 模型 Profile Store
 *
 * 管理第三方 Anthropic 兼容端点的模型配置，
 * 支持 CRUD 操作和 Profile 激活切换。
 *
 * Profile 数据随 Config Store 一起持久化到 Tauri 后端配置文件，
 * 本 Store 仅负责前端局部状态的响应式管理。
 */

import { create } from 'zustand'
import type {
  ModelProfile,
  CreateModelProfileParams,
  UpdateModelProfileParams,
} from '@/types/modelProfile'
import { generateProfileId } from '@/types/modelProfile'

interface ModelProfileState {
  /** Profile 列表 */
  profiles: ModelProfile[]
  /** 当前激活的 Profile ID */
  activeProfileId: string | null
  /** 加载状态 */
  loading: boolean
  /** 错误信息 */
  error: string | null

  // Actions
  /** 设置 Profile 列表（从 Config Store 初始化时使用） */
  setProfiles: (profiles: ModelProfile[]) => void
  /** 设置激活的 Profile ID */
  setActiveProfileId: (id: string | null) => void
  /** 添加 Profile */
  addProfile: (params: CreateModelProfileParams) => ModelProfile
  /** 更新 Profile */
  updateProfile: (params: UpdateModelProfileParams) => ModelProfile | null
  /** 删除 Profile */
  removeProfile: (id: string) => void
  /** 激活指定 Profile（同时取消其他 Profile 的 active 状态） */
  activateProfile: (id: string | null) => void
  /** 获取当前激活的 Profile */
  getActiveProfile: () => ModelProfile | undefined
  /** 重置状态 */
  reset: () => void
}

const initialState = {
  profiles: [],
  activeProfileId: null,
  loading: false,
  error: null,
}

export const useModelProfileStore = create<ModelProfileState>()((set, get) => ({
  ...initialState,

  setProfiles: (profiles) => {
    const activeProfile = profiles.find(p => p.active)
    set({
      profiles,
      activeProfileId: activeProfile?.id ?? null,
    })
  },

  setActiveProfileId: (id) => {
    set({ activeProfileId: id })
  },

  addProfile: (params) => {
    const now = new Date().toISOString()
    const profile: ModelProfile = {
      id: generateProfileId(),
      name: params.name,
      baseUrl: params.baseUrl,
      apiKey: params.apiKey,
      model: params.model,
      description: params.description,
      active: false,
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      profiles: [...state.profiles, profile],
    }))
    return profile
  },

  updateProfile: (params) => {
    const { id, ...updates } = params
    let updated: ModelProfile | null = null
    set((state) => ({
      profiles: state.profiles.map((p) => {
        if (p.id === id) {
          updated = {
            ...p,
            ...updates,
            updatedAt: new Date().toISOString(),
          }
          return updated
        }
        return p
      }),
    }))
    return updated
  },

  removeProfile: (id) => {
    set((state) => {
      const newProfiles = state.profiles.filter((p) => p.id !== id)
      // 如果删除的是激活的 Profile，自动取消激活
      const newActiveId = state.activeProfileId === id ? null : state.activeProfileId
      return {
        profiles: newProfiles,
        activeProfileId: newActiveId,
      }
    })
  },

  activateProfile: (id) => {
    set((state) => ({
      profiles: state.profiles.map((p) => ({
        ...p,
        active: p.id === id,
      })),
      activeProfileId: id,
    }))
  },

  getActiveProfile: () => {
    const { profiles, activeProfileId } = get()
    if (!activeProfileId) return undefined
    return profiles.find((p) => p.id === activeProfileId)
  },

  reset: () => {
    set(initialState)
  },
}))

/**
 * 获取当前激活的 Profile（用于传递给后端）
 */
export function getActiveModelProfile(): ModelProfile | undefined {
  return useModelProfileStore.getState().getActiveProfile()
}