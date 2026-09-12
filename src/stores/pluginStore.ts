/**
 * 插件状态管理
 *
 * 第一阶段仅管理前端本地启用状态。后续可切换到 Tauri 后端持久化。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { loadPluginStates, savePluginStates } from '@/services/pluginStateService'
import { createLogger } from '@/utils/logger'

const log = createLogger('PluginStore')

export interface PluginState {
  enabled: boolean
  uiEnabled: boolean
  mcpEnabled: boolean
  mcpServers?: Record<string, PluginMcpServerState>
}

export interface PluginMcpServerState {
  enabled: boolean
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
  isPluginMcpServerEnabled: (pluginId: string, serverId: string) => boolean
  setPluginEnabled: (pluginId: string, enabled: boolean) => void
  setPluginUiEnabled: (pluginId: string, uiEnabled: boolean) => void
  setPluginMcpEnabled: (pluginId: string, mcpEnabled: boolean) => void
  setPluginMcpServerEnabled: (pluginId: string, serverId: string, enabled: boolean) => void
  resetPluginState: (pluginId: string) => void
}

export type PluginStore = PluginStoreState & PluginStoreActions

export const DEFAULT_PLUGIN_STATE: PluginState = {
  enabled: true,
  uiEnabled: true,
  mcpEnabled: true,
}

/**
 * 插件可见性默认值（来自 manifest `enabledByDefault`，由 pluginRegistry 注册）。
 *
 * 语义（单一权威源修复，见 plans/plugin-visibility-plan.md）：
 * `enabledByDefault` 只表达"无用户记录时的初始 uiEnabled 默认值"，
 * 不再是注册表硬过滤。运行时唯一可见性门 = `isPluginUiEnabled`。
 * 无用户记录时：插件功能/MCP 默认启用，仅 UI 贡献按 manifest 默认值。
 */
const manifestDefaultUi = new Map<string, boolean>()

/** 注册插件 manifest 的 `enabledByDefault` 默认值（registry 注册清单时调用） */
export function registerPluginDefaultUi(pluginId: string, enabledByDefault: boolean): void {
  manifestDefaultUi.set(pluginId, enabledByDefault)
}

/** 清除插件默认值（卸载/替换时调用，防陈旧） */
export function clearPluginDefaultUi(pluginId: string): void {
  manifestDefaultUi.delete(pluginId)
}

/** 读取插件可见性默认值（未注册默认 true，与历史行为一致） */
export function getPluginDefaultUi(pluginId: string): boolean {
  return manifestDefaultUi.get(pluginId) ?? true
}

export function getEffectivePluginState(
  pluginStates: PluginStateMap,
  pluginId: string
): PluginState {
  const record = pluginStates[pluginId]
  if (record) return record
  // 无用户记录：回退到 manifest enabledByDefault（仅约束 UI 贡献可见性）
  const uiEnabled = getPluginDefaultUi(pluginId)
  return { enabled: true, uiEnabled, mcpEnabled: true }
}

export function isPluginUiEnabled(pluginStates: PluginStateMap, pluginId: string): boolean {
  const state = getEffectivePluginState(pluginStates, pluginId)
  return state.enabled && state.uiEnabled
}

export function isPluginMcpEnabled(pluginStates: PluginStateMap, pluginId: string): boolean {
  const state = getEffectivePluginState(pluginStates, pluginId)
  return state.enabled && state.mcpEnabled
}

export function isPluginMcpServerEnabled(
  pluginStates: PluginStateMap,
  pluginId: string,
  serverId: string,
  defaultEnabled = true
): boolean {
  const state = pluginStates[pluginId]
  const pluginMcpEnabled = state
    ? state.enabled && state.mcpEnabled
    : defaultEnabled

  if (!pluginMcpEnabled) {
    return false
  }

  return state?.mcpServers?.[serverId]?.enabled ?? true
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
    log.warn('Failed to persist plugin states to backend', { error })
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

      isPluginMcpServerEnabled: (pluginId, serverId) =>
        isPluginMcpServerEnabled(get().pluginStates, pluginId, serverId),

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

      setPluginMcpServerEnabled: (pluginId, serverId, enabled) => {
        const current = getEffectivePluginState(get().pluginStates, pluginId)
        const pluginStates = mergePluginState(get().pluginStates, pluginId, {
          mcpServers: {
            ...(current.mcpServers ?? {}),
            [serverId]: { enabled },
          },
        })
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
