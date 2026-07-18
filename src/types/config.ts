/**
 * 配置相关类型定义
 */

import type { CSSProperties } from 'react'
import type { SpeechConfig, TTSConfig, WakeWordConfig, VoiceNotificationConfig, VoiceCommandEntry } from './speech'
import type { ModelProfile } from './modelProfile'
import type { WorkspaceTerminalScripts } from './terminalScript'
import type { ThemeCustomConfig } from './theme'

/**  引擎 ID */
export type EngineId = 'claude-code' | 'codex' | 'simple-ai' | 'mimo'

/** 支持的语言 */
export type Language = 'zh-CN' | 'en-US'

/** 界面主题 */
export type Theme = 'dark' | 'light'

/** 对话显示密度 */
export type ChatDisplayDensity = 'compact' | 'comfortable' | 'spacious'

/** 对话字体族 */
export type ChatDisplayFontFamily = 'system' | 'serif' | 'mono'

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
}

export const DEFAULT_CHAT_DISPLAY_SETTINGS: ChatDisplaySettings = {
  fontSize: 14,
  lineHeight: 1.55,
  paragraphSpacing: 4,
  messageSpacing: 'comfortable',
  contentWidth: 78,
  codeFontSize: 13,
  fontFamily: 'system',
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
  /** 界面语言 */
  language?: Language;
  /** 界面主题 */
  theme?: Theme;
  /** 自定义主题配置（配色/背景/特效预设集合） */
  themeCustom?: ThemeCustomConfig;
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
  /** Mimo Code 引擎配置 */
  mimoCode: {
    /** Mimo CLI 命令路径 */
    cliPath: string;
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
  /** 窗口设置 */
  window?: WindowSettings;
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
  /** Skill 读取路径列表（支持全局绝对路径，工作区相对路径由应用层处理） */
  skillPaths?: string[];
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
  /** Mimo CLI 是否可用 */
  mimoAvailable?: boolean;
  /** Mimo 版本 */
  mimoVersion?: string;
  /** 工作目录 */
  workDir?: string;
  /** 配置是否有效 */
  configValid: boolean;
}

/** 系统提示词模式 */
export type SystemPromptMode = 'append' | 'replace';

/** 系统提示词配置（localStorage 独立存储） */
export interface SystemPromptConfig {
  /** 模式：append=追加到默认后（默认）, replace=完全替换 */
  mode: SystemPromptMode;
  /** 用户自定义提示词内容 */
  customPrompt: string;
  /** 是否启用自定义提示词 */
  enabled: boolean;
}
