/**
 * Auto-Mode 类型定义
 *
 * 用于自动模式配置的 TypeScript 类型
 */

/**
 * 自动模式配置（CLI 输出）
 */
export interface AutoModeConfig {
  /** 允许规则列表 */
  allow: string[];
  /** 拒绝规则列表（软拒绝，需确认） */
  soft_deny: string[];
  /** 环境配置 */
  environment: string[];
}

/**
 * 自动模式默认配置
 */
export interface AutoModeDefaults {
  /** 默认允许规则 */
  allow: string[];
  /** 默认拒绝规则 */
  soft_deny: string[];
  /** 默认环境配置 */
  environment: string[];
}

/**
 * 自定义规则（存储在 settings.json）
 */
export interface AutoModeCustomRules {
  /** 自定义允许规则 */
  allow: string[];
  /** 自定义需确认规则 */
  softDeny: string[];
}

/**
 * 规则类型
 */
export type RuleType = 'allow' | 'softDeny';

/**
 * 编辑模式
 */
export type EditMode = 'list' | 'advanced';

/**
 * Claude settings.json 结构
 */
export interface ClaudeSettings {
  env?: Record<string, string>;
  model?: string;
  enabledPlugins?: Record<string, boolean>;
  extraKnownMarketplaces?: unknown;
  autoMode?: AutoModeCustomRules;
  [key: string]: unknown;
}

/**
 * 规则分类
 */
export interface RuleCategory {
  id: string;
  name: string;
  description: string;
  rules: string[];
}
