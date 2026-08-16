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

/**
 * UI Slot 覆盖模式（P3-T1）
 *
 * - append（默认）：追加到 activityBar，新面板独立显示
 * - shadow：覆盖目标 slot 的默认渲染（原面板隐藏，插件面板替代）
 * - chain：在目标 slot 的渲染前后链式注入自定义内容
 *
 * slot 字段指定目标 slot id（如 "files.panel"）。
 * 省略 slot 时等价于 append 模式（向后兼容）。
 */
export type PluginViewSlotMode = 'append' | 'shadow' | 'chain'

export interface PluginViewContribution {
  id: string
  pluginId: PluginId
  area: PluginViewArea
  panelType: PluginLeftPanelType
  icon: PluginIconId
  labelKey: string
  labelDefault?: string
  order: number
  /** 目标 slot id（如 "files.panel"）；省略时为 append 模式 */
  slot?: string
  /** slot 覆盖模式，默认 append */
  slotMode?: PluginViewSlotMode
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

/**
 * MCP 消费策略 —— 插件引擎如何桥接 MCP 工具到子进程。
 *
 * - `mcp-servers`（默认）：直接注入 mcp_servers 列表（SimpleAI 风格，in-process 消费）。
 *   适用于引擎自身会通过 stdio 与 MCP server 通信的场景。
 * - `pi-extension`：Pi Extension 桥接风格。
 *   写 JS Extension 文件 + `--extension` 注入，子进程通过 `pi.registerTool()` 注册工具。
 *   适用于 OMP/Pi 等兼容 Pi Extension API 的 CLI。
 * - `mcp-config-path`：配置文件路径风格。
 *   写 MCP 配置文件（JSON）+ `--mcp-config <path>` 注入，Claude Code 风格。
 * - `none`：引擎不支持 MCP 工具。
 */
export type PluginEngineConsumptionStrategy =
  | 'mcp-servers'
  | 'pi-extension'
  | 'mcp-config-path'
  | 'none'

/**
 * 适配器进程声明 —— 描述插件引擎适配器进程的入口与协议。
 *
 * 声明后该引擎走 PluginProcessEngine（通过 stdin/stdout JSONRPC 与适配器进程通信），
 * 实现"加新引擎不改 Polaris 核心"。适配器进程负责与底层引擎 CLI 交互、
 * 把引擎事件翻译为 AIEvent 回传。
 */
export interface PluginEngineAdapterContribution {
  /** 适配器入口（相对插件 installPath 的可执行文件路径） */
  entry: string
  /** 运行 runtime（"node" / "python3" / "deno" / 空=直接执行） */
  runtime?: string
  /** 协议版本（"engine-v1"） */
  protocol: string
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
  /** 可通过 npm 全局安装的包名（如 "@earendil-works/pi-coding-agent"），声明后引擎页显示一键安装/卸载按钮 */
  npmPackage?: string
  /** 安装页面 URL（如 "https://omp.sh/install"），声明后引擎页显示「打开安装页面」按钮 */
  installUrl?: string
  /** RPC 协议类型，默认 pi-rpc */
  protocol?: 'pi-rpc' | 'json-rpc' | 'command'
  /** Session ID CLI 标志风格，默认 'pi'（--session-id / --session） */
  sessionFlags?: 'pi' | 'omp'
  /** Provider 注册声明（声明式：CLI 如何注册自定义 provider 端点） */
  providerConfig?: PluginEngineProviderConfigContribution
  /** MCP 消费策略（默认 'mcp-servers'，向后兼容） */
  mcpConsumption?: PluginEngineConsumptionStrategy
  /** 适配器进程声明（存在时走 PluginProcessEngine） */
  adapter?: PluginEngineAdapterContribution
  /** 引擎能力声明 */
  capabilities?: {
    tools?: boolean
    streaming?: boolean
    interrupt?: boolean
    resume?: boolean
  }
}

/**
 * 工具能力覆盖声明（manifest.contributes.toolProviders[]）
 *
 * 声明一个插件要接管哪个内置能力（如 shell / filesystem / compaction / subagent），
 * 由对应的 mcpServerId 提供实现。MCP 配置解析时，插件声明的 Provider 会
 * 替换同 capability 的内置实现。
 *
 * 安全约束：mcpServerId 必须属于本插件声明的 mcpServers[].id，
 * 防止插件劫持其他插件的 MCP server。
 */
export interface PluginToolProviderContribution {
  /** 能力标识（如 'shell' / 'filesystem' / 'compaction' / 'subagent'） */
  capability: string
  /** 提供该能力实现的 MCP server id，必须属于本插件的 mcpServers 声明 */
  mcpServerId: string
  /** 覆盖描述（UI 展示用） */
  description?: string
}

/**
 * 样式贡献声明（manifest.contributes.styles[]）
 *
 * 插件通过 CSS 注入改造任意 UI 样式。CSS 片段注入到独立的
 * `<style id="plugin-css-{pluginId}-{styleId}">` 标签，head 末尾，
 * 优先级高于主题变量但低于用户自定义 CSS。
 *
 * 使用场景：改造输入框样式、调整面板布局、覆盖组件配色等。
 * 选择器以实际 DOM 类名/属性为准（如 .chat-input-root）。
 */
export interface PluginStyleContribution {
  /** 插件内唯一 id，用于生成 style 标签 id */
  id: string
  /** CSS 源码（可直接用选择器 + CSS 变量） */
  css: string
  /** 注入目标
   * - global（默认）：注入到 head，全局生效
   * - slot：注入到对应 slot 的面板容器内（scoped）
   */
  target?: 'global' | 'slot'
  /** target=slot 时指定 slot id */
  slotId?: string
  /** 描述（UI 展示用） */
  description?: string
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
    toolProviders?: PluginToolProviderContribution[]
    styles?: PluginStyleContribution[]
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
