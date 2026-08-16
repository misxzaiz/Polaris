/**
 * 配置相关类型定义
 */

import type { CSSProperties } from 'react'
import type { SpeechConfig, TTSConfig, WakeWordConfig, VoiceNotificationConfig, VoiceCommandEntry } from './speech'
import type { ModelProfile } from './modelProfile'
import type { WorkspaceTerminalScripts } from './terminalScript'

/**  引擎 ID（支持动态插件引擎） */
export type EngineId = 'claude-code' | 'codex' | 'simple-ai' | 'pi' | (string & NonNullable<unknown>)

/** 支持的语言 */
export type Language = 'zh-CN' | 'en-US'

/** 界面主题（@deprecated 使用 activeThemeId 替代） */
export type Theme = 'dark' | 'light' | 'spiderman'

/** 对话显示密度 */
export type ChatDisplayDensity = 'compact' | 'comfortable' | 'spacious'

/** 对话字体族 */
export type ChatDisplayFontFamily = 'system' | 'serif' | 'mono'

/** 过程块折叠模式 */
export type ProcessBlockCollapseMode = 'auto' | 'legacy'

/** AI 对话窗口显示设置 */
export interface ChatDisplaySettings {
  /** 正文字号 (px) */
  fontSize: number;
  /** 正文行高 */
  lineHeight: number;
  /** Markdown 段落间距 (px) */
  paragraphSpacing: number;
  /** 消息垂直密度 */
  messageSpacing: ChatDisplayDensity;
  /** @deprecated no longer constrains width — content adapts to flex parent width */
  contentWidth: number;
  /** 代码字号 (px) */
  codeFontSize: number;
  /** 输入框字号 (px)，为空时跟随正文字号 */
  inputFontSize?: number;
  /** 对话字体族 */
  fontFamily: ChatDisplayFontFamily;
  /** 过程块折叠模式：'auto' 折叠为分段汇总条，'legacy' 使用旧版阈值折叠 */
  processBlockCollapse?: ProcessBlockCollapseMode;
}

export const DEFAULT_CHAT_DISPLAY_SETTINGS: ChatDisplaySettings = {
  fontSize: 14,
  lineHeight: 1.55,
  paragraphSpacing: 4,
  messageSpacing: 'comfortable',
  contentWidth: 78,
  codeFontSize: 13,
  fontFamily: 'system',
  processBlockCollapse: 'auto',
}

const CHAT_DISPLAY_FONT_FAMILIES: Record<ChatDisplayFontFamily, string> = {
  system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", "Noto Serif SC", serif',
  mono: '"JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", Consolas, monospace',
}

const CHAT_DISPLAY_DENSITY = {
  compact: {
    messageGap: 6,
    blockGap: 4,
    bubblePaddingX: 12,
    bubblePaddingY: 8,
    bubbleRadius: 14,
    codePadding: 12,
  },
  comfortable: {
    messageGap: 10,
    blockGap: 6,
    bubblePaddingX: 16,
    bubblePaddingY: 12,
    bubbleRadius: 16,
    codePadding: 16,
  },
  spacious: {
    messageGap: 16,
    blockGap: 10,
    bubblePaddingX: 18,
    bubblePaddingY: 14,
    bubbleRadius: 18,
    codePadding: 18,
  },
} as const

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

