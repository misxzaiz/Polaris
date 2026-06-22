/**
 * 插件服务状态管理
 *
 * 前端状态存储，用于 UI 展示和操作
 */

import { create } from 'zustand'
import type {
  PluginId,
  PluginServiceStatus,
} from '@/plugin-system/types'

interface PluginServiceStoreState {
  /** 服务状态映射: `${pluginId}::${serviceId}` -> status */
  serviceStatuses: Record<string, PluginServiceStatus>
  /** 加载状态 */
  isLoading: boolean
  /** 错误信息 */
  error: string | null
}

interface PluginServiceStoreActions {
  /** 更新服务状态 */
  updateServiceStatus: (status: PluginServiceStatus) => void
  /** 批量更新服务状态 */
  updateServiceStatuses: (statuses: PluginServiceStatus[]) => void
  /** 移除服务状态 */
  removeServiceStatus: (pluginId: PluginId, serviceId: string) => void
  /** 清除指定插件的所有服务状态 */
  clearPluginServiceStatuses: (pluginId: PluginId) => void
  /** 获取服务状态 */
  getServiceStatus: (pluginId: PluginId, serviceId: string) => PluginServiceStatus | undefined
  /** 获取指定插件的所有服务状态 */
  getPluginServiceStatuses: (pluginId: PluginId) => PluginServiceStatus[]
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置错误信息 */
  setError: (error: string | null) => void
}

export type PluginServiceStore = PluginServiceStoreState & PluginServiceStoreActions

function getServiceKey(pluginId: PluginId, serviceId: string): string {
  return `${pluginId}::${serviceId}`
}

export const usePluginServiceStore = create<PluginServiceStore>()((set, get) => ({
  serviceStatuses: {},
  isLoading: false,
  error: null,

  updateServiceStatus: (status) => {
    const key = getServiceKey(status.pluginId, status.serviceId)
    set((state) => ({
      serviceStatuses: {
        ...state.serviceStatuses,
        [key]: status,
      },
    }))
  },

  updateServiceStatuses: (statuses) => {
    set((state) => {
      const newStatuses = { ...state.serviceStatuses }
      for (const status of statuses) {
        const key = getServiceKey(status.pluginId, status.serviceId)
        newStatuses[key] = status
      }
      return { serviceStatuses: newStatuses }
    })
  },

  removeServiceStatus: (pluginId, serviceId) => {
    const key = getServiceKey(pluginId, serviceId)
    set((state) => {
      const newStatuses = { ...state.serviceStatuses }
      delete newStatuses[key]
      return { serviceStatuses: newStatuses }
    })
  },

  clearPluginServiceStatuses: (pluginId) => {
    set((state) => {
      const newStatuses = { ...state.serviceStatuses }
      for (const key of Object.keys(newStatuses)) {
        if (key.startsWith(`${pluginId}::`)) {
          delete newStatuses[key]
        }
      }
      return { serviceStatuses: newStatuses }
    })
  },

  getServiceStatus: (pluginId, serviceId) => {
    const key = getServiceKey(pluginId, serviceId)
    return get().serviceStatuses[key]
  },

  getPluginServiceStatuses: (pluginId) => {
    const prefix = `${pluginId}::`
    return Object.entries(get().serviceStatuses)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, status]) => status)
  },

  setLoading: (loading) => set({ isLoading: loading }),

  setError: (error) => set({ error }),
}))
