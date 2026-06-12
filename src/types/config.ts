/**
 * 配置相关类型定义
 */

import type { SpeechConfig, TTSConfig, WakeWordConfig, VoiceNotificationConfig, VoiceCommandEntry } from './speech'
import type { ModelProfile } from './modelProfile'
import type { WorkspaceTerminalScripts } from './terminalScript'

/**  引擎 ID */
export type EngineId = 'claude-code' | 'codex' | 'agnes' | 'simple-ai' | 'mimo'

/** 支持的语言 */
export type Language = 'zh-CN' | 'en-US'

/** 界面主题 */
export type Theme = 'dark' | 'light'

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
  /** Agnes AI 全模态引擎 API Key */
  agnesApiKey?: string;
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
