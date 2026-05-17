import type { LeftPanelType } from '@/stores/viewStore'

export type PluginId = string

export type PluginViewArea = 'activityBar'

export type PluginIconId =
  | 'Files'
  | 'GitPullRequest'
  | 'CheckSquare'
  | 'Languages'
  | 'Clock'
  | 'Target'
  | 'ClipboardList'
  | 'Terminal'
  | 'Code2'
  | 'Bot'
  | 'BookOpen'
  | 'AlertCircle'

export type PluginLeftPanelType = Exclude<LeftPanelType, 'none' | 'tools'>

export interface PluginViewContribution {
  id: string
  pluginId: PluginId
  area: PluginViewArea
  panelType: PluginLeftPanelType
  icon: PluginIconId
  labelKey: string
  labelDefault?: string
  order: number
  badge?: 'problems'
}

export interface PluginMcpServerContribution {
  id: string
  pluginId: PluginId
  transport: 'stdio' | 'http'
  command: string
  argsTemplate?: string[]
}

export interface PluginPermissionDeclaration {
  workspaceRead?: boolean
  workspaceWrite?: boolean
  appConfigRead?: boolean
  appConfigWrite?: boolean
  network?: boolean
  aiToolAccess?: boolean
  /**
   * Allowlist of IPC command and event names this plugin may pass through
   * `PolarisPluginApi.transport.invoke` / `transport.listen`.
   *
   * Entries support exact match (`"read_file"`) and suffix glob
   * (`"knowledge_*"`). An absent or empty array is treated as deny-all.
   * See `src/plugin-system/runtime/transport.ts` for the matcher.
   */
  ipc?: string[]
}

export type PluginSourceKind = 'builtin' | 'user' | 'project'

export interface PluginManifestSource {
  kind: PluginSourceKind
  workspacePath?: string
}

export interface PluginOriginMetadata {
  repository?: string
  homepage?: string
  updateUrl?: string
  downloadUrl?: string
}

export interface PolarisPluginManifest {
  id: PluginId
  name: string
  version: string
  description?: string
  builtin: boolean
  enabledByDefault: boolean
  contributes: {
    views?: Omit<PluginViewContribution, 'pluginId'>[]
    mcpServers?: Omit<PluginMcpServerContribution, 'pluginId'>[]
  }
  permissions: PluginPermissionDeclaration
  origin?: PluginOriginMetadata
  source?: PluginManifestSource
  installPath?: string
}
