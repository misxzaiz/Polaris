import type { ComponentType } from 'react'

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
  | 'Film'
  | 'Activity'

export type PluginLeftPanelType = string

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

export type PluginServiceType = 'http' | 'stdio' | 'worker'

export interface PluginServiceContribution {
  id: string
  pluginId: PluginId
  type: PluginServiceType
  command: string
  argsTemplate?: string[]
  port?: number
  healthCheck?: string
  healthCheckTimeout?: number
  autoStart?: boolean
  restartOnFailure?: boolean
  maxRestarts?: number
  description?: string
}

export type PluginServiceState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error'

export interface PluginServiceStatus {
  serviceId: string
  pluginId: PluginId
  state: PluginServiceState
  port?: number
  pid?: number
  uptime?: number
  lastError?: string
  restartCount: number
}

export interface PluginPanelContribution {
  entry: string
  /** 是否支持全屏模式（隐藏其他面板，自适应填充整个工作区） */
  supportsFullscreen?: boolean
}

export interface PluginPermissionDeclaration {
  workspaceRead?: boolean
  workspaceWrite?: boolean
  appConfigRead?: boolean
  appConfigWrite?: boolean
  network?: boolean
  aiToolAccess?: boolean
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
    services?: Omit<PluginServiceContribution, 'pluginId'>[]
    panel?: PluginPanelContribution
  }
  permissions: PluginPermissionDeclaration
  origin?: PluginOriginMetadata
  source?: PluginManifestSource
  installPath?: string
}

export type PluginPanelComponent = ComponentType<{
  pluginId: string
  onSendToChat?: (message: string) => void | Promise<void>
}>

export type PluginPanelLoader = () => Promise<{ default: PluginPanelComponent }>