export function normalizeChatDisplaySettings(settings?: Partial<ChatDisplaySettings> | null): ChatDisplaySettings {
  const density = settings?.messageSpacing && settings.messageSpacing in CHAT_DISPLAY_DENSITY
    ? settings.messageSpacing
    : DEFAULT_CHAT_DISPLAY_SETTINGS.messageSpacing
  const fontFamily = settings?.fontFamily && settings.fontFamily in CHAT_DISPLAY_FONT_FAMILIES
    ? settings.fontFamily
    : DEFAULT_CHAT_DISPLAY_SETTINGS.fontFamily

  return {
    fontSize: clampNumber(settings?.fontSize, 12, 20, DEFAULT_CHAT_DISPLAY_SETTINGS.fontSize),
    lineHeight: clampNumber(settings?.lineHeight, 1.35, 1.8, DEFAULT_CHAT_DISPLAY_SETTINGS.lineHeight),
    paragraphSpacing: clampNumber(settings?.paragraphSpacing, 0, 12, DEFAULT_CHAT_DISPLAY_SETTINGS.paragraphSpacing),
    messageSpacing: density,
    contentWidth: clampNumber(settings?.contentWidth, 60, 90, DEFAULT_CHAT_DISPLAY_SETTINGS.contentWidth),
    codeFontSize: clampNumber(settings?.codeFontSize, 11, 18, DEFAULT_CHAT_DISPLAY_SETTINGS.codeFontSize),
    inputFontSize: settings?.inputFontSize === undefined
      ? undefined
      : clampNumber(settings.inputFontSize, 12, 20, DEFAULT_CHAT_DISPLAY_SETTINGS.fontSize),
    fontFamily,
    processBlockCollapse: settings?.processBlockCollapse ?? DEFAULT_CHAT_DISPLAY_SETTINGS.processBlockCollapse,
  }
}

export function getChatDisplayStyleVars(settings?: Partial<ChatDisplaySettings> | null): CSSProperties {
  const normalized = normalizeChatDisplaySettings(settings)
  const density = CHAT_DISPLAY_DENSITY[normalized.messageSpacing]
  const inputFontSize = normalized.inputFontSize ?? normalized.fontSize

  return {
    '--chat-font-size': `${normalized.fontSize}px`,
    '--chat-line-height': normalized.lineHeight,
    '--chat-paragraph-spacing': `${normalized.paragraphSpacing}px`,
    '--chat-message-gap': `${density.messageGap}px`,
    '--chat-block-gap': `${density.blockGap}px`,
    '--chat-bubble-padding-x': `${density.bubblePaddingX}px`,
    '--chat-bubble-padding-y': `${density.bubblePaddingY}px`,
    '--chat-bubble-radius': `${density.bubbleRadius}px`,
    // '--chat-content-width': removed — content width is unconstrained (flex parent handles it)
    '--chat-code-font-size': `${normalized.codeFontSize}px`,
    '--chat-code-padding': `${density.codePadding}px`,
    '--chat-input-font-size': `${inputFontSize}px`,
    '--chat-font-family': CHAT_DISPLAY_FONT_FAMILIES[normalized.fontFamily],
  } as CSSProperties
}

/** AI 引擎配置 */
export interface EngineConfig {
  /** 引擎 ID */
  id: EngineId;
  /** 引擎名称 */
  name: string;
  /** CLI 命令路径 */
  cliPath?: string;
  /** 是否可用 */
  available?: boolean;
}

/** 百度翻译配置 */
export interface BaiduTranslateConfig {
  /** 百度翻译 App ID */
  appId: string;
  /** 百度翻译密钥 */
  secretKey: string;
}

/** Personal Hub 内部插件配置（Supabase 接入 + 字段级加密） */
export interface PersonalHubConfig {
  /** Supabase 项目 URL */
  supabaseUrl: string;
  /** Supabase anon key（公开密钥） */
  supabaseAnonKey: string;
  /** 字段级加密密钥（crypto-js AES 口令模式） */
  encryptionKey: string;
  /** Supabase session token（前端登录后同步写入，供 MCP server 使用） */
  sessionToken?: string;
}

/** 消息显示模式 */
export type IntegrationDisplayMode = 'chat' | 'separate' | 'both';

/** QQ Bot 实例配置 */
export interface QQBotInstanceConfig {
  /** 实例 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 应用 ID */
  appId: string;
  /** 应用密钥 */
  clientSecret: string;
  /** 是否沙箱环境 */
  sandbox: boolean;
  /** 消息显示模式 */
  displayMode: IntegrationDisplayMode;
  /** 启动时自动连接 */
  autoConnect: boolean;
  /** 创建时间 (ISO 8601) */
  createdAt?: string;
  /** 最后活跃时间 (ISO 8601) */
  lastActive?: string;
  /** 默认工作目录（新会话自动使用） */
  workDir?: string;
}

