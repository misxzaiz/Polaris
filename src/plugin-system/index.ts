export { pluginRegistry } from './registry'
export { pluginPanelRegistry } from './panelRegistry'
export { chatCardRegistry } from './chatCardRegistry'
export { pluginIconMap } from './icons'
export { pluginInspector } from './inspector'
export { applyPluginStyles, removeStyles } from './styles'
export type {
  PluginDiagnostics,
  PluginInfo,
  McpServerInfo,
  ProviderInfo,
  SlotOverrideInfo,
} from './inspector'
export {
  listEnabledPluginMcpServers,
  listPluginMcpServerStatuses,
  type PluginMcpServerStatus,
} from './mcp'
export type {
  PluginChatCardComponent,
  PluginChatCardContribution,
  PluginChatCardLoader,
  PluginChatCardMode,
  PluginChatCardProps,
  PluginChatCardStatus,
  PluginEngineContribution,
  PluginIconId,
  PluginId,
  PluginLeftPanelType,
  PluginMcpServerContribution,
  PluginPanelComponent,
  PluginPanelContribution,
  PluginPanelLoader,
  PluginPermissionDeclaration,
  PluginStyleContribution,
  PluginToolProviderContribution,
  PluginViewArea,
  PluginViewContribution,
  PluginViewSlotMode,
  PolarisPluginManifest,
} from './types'

import './builtinPlugins'
