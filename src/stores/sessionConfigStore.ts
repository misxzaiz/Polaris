/**
 * 会话配置 Store
 *
 * 管理会话级别的 CLI 配置：Agent、Model、Effort、PermissionMode
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  SessionRuntimeConfig,
  EffortLevel,
  PermissionMode,
} from '@/types/sessionConfig'
import { DEFAULT_SESSION_CONFIG } from '@/types/sessionConfig'

/**
 * 清洗会话配置：剔除废弃值，并用默认值补全缺失字段。
 * 用于 persist 反序列化（merge）时兜底，兼容旧版本持久化数据。
 * - effort='max' → 回退默认（'max' 已废弃）
 * - permissionMode 保留持久化值（默认值已为 bypassPermissions，见 DEFAULT_SESSION_CONFIG）
 */
export function normalizeSessionConfig(config: SessionRuntimeConfig | undefined): SessionRuntimeConfig {
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...(config ?? {}),
    effort: config?.effort === 'max' ? DEFAULT_SESSION_CONFIG.effort : config?.effort ?? DEFAULT_SESSION_CONFIG.effort,
    permissionMode: config?.permissionMode ?? DEFAULT_SESSION_CONFIG.permissionMode,
  }
}

interface SessionConfigState {
  /** 当前会话配置 */
  config: SessionRuntimeConfig

  // Actions
  setAgent: (agent: string) => void
  setModel: (model: string) => void
  setEffort: (effort: EffortLevel) => void
  setPermissionMode: (mode: PermissionMode) => void
  setModelProfileId: (profileId: string) => void
  setConfig: (config: Partial<SessionRuntimeConfig>) => void
  resetConfig: () => void
}

/**
 * 会话配置 Store
 *
 * 使用 persist 中间件，配置会保存到 localStorage
 */
export const useSessionConfig = create<SessionConfigState>()(
  persist(
    (set) => ({
      config: { ...DEFAULT_SESSION_CONFIG },

      setAgent: (agent) =>
        set((state) => ({
          config: { ...state.config, agent },
        })),

      setModel: (model) =>
        set((state) => ({
          config: { ...state.config, model },
        })),

      setEffort: (effort) =>
        set((state) => ({
          config: { ...state.config, effort },
        })),

      setPermissionMode: (permissionMode) =>
        set((state) => ({
          config: { ...state.config, permissionMode },
        })),

      setModelProfileId: (modelProfileId) =>
        set((state) => ({
          config: { ...state.config, modelProfileId },
        })),

      setConfig: (newConfig) =>
        set((state) => ({
          config: { ...state.config, ...newConfig },
        })),

      resetConfig: () =>
        set({ config: { ...DEFAULT_SESSION_CONFIG } }),
    }),
    {
      name: 'polaris-session-config',
      partialize: (state) => ({ config: state.config }),
      // 反序列化时清洗废弃值（effort='max' / permissionMode='bypassPermissions'），
      // 并用 DEFAULT_SESSION_CONFIG 补全缺失字段（兼容旧版本持久化数据）。
      merge: (persistedState, currentState) => {
        const persisted = persistedState as { config?: SessionRuntimeConfig } | undefined
        return {
          ...currentState,
          config: normalizeSessionConfig(persisted?.config),
        }
      },
    }
  )
)

/**
 * 获取会话配置（用于传递给后端）
 */
export function getSessionConfig(): SessionRuntimeConfig {
  return useSessionConfig.getState().config
}

/**
 * 检查是否有非默认配置
 */
export function hasCustomConfig(): boolean {
  const config = useSessionConfig.getState().config
  return (
    config.agent !== DEFAULT_SESSION_CONFIG.agent ||
    config.model !== DEFAULT_SESSION_CONFIG.model ||
    config.effort !== DEFAULT_SESSION_CONFIG.effort ||
    config.permissionMode !== DEFAULT_SESSION_CONFIG.permissionMode ||
    Boolean(config.modelProfileId && config.modelProfileId !== DEFAULT_SESSION_CONFIG.modelProfileId)
  )
}
