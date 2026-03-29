/**
 * 配置相关类型定义
 */

import type { SpeechConfig } from './speech'

/**  引擎 ID（扩展以支持动态 Provider） */
export type EngineId = 'claude-code' | 'iflow' | 'codex' | `provider-${string}`

/** 支持的语言 */
export type Language = 'zh-CN' | 'en-US'

/** OpenAI Provider 配置 */
export interface OpenAIProvider {
  /** 唯一标识符 */
  id: string;
  /** 显示名称 */
  name: string;
  /** API Key */
  apiKey: string;
  /** API Base URL */
  apiBase: string;
  /** 模型名称（任意值） */
  model: string;
  /** 温度参数 */
  temperature: number;
  /** 最大 Token 数 */
  maxTokens: number;
  /** 是否启用 */
  enabled: boolean;
  /** 是否支持工具调用（Function Calling） */
  supportsTools: boolean;
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

/** 消息显示模式 */
export type IntegrationDisplayMode = 'chat' | 'separate' | 'both';

/** QQ Bot 集成配置 */
export interface QQBotConfig {
  /** 是否启用 QQ Bot 集成 */
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
  /** IFlow 引擎配置 */
  iflow: {
    /** IFlow CLI 命令路径 */
    cliPath?: string;
  };
  /** Codex 引擎配置 */
  codex: {
    /** Codex CLI 命令路径 */
    cliPath?: string;
    /** Sandbox 模式 */
    sandboxMode?: string;
    /** 审批策略 */
    approvalPolicy?: string;
    /** 危险全开放（跳过审批和沙箱） */
    dangerousBypass?: boolean;
  };
  /** OpenAI Providers 列表 */
  openaiProviders: OpenAIProvider[];
  /** 当前选中的 Provider ID */
  activeProviderId?: string;
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
}

/** 健康状态 */
export interface HealthStatus {
  /** Claude CLI 是否可用 */
  claudeAvailable: boolean;
  /** Claude 版本 */
  claudeVersion?: string;
  /** IFlow CLI 是否可用 */
  iflowAvailable?: boolean;
  /** IFlow 版本 */
  iflowVersion?: string;
  /** Codex CLI 是否可用 */
  codexAvailable?: boolean;
  /** Codex 版本 */
  codexVersion?: string;
  /** 工作目录 */
  workDir?: string;
  /** 配置是否有效 */
  configValid: boolean;
}
