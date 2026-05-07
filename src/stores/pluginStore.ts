/**
 * 插件状态管理
 *
 * 第一阶段仅管理前端本地启用状态。后续可切换到 Tauri 后端持久化。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface PluginState {
  enabled: boolean
  uiEnabled: boolean
  mcpEnabled: boolean
}

export type PluginStateMap = Record<string, PluginState>

interface PluginStoreState {
  pluginStates: PluginStateMap
}

interface PluginStoreActions {
  getPluginState: (pluginId: string) => PluginState
  isPluginEnabled: (pluginId: string) => boolean
  isPluginUiEnabled: (pluginId: string) => boolean
  isPluginMcpEnabled: (pluginId: string) => boolean
  setPluginEnabled: (pluginId: string, enabled: boolean) => void
  setPluginUiEnabled: (pluginId: string, uiEnabled: boolean) => void
  setPluginMcpEnabled: (pluginId: string, mcpEnabled: boolean) => void
  resetPluginState: (pluginId: string) => void
}

export type PluginStore = PluginStoreState & PluginStoreActions

export const DEFAULT_PLUGIN_STATE: PluginState = {
  enabled: true,
  uiEnabled: true,
  mcpEnabled: true,
}

export function getEffectivePluginState(
  pluginStates: PluginStateMap,
  pluginId: string
): PluginState {
  return pluginStates[pluginId] ?? DEFAULT_PLUGIN_STATE
}

export function isPluginUiEnabled(pluginStates: PluginStateMap, pluginId: string): boolean {
  const state = getEffectivePluginState(pluginStates, pluginId)
  return state.enabled && state.uiEnabled
}

export function isPluginMcpEnabled(pluginStates: PluginStateMap, pluginId: string): boolean {
  const state = getEffectivePluginState(pluginStates, pluginId)
  return state.enabled && state.mcpEnabled
}

function mergePluginState(
  pluginStates: PluginStateMap,
  pluginId: string,
  updates: Partial<PluginState>
): PluginStateMap {
  return {
    ...pluginStates,
    [pluginId]: {
      ...getEffectivePluginState(pluginStates, pluginId),
      ...updates,
    },
  }
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      pluginStates: {},

      getPluginState: (pluginId) => getEffectivePluginState(get().pluginStates, pluginId),

      isPluginEnabled: (pluginId) => get().getPluginState(pluginId).enabled,

      isPluginUiEnabled: (pluginId) => isPluginUiEnabled(get().pluginStates, pluginId),

      isPluginMcpEnabled: (pluginId) => isPluginMcpEnabled(get().pluginStates, pluginId),

      setPluginEnabled: (pluginId, enabled) => {
        set((state) => ({
          pluginStates: mergePluginState(state.pluginStates, pluginId, { enabled }),
        }))
      },

      setPluginUiEnabled: (pluginId, uiEnabled) => {
        set((state) => ({
          pluginStates: mergePluginState(state.pluginStates, pluginId, { uiEnabled }),
        }))
      },

      setPluginMcpEnabled: (pluginId, mcpEnabled) => {
        set((state) => ({
          pluginStates: mergePluginState(state.pluginStates, pluginId, { mcpEnabled }),
        }))
      },

      resetPluginState: (pluginId) => {
        set((state) => {
          const rest = { ...state.pluginStates }
          delete rest[pluginId]
          return { pluginStates: rest }
        })
      },
    }),
    {
      name: 'plugin-store',
      partialize: (state) => ({
        pluginStates: state.pluginStates,
      }),
    }
  )
)
