export { pluginRegistry } from './registry'
export { pluginIconMap } from './icons'
export {
  listEnabledPluginMcpServers,
  listPluginMcpServerStatuses,
  type PluginMcpServerStatus,
} from './mcp'
export type {
  PluginIconId,
  PluginId,
  PluginMcpServerContribution,
  PluginPermissionDeclaration,
  PluginViewArea,
  PluginViewContribution,
  PolarisPluginManifest,
} from './types'

import './builtinPlugins'
