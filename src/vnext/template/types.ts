/**
 * Scheduler vNext - Template System Types
 *
 * 模板系统类型定义
 */

import type { AgentProfile } from '../types/profile';

// ============================================================================
// Template Types
// ============================================================================

/**
 * 模板类型
 */
export type TemplateType =
  | 'profile'      // Agent Profile 模板
  | 'prompt'       // 提示词模板
  | 'workflow'     // 工作流模板
  | 'node';        // 节点模板

/**
 * 模板基础接口
 */
export interface TemplateBase {
  /** 模板 ID */
  id: string;

  /** 模板名称 */
  name: string;

  /** 模板类型 */
  type: TemplateType;

  /** 描述 */
  description?: string;

  /** 版本 */
  version: string;

  /** 标签 */
  tags: string[];

  /** 作者 */
  author?: string;

  /** 创建时间 */
  createdAt: number;

  /** 更新时间 */
  updatedAt: number;
}

/**
 * Profile 模板
 */
export interface ProfileTemplate extends TemplateBase {
  type: 'profile';

  /** 基础 Profile 配置 */
  profile: Omit<AgentProfile, 'id' | 'createdAt' | 'updatedAt'>;
}

/**
 * 提示词模板
 */
export interface PromptTemplate extends TemplateBase {
  type: 'prompt';

  /** 系统提示词模板 */
  systemTemplate: string;

  /** 用户提示词模板 */
  userTemplate: string;

  /** 变量定义 */
  variables: TemplateVariable[];

  /** 示例 */
  examples?: PromptExample[];
}

/**
 * 工作流模板
 */
export interface WorkflowTemplate extends TemplateBase {
  type: 'workflow';

  /** 工作流定义 */
  workflow: {
    name: string;
    description?: string;
    mode: 'continuous' | 'scheduled' | 'event';
    nodes: NodeTemplateRef[];
  };
}

/**
 * 节点模板引用
 */
export interface NodeTemplateRef {
  /** 节点 ID */
  id: string;

  /** 节点名称 */
  name: string;

  /** 角色 */
  role: string;

  /** 使用的模板 ID */
  templateId?: string;

  /** 依赖节点 */
  dependsOn?: string[];

  /** 订阅事件 */
  subscribeEvents?: string[];

  /** 触发类型 */
  triggerType: 'start' | 'dependency' | 'event';
}

/**
 * 节点模板
 */
export interface NodeTemplate extends TemplateBase {
  type: 'node';

  /** 节点配置 */
  node: {
    role: string;
    taskPrompt?: string;
    templateId?: string;
    triggerType: 'start' | 'dependency' | 'event';
    subscribeEvents?: string[];
    priority: number;
  };
}

// ============================================================================
// Template Variable
// ============================================================================

/**
 * 模板变量
 */
export interface TemplateVariable {
  /** 变量名 */
  name: string;

  /** 显示名称 */
  displayName?: string;

  /** 描述 */
  description?: string;

  /** 类型 */
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';

  /** 默认值 */
  defaultValue?: unknown;

  /** 是否必填 */
  required: boolean;

  /** 验证规则 */
  validation?: ValidationRule;

  /** 枚举值 (type=string 时) */
  enumValues?: string[];
}

/**
 * 验证规则
 */
export interface ValidationRule {
  /** 最小值/长度 */
  min?: number;

  /** 最大值/长度 */
  max?: number;

  /** 正则表达式 */
  pattern?: string;

  /** 自定义验证函数名 */
  customValidator?: string;
}

// ============================================================================
// Prompt Example
// ============================================================================

/**
 * 提示词示例
 */
export interface PromptExample {
  /** 示例名称 */
  name: string;

  /** 输入变量 */
  input: Record<string, unknown>;

  /** 期望输出 */
  expectedOutput: string;
}

// ============================================================================
// Template Registry
// ============================================================================

/**
 * 模板注册表项
 */
export interface TemplateRegistryEntry {
  /** 模板 */
  template: ProfileTemplate | PromptTemplate | WorkflowTemplate | NodeTemplate;

  /** 是否内置 */
  builtin: boolean;

  /** 使用次数 */
  usageCount: number;

  /** 最后使用时间 */
  lastUsedAt?: number;
}

// ============================================================================
// Template Render Context
// ============================================================================

/**
 * 模板渲染上下文
 */
export interface TemplateRenderContext {
  /** 变量值 */
  variables: Record<string, unknown>;

  /** 工作流上下文 */
  workflowContext?: {
    id: string;
    name: string;
    currentRound: number;
  };

  /** 节点上下文 */
  nodeContext?: {
    id: string;
    role: string;
    round: number;
  };

  /** 内存上下文 */
  memoryContext?: {
    activeSummary: string;
    recentDecisions: string[];
  };

  /** 用户输入 */
  userInput?: string;
}

// ============================================================================
// Template Render Result
// ============================================================================

/**
 * 模板渲染结果
 */
export interface TemplateRenderResult {
  /** 渲染成功 */
  success: boolean;

  /** 渲染后的内容 */
  content: string;

  /** 使用的变量 */
  usedVariables: string[];

  /** 错误信息 */
  errors: TemplateError[];

  /** 警告信息 */
  warnings: string[];
}

/**
 * 模板错误
 */
export interface TemplateError {
  /** 错误类型 */
  type: 'missing_variable' | 'invalid_syntax' | 'validation_failed' | 'unknown';

  /** 错误消息 */
  message: string;

  /** 相关变量名 */
  variableName?: string;

  /** 位置 (行号) */
  line?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 生成模板 ID
 */
export function generateTemplateId(type: TemplateType): string {
  return `tmpl_${type}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * 创建空模板变量
 */
export function createEmptyVariable(name: string): TemplateVariable {
  return {
    name,
    type: 'string',
    required: false,
  };
}