/** QQ Bot 集成配置 */
export interface QQBotConfig {
  /** 是否启用 QQ Bot 集成（全局开关） */
  enabled: boolean;
  /** QQ Bot 实例列表 */
  instances: QQBotInstanceConfig[];
  /** 当前激活的实例 ID */
  activeInstanceId?: string;
}

/** Feishu 实例配置 */
export interface FeishuInstanceConfig {
  /** 实例 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  /** 应用 ID (App ID) */
  appId: string;
  /** 应用密钥 (App Secret) */
  appSecret: string;
  /** 事件验证 Token */
  verificationToken: string;
  /** 事件加密 Key */
  encryptKey: string;
  /** 消息显示模式 */
  displayMode: IntegrationDisplayMode;
  /** 启动时自动连接 */
  autoConnect: boolean;
  /** 创建时间 (ISO 8601) */
  createdAt?: string;
  /** 最后活跃时间 (ISO 8601) */
  lastActive?: string;
  /** 默认工作目录（新会话自动使用） */
  workDir?: string;
}

/** Feishu 集成配置 */
export interface FeishuConfig {
  /** 是否启用飞书集成（全局开关） */
  enabled: boolean;
  /** 飞书实例列表 */
  instances: FeishuInstanceConfig[];
  /** 当前激活的实例 ID */
  activeInstanceId?: string;
}

/** DingTalk (钉钉) 实例配置 */
export interface DingTalkInstanceConfig {
  id: string;
  name: string;
  enabled: boolean;
  /** 应用 Key (App Key) */
  appKey: string;
  /** 应用密钥 (App Secret) */
  appSecret: string;
  /** 企业机器人 Webhook URL（用于发送回复） */
  webhookUrl: string;
  displayMode: IntegrationDisplayMode;
  autoConnect: boolean;
  createdAt?: string;
  lastActive?: string;
  /** 默认工作目录（新会话自动使用） */
  workDir?: string;
}

/** DingTalk 集成配置 */
export interface DingTalkConfig {
  enabled: boolean;
  instances: DingTalkInstanceConfig[];
  activeInstanceId?: string;
}

/** Spider-Man 主题配置 */
export interface SpiderManThemeConfig {
  /** 背景图片 URL（空字符串 = 使用预设） */
  backgroundImage?: string;
  /** 背景图片透明度 (0-1) */
  backgroundOpacity?: number;
  /** 面板背景透明度 (0-1)，控制侧栏/聊天面板的透明程度 */
  panelOpacity?: number;
  /** 面板磨砂强度 (px)，0=关闭磨砂效果 */
  panelBlur?: number;
  /** 内容卡片透明度 (0-1)，控制消息气泡/卡片/输入框的内容容器半透明程度 */
  surfaceOpacity?: number;
  /** 聊天工具面板透明度 (0-1)，控制工具调用块/派发卡片等背景 */
  chatToolOpacity?: number;
  /** 悬停态背景透明度 (0-1)，控制按钮/列表项等静态背景区域 */
  hoverOpacity?: number;
  /** 蛛网纹理强度 (0-1) */
  webTextureOpacity?: number;
  /** 背景缩放模式 */
  backgroundSize?: string;
  /** 背景水平偏移 (0-100) */
  backgroundPositionX?: number;
  /** 背景垂直偏移 (0-100) */
  backgroundPositionY?: number;
  /** 面具头像 URL */
  avatarUrl?: string;
  /** 蓝色强调强度 (0-1)，0=无蓝色，1=最大蓝色 */
  blueAccent?: number;
}

