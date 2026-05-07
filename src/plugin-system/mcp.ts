import type { PluginMcpServerContribution } from './types'
import { pluginRegistry } from './registry'
import { isPluginMcpEnabled, type PluginStateMap } from '@/stores/pluginStore'

export interface PluginMcpServerStatus extends PluginMcpServerContribution {
  enabled: boolean
}

export function listPluginMcpServerStatuses(
  pluginStates: PluginStateMap
): PluginMcpServerStatus[] {
  return pluginRegistry
    .listMcpServerContributions()
    .map((server) => ({
      ...server,
      enabled: isPluginMcpEnabled(pluginStates, server.pluginId),
    }))
}

export function listEnabledPluginMcpServers(
  pluginStates: PluginStateMap
): PluginMcpServerContribution[] {
  return listPluginMcpServerStatuses(pluginStates)
    .filter((server) => server.enabled)
    .map((server) => ({
      id: server.id,
      pluginId: server.pluginId,
      transport: server.transport,
      command: server.command,
      argsTemplate: server.argsTemplate,
    }))
}
