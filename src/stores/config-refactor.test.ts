//! 配置系统重构测试
//!
//! 验证:applyConfig 同步链 / setter 回滚 / plugin config 读写

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { create } from 'zustand'

// Mock transport index（含 invoke + listen + currentMode + auth）
const mockInvoke = vi.fn()
vi.mock('@/services/transport', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
  currentMode: 'tauri',
  listen: vi.fn().mockResolvedValue(() => {}),
}))
vi.mock('@/services/transport/auth', () => ({
  storeTokenMd5: vi.fn(),
  md5Hex: vi.fn().mockResolvedValue('mock-md5'),
}))

// Mock i18n
vi.mock('@/i18n', () => ({
  default: { changeLanguage: vi.fn() },
}))

// Mock logger
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

// Mock themeEngine
vi.mock('@/services/themeEngine', () => ({
  saveLegacySpiderManConfig: vi.fn(),
}))

import { applyConfig } from '@/stores/configStore'
import type { Config } from '@/types'

describe('applyConfig 统一副作用入口', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('空配置不抛错', async () => {
    const config = {} as Config
    await expect(applyConfig(config)).resolves.not.toThrow()
  })

  it('language 字段触发 i18n.changeLanguage', async () => {
    const i18n = (await import('@/i18n')).default
    const config = { language: 'en-US' } as Config
    await applyConfig(config)
    expect(i18n.changeLanguage).toHaveBeenCalledWith('en-US')
  })

  it('spidermanTheme 字段触发 saveLegacySpiderManConfig', async () => {
    const { saveLegacySpiderManConfig } = await import('@/services/themeEngine')
    const config = { spidermanTheme: { bgOpacity: 0.5 } } as unknown as Config
    await applyConfig(config)
    expect(saveLegacySpiderManConfig).toHaveBeenCalledWith({ bgOpacity: 0.5 })
  })

  it('镜像为空时注入后端全局默认 activeModelProfileId', async () => {
    const { useSessionConfig } = await import('@/stores/sessionConfigStore')
    useSessionConfig.getState().resetConfig()
    const config = {
      activeModelProfileId: 'backend-default',
      modelProfiles: [{ id: 'backend-default', model: 'x', baseUrl: 'http://x', name: 'x' }],
    } as unknown as Config
    await applyConfig(config)
    expect(useSessionConfig.getState().config.modelProfileId).toBe('backend-default')
  })

  it('悬空镜像（Profile 已删除）清理并回退后端默认', async () => {
    const { useSessionConfig } = await import('@/stores/sessionConfigStore')
    // 模拟持久化残留：镜像指向一个后端已不存在的 Profile
    useSessionConfig.getState().setModelProfileId('deleted-profile')
    useSessionConfig.getState().setProfileMode('profile')
    const config = {
      activeModelProfileId: 'backend-default',
      modelProfiles: [{ id: 'backend-default', model: 'x', baseUrl: 'http://x', name: 'x' }],
    } as unknown as Config
    await applyConfig(config)
    expect(useSessionConfig.getState().config.modelProfileId).toBe('backend-default')
  })

  it('镜像非空且 Profile 存在时保留手动选择（不被后端默认覆盖）', async () => {
    const { useSessionConfig } = await import('@/stores/sessionConfigStore')
    // 用户手动选了 profile-a，后端默认是 backend-default → 镜像应保留 profile-a
    useSessionConfig.getState().setModelProfileId('profile-a')
    useSessionConfig.getState().setProfileMode('profile')
    const config = {
      activeModelProfileId: 'backend-default',
      modelProfiles: [
        { id: 'profile-a', model: 'a', baseUrl: 'http://a', name: 'a' },
        { id: 'backend-default', model: 'b', baseUrl: 'http://b', name: 'b' },
      ],
    } as unknown as Config
    await applyConfig(config)
    expect(useSessionConfig.getState().config.modelProfileId).toBe('profile-a')
  })
})

describe('sessionConfigStore persist 收敛', () => {
  it('partialize 含 agent/model/effort/permissionMode 及供应商三态', async () => {
    const { useSessionConfig } = await import('@/stores/sessionConfigStore')
    const state = useSessionConfig.getState()
    // 模拟 persist 的 partialize
    const persistApi = (useSessionConfig as unknown as { persist: { getOptions: () => { partialize: (s: typeof state) => unknown } } })
    const partialize = persistApi.persist.getOptions().partialize
    const partial = partialize(state) as { config: Record<string, unknown> }
    expect(partial.config).toHaveProperty('agent')
    expect(partial.config).toHaveProperty('model')
    expect(partial.config).toHaveProperty('effort')
    expect(partial.config).toHaveProperty('permissionMode')
    // 方案 A：持久化供应商三态，状态栏手动选择（Profile/分组/官方）刷新后保留
    expect(partial.config).toHaveProperty('modelProfileId')
    expect(partial.config).toHaveProperty('profileMode')
    expect(partial.config).toHaveProperty('providerGroupId')
  })
})

describe('workspaceStore persist 收敛', () => {
  it('partialize 不含 workspaces/currentWorkspaceId', async () => {
    const { useWorkspaceStore } = await import('@/stores/workspaceStore')
    const state = useWorkspaceStore.getState()
    const persistApi = (useWorkspaceStore as unknown as { persist: { getOptions: () => { partialize: (s: typeof state) => unknown } } })
    const partialize = persistApi.persist.getOptions().partialize
    const partial = partialize(state) as Record<string, unknown>
    // 仅保留纯本机 UI 态
    expect(partial).toHaveProperty('contextWorkspaceIds')
    expect(partial).toHaveProperty('viewingWorkspaceId')
    // 不应持久化派生字段
    expect(partial).not.toHaveProperty('workspaces')
    expect(partial).not.toHaveProperty('currentWorkspaceId')
  })
})

describe('pluginConfig API', () => {
  it('getPluginConfig 调用 plugin_get_config', async () => {
    mockInvoke.mockResolvedValueOnce({ apiKey: 'test' })
    const { getPluginConfig } = await import('@/plugin-system/pluginConfig')
    const result = await getPluginConfig('test.plugin')
    expect(mockInvoke).toHaveBeenCalledWith('plugin_get_config', { pluginId: 'test.plugin' })
    expect(result).toEqual({ apiKey: 'test' })
  })

  it('setPluginConfig 调用 plugin_set_config with patch', async () => {
    mockInvoke.mockResolvedValueOnce({ apiKey: 'new' })
    const { setPluginConfig } = await import('@/plugin-system/pluginConfig')
    const result = await setPluginConfig('test.plugin', { apiKey: 'new' })
    expect(mockInvoke).toHaveBeenCalledWith('plugin_set_config', {
      pluginId: 'test.plugin',
      patch: { apiKey: 'new' },
    })
    expect(result).toEqual({ apiKey: 'new' })
  })

  it('getPluginConfigField 返回单字段', async () => {
    mockInvoke.mockResolvedValueOnce({ apiKey: 'field-test', other: 'x' })
    const { getPluginConfigField } = await import('@/plugin-system/pluginConfig')
    const result = await getPluginConfigField('test.plugin', 'apiKey')
    expect(result).toBe('field-test')
  })
})