/** Spider-Man 主题默认值 */
export const DEFAULT_SPIDERMAN_THEME: SpiderManThemeConfig = {
  backgroundImage: 'https://images.unsplash.com/photo-1534809027769-b00d750a6bac?q=80&w=1920',
  backgroundOpacity: 1.0,
  panelOpacity: 0,
  panelBlur: 0,
  surfaceOpacity: 0.27,
  chatToolOpacity: 0.55,
  hoverOpacity: 0.5,
  webTextureOpacity: 0,
  backgroundSize: 'cover',
  backgroundPositionX: 50,
  backgroundPositionY: 50,
  blueAccent: 0.5,
};

/** 窗口设置 */
export interface WindowSettings {
  /** 大窗模式透明度 (0 - 100) */
  normalOpacity: number;
  /** 小屏模式透明度 (0 - 100) */
  compactOpacity: number;
}

/** Web 服务配置 */
export interface WebConfig {
  /** 是否启用 Web 服务 */
  enabled: boolean;
  /** 监听地址 */
  host: string;
  /** 监听端口 */
  port: number;
  /** 认证 token（自动生成） */
  token?: string;
}

/** 交互配置（AskUserQuestion 等同回合交互能力） */
export interface InteractionConfig {
  /** 是否允许 AI 弹出问题卡片（通过 polaris-ask MCP） */
  askMcpEnabled?: boolean;
}

/** 派发队员预设：角色 → 引擎/供应商/模型/职责提示词 */
export interface DispatchPreset {
  id: string;
  /** 角色名（dispatch_task role 参数按此匹配） */
  name: string;
  /** 引擎 ID */
  engineId: string;
  /** 模型 Profile ID（第三方端点）；空 = 官方端点 */
  modelProfileId?: string;
  /** 具体模型名 */
  model?: string;
  /** 角色职责系统提示词 */
  appendSystemPrompt?: string;
  /** 权限模式 */
  permissionMode?: string;
}

/** 派发任务配置（dispatch_task MCP 行为） */
export interface DispatchConfig {
  /** 派发策略："auto"（直接执行）| "ask"（每次派发弹确认） */
  policy?: 'auto' | 'ask';
  /** 完成后是否把结果摘要注入来源会话下一回合 */
  autoInjectReports?: boolean;
  /** 队员预设列表 */
  presets?: DispatchPreset[];
}

/** 工作区条目（持久化到服务端配置，跨桌面/Web 共享） */
export interface WorkspaceEntry {
  id: string;
  name: string;
  path: string;
  createdAt?: string;
  lastAccessed?: string;
}

