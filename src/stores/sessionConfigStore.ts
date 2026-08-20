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
  ProfileMode,
} from '@/types/sessionConfig'
import { DEFAULT_SESSION_CONFIG } from '@/types/sessionConfig'

/**
 * 清洗会话配置：剔除废弃值，并用默认值补全缺失字段。
 * 用于 persist 反序列化（merge）时兜底，兼容旧版本持久化数据。
 * - effort='max' → 回退默认（'max' 已废弃）
 * - permissionMode 保留持久化值（默认值已为 bypassPermissions，见 DEFAULT_SESSION_CONFIG）
 */
export function normalizeSessionConfig(config: SessionRuntimeConfig | undefined): SessionRuntimeConfig {
  const c = config ?? {}
  return {
    ...DEFAULT_SESSION_CONFIG,
    ...c,
    effort: c.effort === 'max' ? DEFAULT_SESSION_CONFIG.effort : c.effort ?? DEFAULT_SESSION_CONFIG.effort,
    permissionMode: c.permissionMode ?? DEFAULT_SESSION_CONFIG.permissionMode,
    // 旧持久化数据无 profileMode：默认「profile」语义（modelProfileId 为空即官方，
    // 与旧行为完全一致）；显式 official/group 才区别于旧行为。
    profileMode: c.profileMode ?? DEFAULT_SESSION_CONFIG.profileMode,
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
  setProfileMode: (mode: ProfileMode) => void
  setProviderGroupId: (groupId: string) => void
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
        set((state) => {
          // 空串 / 未传 = 仅清空单 Profile，不改变当前模式（保持 group/official 语义）。
          //  场景：激活分组后取消勾选单 Profile，不应把 profileMode 强制覆盖回 'profile'。
          if (!modelProfileId) {
            return { config: { ...state.config, modelProfileId: '' } }
          }
          // 非空 = 选择单 Profile，同步把模式置为 profile（互斥清理，避免「group 却残留 profileId」穿帮）
          return { config: { ...state.config, modelProfileId, profileMode: 'profile' } }
        }),

      /** 设置供应商模式（official/group/profile）。
       *  mode=official|group 时清空 modelProfileId（官方/分组都不绑定单 Profile）；
       *  mode=profile 时保留 modelProfileId（由调用方先 setModelProfileId 或随后设置）。
       */
      setProfileMode: (mode) =>
        set((state) => {
          const next: SessionRuntimeConfig = { ...state.config, profileMode: mode }
          if (mode === 'official' || mode === 'group') {
            next.modelProfileId = ''
          }
          return { config: next }
        }),

      /** 设置会话/全局选中的供应商分组 ID（配合 profileMode='group' 使用）。
       *  不改变 profileMode（由调用方先 setProfileMode 或保持现状）。 */
      setProviderGroupId: (providerGroupId) =>
        set((state) => ({
          config: { ...state.config, providerGroupId },
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
    Boolean(config.modelProfileId && config.modelProfileId !== DEFAULT_SESSION_CONFIG.modelProfileId) ||
    (config.profileMode ?? 'profile') !== DEFAULT_SESSION_CONFIG.profileMode
  )
}
