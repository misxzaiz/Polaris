/**
 * 插件状态管理
 *
 * 第一阶段仅管理前端本地启用状态。后续可切换到 Tauri 后端持久化。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { loadPluginStates, savePluginStates } from '../services/pluginStateService'

export interface PluginState {
  enabled: boolean
  uiEnabled: boolean
  mcpEnabled: boolean
}

export type PluginStateMap = Record<string, PluginState>

interface PluginStoreState {
  pluginStates: PluginStateMap
  isLoading: boolean
  error: string | null
  hydratedFromBackend: boolean
}

interface PluginStoreActions {
  loadPluginStates: () => Promise<void>
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

let saveQueue: Promise<void> = Promise.resolve()

function persistPluginStates(states: PluginStateMap): void {
  saveQueue = saveQueue.then(() => savePluginStates(states)).catch((error) => {
    console.warn('Failed to persist plugin states to backend', error)
  })
}

export const usePluginStore = create<PluginStore>()(
  persist(
    (set, get) => ({
      pluginStates: {},
      isLoading: false,
      error: null,
      hydratedFromBackend: false,

      loadPluginStates: async () => {
        set({ isLoading: true, error: null })

        try {
          const backendStates = await loadPluginStates()
          const currentStates = get().pluginStates
          const shouldMigrateLocalState =
            Object.keys(backendStates).length === 0 && Object.keys(currentStates).length > 0
          const pluginStates = shouldMigrateLocalState ? currentStates : backendStates

          set({
            pluginStates,
            isLoading: false,
            error: null,
            hydratedFromBackend: true,
          })

          if (shouldMigrateLocalState) {
            persistPluginStates(pluginStates)
          }
        } catch (error) {
          set({
            isLoading: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },

      getPluginState: (pluginId) => getEffectivePluginState(get().pluginStates, pluginId),

      isPluginEnabled: (pluginId) => get().getPluginState(pluginId).enabled,

      isPluginUiEnabled: (pluginId) => isPluginUiEnabled(get().pluginStates, pluginId),

      isPluginMcpEnabled: (pluginId) => isPluginMcpEnabled(get().pluginStates, pluginId),

      setPluginEnabled: (pluginId, enabled) => {
        const pluginStates = mergePluginState(get().pluginStates, pluginId, { enabled })
        set({ pluginStates })
        persistPluginStates(pluginStates)
      },

      setPluginUiEnabled: (pluginId, uiEnabled) => {
        const pluginStates = mergePluginState(get().pluginStates, pluginId, { uiEnabled })
        set({ pluginStates })
        persistPluginStates(pluginStates)
      },

      setPluginMcpEnabled: (pluginId, mcpEnabled) => {
        const pluginStates = mergePluginState(get().pluginStates, pluginId, { mcpEnabled })
        set({ pluginStates })
        persistPluginStates(pluginStates)
      },

      resetPluginState: (pluginId) => {
        const pluginStates = { ...get().pluginStates }
        delete pluginStates[pluginId]
        set({ pluginStates })
        persistPluginStates(pluginStates)
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