/** 应用配置 */
export interface Config {
  /** 当前选择的引擎 */
  defaultEngine: EngineId;
  /** 辅助任务引擎（标题生成 / 润色等低频辅助任务的专用引擎）。
   *  空串/缺省 = 跟随 defaultEngine。用于将辅助任务路由到更便宜的引擎以降本。 */
  auxiliaryEngine?: string;
  /** 界面语言 */
  language?: Language;
  /** 界面主题（@deprecated 使用 activeThemeId 替代） */
  theme?: Theme;
  /** 当前激活的主题 ID（UUID 格式，替换旧 theme 字段） */
  activeThemeId?: string;
  /** Claude Code 引擎配置 */
  claudeCode: {
    /** Claude CLI 命令路径 */
    cliPath: string;
  };
  /** OpenAI Codex 引擎配置 */
  codexCode: {
    /** Codex CLI 命令路径 */
    cliPath: string;
  };
  /** Pi Code 引擎配置（earendil-works pi-coding-agent） */
  piCode: {
    /** Pi CLI 命令路径 */
    cliPath: string;
    /** 是否启用 Pi MCP 桥接（Pi Extension 桥接）。
     *  开启后，Polaris 会把 MCP server 列表写入 ~/.pi/agent/extensions/polaris-mcp-bridge/，
     *  通过 Pi Extension 桥接消费 Polaris MCP 工具生态。
     *  默认关闭：需用户显式确认。 */
    enableExtensions?: boolean;
  };
  /** 工作目录 */
  workDir?: string;
  /** 会话保存路径 */
  sessionDir?: string;
  /** Git 二进制路径（自定义 Git 安装位置时使用） */
  gitBinPath?: string;
  /** 百度翻译配置 */
  baiduTranslate?: BaiduTranslateConfig;
  /** Personal Hub 内部插件配置 */
  personalHub?: PersonalHubConfig;
  /** QQ Bot 集成配置 */
  qqbot: QQBotConfig;
  /** Feishu 集成配置 */
  feishu?: FeishuConfig;
  /** DingTalk 集成配置 */
  dingtalk?: DingTalkConfig;
  /** 窗口设置 */
  window?: WindowSettings;
  /** Spider-Man 沉浸主题配置 */
  spidermanTheme?: SpiderManThemeConfig;
  /** 语音输入配置 */
  speech?: SpeechConfig;
  /** 语音输出配置 (TTS) */
  tts?: TTSConfig;
  /** 唤醒词配置 */
  wakeWord?: WakeWordConfig;
  /** 语音提醒配置 */
  voiceNotification?: VoiceNotificationConfig;
  /** 语音命令配置（自定义关键词） */
  voiceCommands?: VoiceCommandEntry[];
  /** Web 服务配置 */
  web?: WebConfig;
  /** 交互配置（AskUserQuestion 等） */
  interaction?: InteractionConfig;
  /** 派发任务配置（策略/结果注入/队员预设） */
  dispatch?: DispatchConfig;
  /** AI 对话窗口显示设置 */
  chatDisplay?: ChatDisplaySettings;
  /** 工作区列表（跨桌面/Web 共享） */
  workspaces?: WorkspaceEntry[];
  /** 当前激活的工作区 ID */
  currentWorkspaceId?: string;
  /** 工作区终端脚本配置，key 为工作区绝对路径 */
  terminalScripts?: Record<string, WorkspaceTerminalScripts>;
  /** 模型 Profile 列表（配置第三方模型端点） */
  modelProfiles?: ModelProfile[];
  /** 当前激活的模型 Profile ID（为空时使用官方模型） */
  activeModelProfileId?: string;
  /** 供应商分组列表（路由 Failover/RoundRobin/Weighted 策略） */
  providerGroups?: ProviderGroup[];
  /** 当前激活的供应商分组 ID。None 或指向不存在的分组 → 不启用分组，走单 Profile 旧路径 */
  activeProviderGroupId?: string;
  /** Skill 读取路径列表（支持全局绝对路径，工作区相对路径由应用层处理） */
  skillPaths?: string[];
  /** 性能与资源管理：各资源密集型功能的开关。
   *  所有字段默认关闭（false），用户按需开启。
   *  变更通过 config-changed 事件热切换，无需重启。 */
  performance?: PerformanceFeatures;
}

/** 性能与资源功能开关 */
export interface PerformanceFeatures {
  /** 文件系统监听（默认关闭） */
  fileWatcher?: boolean;
  /** LSP 智能索引 tree-sitter + SQLite（默认关闭） */
  lspIndex?: boolean;
  /** 调度器守护进程（默认关闭） */
  schedulerDaemon?: boolean;
  /** 编辑器语法高亮 highlight.js（默认关闭） */
  syntaxHighlighting?: boolean;
  /** Mermaid 图表渲染（默认关闭） */
  mermaidDiagrams?: boolean;
  /** KaTeX 数学公式渲染（默认关闭） */
  katexMath?: boolean;
  /** 代码编辑器语言包预加载（默认关闭） */
  codeEditorLanguages?: boolean;
  /** 插件服务自动启动（默认关闭） */
  pluginAutoStart?: boolean;
}

/**
 * 供应商分组路由策略。
 * 对应后端 RouteStrategy 枚举（#[serde(rename_all = "lowercase")]）：
 * - "failover"：主备切换，priority 数字小优先
 * - "roundrobin"：轮询，每次新会话轮转 Profile
 * - "weighted"：加权随机，按 weight 选择
 */
