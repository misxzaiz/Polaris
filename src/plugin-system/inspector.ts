/**
 * PluginInspector — 运行时插件树自省（P3-T4）
 *
 * 提供查询当前已加载插件、MCP server、Provider 覆盖状态的接口。
 * 用于「插件诊断」面板展示。
 */

import { pluginRegistry } from './registry'
import { listPluginMcpServerStatuses } from './mcp'
import { usePluginStore } from '@/stores/pluginStore'
import type { PolarisPluginManifest } from './types'

export interface PluginInfo {
  id: string
  name: string
  version: string
  builtin: boolean
  enabledByDefault: boolean
  enabled: boolean
  description?: string
  viewCount: number
  mcpServerCount: number
  toolProviderCount: number
  chatCardCount: number
}

export interface McpServerInfo {
  id: string
  pluginId: string
  transport: 'stdio' | 'http'
  command: string
  enabled: boolean
}

export interface ProviderInfo {
  capability: string
  mcpServerId: string
  pluginId: string
  description?: string
}

export interface SlotOverrideInfo {
  slotId: string
  mode: 'shadow' | 'chain'
  pluginId: string
  panelType: string
}

/**
 * 插件诊断信息快照
 */
export interface PluginDiagnostics {
  plugins: PluginInfo[]
  mcpServers: McpServerInfo[]
  toolProviders: ProviderInfo[]
  slotOverrides: SlotOverrideInfo[]
  totalPlugins: number
  enabledPlugins: number
  totalMcpServers: number
  totalToolProviders: number
  totalSlotOverrides: number
}

/**
 * 插件诊断服务
 */
export const pluginInspector = {
  /**
   * 获取完整插件诊断快照
   */
  getDiagnostics(): PluginDiagnostics {
    const pluginStates = usePluginStore.getState().pluginStates
    const manifests = pluginRegistry.listPlugins()

    const plugins: PluginInfo[] = manifests.map((m) => {
      const state = pluginStates[m.id]
      const enabled = state ? state.enabled : m.enabledByDefault
      return {
        id: m.id,
        name: m.name,
        version: m.version,
        builtin: m.builtin,
        enabledByDefault: m.enabledByDefault,
        enabled,
        description: m.description,
        viewCount: m.contributes.views?.length ?? 0,
        mcpServerCount: m.contributes.mcpServers?.length ?? 0,
        toolProviderCount: m.contributes.toolProviders?.length ?? 0,
        chatCardCount: m.contributes.chatCards?.length ?? 0,
      }
    })

    const mcpServerStatuses = listPluginMcpServerStatuses(pluginStates)
    const mcpServers: McpServerInfo[] = mcpServerStatuses.map((s) => ({
      id: s.id,
      pluginId: s.pluginId,
      transport: s.transport,
      command: s.command,
      enabled: s.enabled,
    }))

    const toolProviders: ProviderInfo[] = pluginRegistry
      .listToolProviderContributions()
      .map((tp) => ({
        capability: tp.capability,
        mcpServerId: tp.mcpServerId,
        pluginId: tp.pluginId,
        description: tp.description,
      }))

    const views = pluginRegistry.listViewContributions('activityBar')
    const slotOverrides: SlotOverrideInfo[] = views
      .filter((v) => v.slot && v.slotMode && v.slotMode !== 'append')
      .map((v) => ({
        slotId: v.slot!,
        mode: v.slotMode as 'shadow' | 'chain',
        pluginId: v.pluginId,
        panelType: v.panelType,
      }))

    return {
      plugins,
      mcpServers,
      toolProviders,
      slotOverrides,
      totalPlugins: plugins.length,
      enabledPlugins: plugins.filter((p) => p.enabled).length,
      totalMcpServers: mcpServers.filter((s) => s.enabled).length,
      totalToolProviders: toolProviders.length,
      totalSlotOverrides: slotOverrides.length,
    }
  },

  /**
   * 检查某 capability 是否被插件覆盖
   */
  isCapabilityOverridden(capability: string): boolean {
    return pluginRegistry
      .listToolProviderContributions()
      .some((tp) => tp.capability === capability)
  },

  /**
   * 检查某 slot 是否被 shadow 覆盖
   */
  isSlotShadowed(slotId: string): boolean {
    return pluginRegistry.getShadowedSlot(slotId) !== undefined
  },

  /**
   * 获取插件 manifest 详情
   */
  getPluginDetail(pluginId: string): PolarisPluginManifest | undefined {
    return pluginRegistry.listPlugins().find((p) => p.id === pluginId)
  },
}
