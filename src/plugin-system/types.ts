import type { ModuleId, SlotId } from '@/types/layout'

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

export interface PluginViewContribution {
  id: string
  pluginId: PluginId
  area: PluginViewArea
  /** 模块 id (与布局系统的 layoutStore SlotState.modules 对齐) */
  moduleId: ModuleId
  icon: PluginIconId
  labelKey: string
  labelDefault?: string
  order: number
  badge?: 'problems'
  /** 允许放置的槽位; 未指定时 = 所有非 center 槽位 */
  allowedSlots?: readonly SlotId[]
  /** 首次加入布局时使用的默认槽位 */
  defaultSlot?: SlotId
  /** 模块在槽位中的建议初始尺寸 (px) */
  preferredSize?: number
  /**
   * 模块自带容器结构,SlotPanel 不再包装外层 (如 Chat 模块自带 ChatInput/StatusBar)。
   * 默认 false: 走 SlotPanel 通用容器 + Tab 切换。
   */
  bareRender?: boolean
  /**
   * 模块需要 keep-alive: 切换 Tab 时不 unmount, 改用 display:none 保留状态.
   * 适合持有重资源/状态的模块 (Terminal/Editor — xterm 实例/PTY 连接/未提交输入).
   * 默认 false: 切换 Tab 走 mount/unmount, 让无状态模块释放内存.
   */
  keepAlive?: boolean
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