export type RouteStrategy = 'failover' | 'roundrobin' | 'weighted'

/**
 * 触发 failover 的错误模式。
 * 对应后端 FailoverPattern 枚举（externally tagged）：
 * - { HttpStatus: { code } }：HTTP 状态码命中（code=500 代表 5xx 全段）
 * - "FirstTokenTimeout"：首字超时
 * - "ConnectionRefused"：连接被拒
 * - { StderrContains: { pattern } }：stderr 关键词匹配
 */
export type FailoverPattern =
  | { HttpStatus: { code: number } }
  | 'FirstTokenTimeout'
  | 'ConnectionRefused'
  | { StderrContains: { pattern: string } }

/** 分组成员：一个 Profile 在分组中的路由元数据 */
export interface GroupMember {
  /** 关联的 ModelProfile ID */
  profileId: string;
  /** Failover 策略：数字小优先；同 priority 内轮询 */
  priority: number;
  /** Weighted 策略：权重值 */
  weight: number;
  /**
   * 多 Key 池：同一个端点的多个 API Key。
   * 为空时使用 Profile.apiKey（单 Key 向后兼容）。
   * 非空时，路由策略在 Key 级别也生效。
   */
  keys?: string[];
  /**
   * Key 级路由策略。默认 roundrobin。
   * - roundrobin：新会话轮转 Key
   * - failover：固定第一个 Key，失败时换下一个
   * - weighted：按 keyWeights 加权随机采样；未配置权重时退化为等权随机
   */
  keyStrategy?: RouteStrategy;
  /**
   * Key 级权重，与 keys 对齐。仅 keyStrategy = weighted 时生效。
   * 长度应与 keys 一致；为空或长度不匹配时回退等权。
   */
  keyWeights?: number[];
}

/** 供应商分组配置 */
export interface ProviderGroup {
  /** 唯一 ID */
  id: string;
  /** 人可读名称 */
  name: string;
  /** 路由策略 */
  strategy: RouteStrategy;
  /** 成员列表 */
  members: GroupMember[];
  /** 分组默认模型名（可选，不在组内模型并集中则不生效） */
  defaultModel?: string;
  /** 分组适用的引擎列表。空数组或未设置 = 适用于所有引擎 */
  targetEngines?: string[];
  /** 可选描述文案 */
  description?: string;
  /** 供应商分类标签（UI 展示用） */
  category?: string;
  /** 触发 failover 的错误模式。空 = 使用后端默认集（401/403/429/5xx/首字超时/连接被拒） */
  failoverOn: FailoverPattern[];
  /** spawn 后首字超时秒数。undefined = 不做首字超时检测 */
  firstTokenTimeoutSecs?: number;
  /** 最多 failover 次数（防全死循环），默认 3 */
  maxFailoverAttempts: number;
  /** 是否启用 */
  active: boolean;
}

/** 配置 patch：只包含要更新的顶层字段，null 用于清空可选字段 */
export type ConfigPatch = Partial<{
  [K in keyof Config]: Config[K] | null;
}>;

/** 健康状态 */
export interface HealthStatus {
  /** Claude CLI 是否可用 */
  claudeAvailable: boolean;
  /** Claude 版本 */
  claudeVersion?: string;
  /** Codex CLI 是否可用 */
  codexAvailable?: boolean;
  /** Codex 版本 */
  codexVersion?: string;
  /** Pi CLI 是否可用 */
  piAvailable?: boolean;
  /** Pi 版本 */
  piVersion?: string;
  /** 工作目录 */
  workDir?: string;
  /** 配置是否有效 */
  configValid: boolean;
}

/** 系统提示词配置（localStorage 独立存储） */
export interface SystemPromptConfig {
  /** 用户自定义提示词内容 */
  customPrompt: string;
  /** 是否启用自定义提示词 */
  enabled: boolean;
}
