/**
 * 配置相关类型定义
 */

import type { SpeechConfig, TTSConfig } from './speech'

/**  引擎 ID */
export type EngineId = 'claude-code'

/** 支持的语言 */
export type Language = 'zh-CN' | 'en-US'

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

/** 窗口设置 */
export interface WindowSettings {
  /** 大窗模式透明度 (0 - 100) */
  normalOpacity: number;
  /** 小屏模式透明度 (0 - 100) */
  compactOpacity: number;
}

/** 应用配置 */
export interface Config {
  /** 当前选择的引擎 */
  defaultEngine: EngineId;
  /** 界面语言 */
  language?: Language;
  /** Claude Code 引擎配置 */
  claudeCode: {
    /** Claude CLI 命令路径 */
    cliPath: string;
  };
  /** 工作目录 */
  workDir?: string;
  /** 会话保存路径 */
  sessionDir?: string;
  /** Git 二进制路径 (Windows) */
  gitBinPath?: string;
  /** 百度翻译配置 */
  baiduTranslate?: BaiduTranslateConfig;
  /** QQ Bot 集成配置 */
  qqbot: QQBotConfig;
  /** 窗口设置 */
  window?: WindowSettings;
  /** 语音输入配置 */
  speech?: SpeechConfig;
  /** 语音输出配置 (TTS) */
  tts?: TTSConfig;
}

/** 健康状态 */
export interface HealthStatus {
  /** Claude CLI 是否可用 */
  claudeAvailable: boolean;
  /** Claude 版本 */
  claudeVersion?: string;
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
