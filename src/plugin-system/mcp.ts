import type { PluginMcpServerContribution } from './types'
import { pluginRegistry } from './registry'
import { isPluginMcpServerEnabled, type PluginStateMap } from '@/stores/pluginStore'

export interface PluginMcpServerStatus extends PluginMcpServerContribution {
  enabled: boolean
}

export function listPluginMcpServerStatuses(
  pluginStates: PluginStateMap
): PluginMcpServerStatus[] {
  const pluginsById = new Map(pluginRegistry.listPlugins().map((plugin) => [plugin.id, plugin]))

  return pluginRegistry
    .listMcpServerContributions()
    .map((server) => ({
      ...server,
      enabled: isPluginMcpServerEnabled(
        pluginStates,
        server.pluginId,
        server.id,
        pluginsById.get(server.pluginId)?.enabledByDefault ?? true
      ),
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
