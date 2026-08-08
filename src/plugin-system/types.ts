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
  | 'Globe2'
  | 'Activity'
  | 'Users'

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

/**
 * 聊天卡片渲染模式
 * - result: 展示型。消费 MCP 工具返回结果，追加独立卡片渲染（Rust 零改动）
 * - interaction: 交互型。插件 MCP server 经伴生通道请求同回合用户输入，
 *   卡片提交后回填 tool_result 给 AI（复用 ask 通道）
 */
export type PluginChatCardMode = 'result' | 'interaction'

/**
 * 聊天卡片贡献点声明（manifest.contributes.chatCards[]）
 *
 * 按完整工具名 `mcp__{mcpServerId}__{tool}` 匹配 → 由插件自定义渲染。
 * 安全约束：mcpServerId 必须属于本插件声明的 mcpServers[].id，
 * 防止插件劫持内置工具或其他插件的渲染。
 */
export interface PluginChatCardContribution {
  /** 插件内唯一 id */
  id: string
  /** 归属插件 id（注册时注入） */
  pluginId: PluginId
  /** React 组件入口（外部插件相对 installPath；内置插件手动注册 loader，可省略） */
  entry?: string
  /** 目标 MCP server id，必须属于本插件的 mcpServers 声明 */
  mcpServerId: string
  /** server 内工具名列表（不含 mcp__ 前缀） */
  tools: string[]
  /** 渲染模式，默认 result */
  mode: PluginChatCardMode
}

/**
 * 引擎贡献点声明（manifest.contributes.engines[]）
 *
 * 声明一个 AI 引擎，由后端 PluginEngineRunner 自动适配。
 * 用户安装插件后，该引擎立即可在引擎选择器中使用。
 */
/**
 * Provider 注册声明（声明式 provider 注册）
 *
 * 不同 Pi fork / CLI 注册自定义 provider 端点的方式不同：
 * - Pi: 写 `~/.pi/agent/models.json`，api="openai-chat-completions"，用 --provider/--model 选择
 * - omp: 写 `~/.omp/agent/models.yml`，api="openai-completions"，用 --provider/--model 选择
 *
 * 由插件 manifest 声明，PluginEngine 据此写配置文件并传 CLI 参数。
 */
export interface PluginEngineProviderConfigContribution {
  /** 配置文件路径（相对 CLI 配置根目录，如 "agent/models.yml"） */
  configFile: string
  /** 配置文件格式（"yaml" / "json"） */
  format?: 'yaml' | 'json'
  /** 写入 provider 条目的 API 协议枚举值（如 "openai-completions"） */
  apiValue: string
  /** 选择 provider 的 CLI 参数名（如 "--provider"），缺省则不传 */
  providerArg?: string
  /** 传递 model 名的 CLI 参数名（如 "--model"），缺省则不传 */
  modelArg?: string
  /** CLI 配置根目录的环境变量名（缺省则按 CLI id 推断 ~/.<id>/） */
  configDirEnv?: string
}

export interface PluginEngineContribution {
  /** 引擎 ID（如 "omp"） */
  id: string
  /** 显示名称（如 "Oh My Pi"） */
  name: string
  /** 引擎描述 */
  description: string
  /** CLI 入口配置 */
  cli: {
    /** 命令（如 "omp"） */
    command: string
    /** 启动参数 */
    args?: string[]
    /** 安装指引文本 */
    installGuide?: string
  }
  /** RPC 协议类型，默认 pi-rpc */
  protocol?: 'pi-rpc' | 'json-rpc' | 'command'
  /** Session ID CLI 标志风格，默认 'pi'（--session-id / --session） */
  sessionFlags?: 'pi' | 'omp'
  /** Provider 注册声明（声明式：CLI 如何注册自定义 provider 端点） */
  providerConfig?: PluginEngineProviderConfigContribution
  /** 引擎能力声明 */
  capabilities?: {
    tools?: boolean
    streaming?: boolean
    interrupt?: boolean
    resume?: boolean
  }
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
  /** 标记为废弃待移除（true=通用，string=具体说明） */
  deprecated?: boolean | string
  contributes: {
    views?: Omit<PluginViewContribution, 'pluginId'>[]
    mcpServers?: Omit<PluginMcpServerContribution, 'pluginId'>[]
    services?: Omit<PluginServiceContribution, 'pluginId'>[]
    panel?: PluginPanelContribution
    chatCards?: Omit<PluginChatCardContribution, 'pluginId'>[]
    engines?: PluginEngineContribution[]
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

/**
 * 聊天卡片渲染状态
 * - ready: 展示型数据就绪
 * - pending: 交互型等待用户操作
 * - answered: 交互型已提交
 * - declined: 交互型被跳过/超时
 * - failed: 结果解析或渲染失败
 */
export type PluginChatCardStatus = 'ready' | 'pending' | 'answered' | 'declined' | 'failed'

/**
 * 传给插件卡片组件的 props 契约（对插件开发者暴露的 API）
 */
export interface PluginChatCardProps {
  /** 归属插件 id */
  pluginId: string
  /** 贡献点 id（chatCards[].id） */
  cardId: string
  /** 完整工具名 mcp__{server}__{tool}，兜底展示用 */
  toolName: string
  /** 渲染模式 */
  mode: PluginChatCardMode
  /** 渲染状态 */
  status: PluginChatCardStatus
  /**
   * 卡片数据。
   * - result 模式：MCP 工具结果的最佳解析（结构化对象或原始字符串）
   * - interaction 模式：伴生进程发来的请求 payload
   */
  data: unknown
  /** interaction 模式已提交的应答（历史恢复时回显） */
  response?: unknown
  /** 注入下一轮聊天消息（展示型可用） */
  onSendToChat?: (message: string) => void | Promise<void>
  /** 提交应答（仅 interaction 且 status === 'pending' 时提供） */
  respond?: (result: unknown) => Promise<void>
}

export type PluginChatCardComponent = ComponentType<PluginChatCardProps>

export type PluginChatCardLoader = () => Promise<{ default: PluginChatCardComponent }>
