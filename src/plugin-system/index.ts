export { pluginRegistry } from './registry'
export { pluginPanelRegistry } from './panelRegistry'
export { chatCardRegistry } from './chatCardRegistry'
export { pluginIconMap } from './icons'
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
  PluginIconId,
  PluginId,
  PluginLeftPanelType,
  PluginMcpServerContribution,
  PluginPanelComponent,
  PluginPanelContribution,
  PluginPanelLoader,
  PluginPermissionDeclaration,
  PluginViewArea,
  PluginViewContribution,
  PolarisPluginManifest,
} from './types'

import './builtinPlugins'
