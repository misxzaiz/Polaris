/**
 * Scheduler vNext - Context Builder Types
 *
 * 执行上下文构建器类型定义
 */

import type { Workflow, WorkflowNode, AgentEvent, ExecutionRecord } from '../types';
import type { AgentProfile } from '../types/profile';

// ============================================================================
// Context Memory State (simplified for context builder)
// ============================================================================

/**
 * 简化的内存状态（用于上下文构建器）
 */
export interface ContextMemoryState {
  /** 活跃内存行 */
  active: string[];

  /** 摘要 */
  summary?: string;

  /** 摘要列表 */
  summaries: string[];

  /** 归档 */
  archives: string[];

  /** 检查点 */
  checkpoints: string[];

  /** 语义索引 */
  semantic: string[];

  /** 任务 */
  tasks: string[];

  /** 用户输入 */
  userInputs: string[];
}

// Re-export for convenience
export type { ContextMemoryState as MemoryState };

// ============================================================================
// Node Execution Context
// ============================================================================

/**
 * 节点执行上下文
 */
export interface NodeExecutionContext {
  /** 工作流信息 */
  workflow: Workflow;

  /** 当前节点 */
  node: WorkflowNode;

  /** 节点使用的 Profile */
  profile?: AgentProfile;

  /** 当前轮次 */
  round: number;

  /** 工作目录 */
  workDir: string;

  /** 内存状态 */
  memory: ContextMemoryState;

  /** 待处理事件 */
  pendingEvents: AgentEvent[];

  /** 历史执行记录 */
  executionHistory: ExecutionRecord[];

  /** 用户输入/补充 */
  userInputs: UserInput[];

  /** 环境变量 */
  environment: Record<string, string>;

  /** 额外配置 */
  extraConfig: Record<string, unknown>;
}

// ============================================================================
// User Input
// ============================================================================

/**
 * 用户输入类型
 */
export type UserInputType =
  | 'interrupt'     // 中断输入
  | 'supplement'    // 补充需求
  | 'feedback'      // 反馈
  | 'correction';   // 修正

/**
 * 用户输入
 */
export interface UserInput {
  /** 输入 ID */
  id: string;

  /** 输入类型 */
  type: UserInputType;

  /** 内容 */
  content: string;

  /** 时间戳 */
  timestamp: number;

  /** 是否已处理 */
  processed: boolean;
}

// ============================================================================
// Prompt Context
// ============================================================================

/**
 * 提示词上下文
 */
export interface PromptContext {
  /** 系统提示词 */
  systemPrompt: string;

  /** 用户提示词 */
  userPrompt: string;

  /** 上下文信息 */
  contextInfo: ContextInfo;

  /** 模板变量 */
  templateVars: Record<string, string>;
}

/**
 * 上下文信息
 */
export interface ContextInfo {
  /** 工作流名称 */
  workflowName: string;

  /** 节点角色 */
  nodeRole: string;

  /** 当前轮次 */
  round: number;

  /** 总轮次限制 */
  maxRounds: number;

  /** 依赖节点状态 */
  dependencyStatus: DependencyStatus[];

  /** 近期执行摘要 */
  recentExecutions: string[];

  /** 待办事项 */
  pendingTasks: string[];
}

/**
 * 依赖状态
 */
export interface DependencyStatus {
  /** 节点 ID */
  nodeId: string;

  /** 节点名称 */
  nodeName: string;

  /** 状态 */
  status: 'completed' | 'skipped' | 'running' | 'pending';

  /** 输出摘要 */
  outputSummary?: string;
}

// ============================================================================
// Context Build Options
// ============================================================================

/**
 * 上下文构建选项
 */
export interface ContextBuildOptions {
  /** 是否包含内存 */
  includeMemory?: boolean;

  /** 是否包含执行历史 */
  includeHistory?: boolean;

  /** 是否包含用户输入 */
  includeUserInputs?: boolean;

  /** 最大历史记录数 */
  maxHistoryItems?: number;

  /** 最大内存行数 */
  maxMemoryLines?: number;

  /** 自定义变量 */
  customVars?: Record<string, string>;
}

/**
 * 默认构建选项
 */
export const DEFAULT_BUILD_OPTIONS: Required<ContextBuildOptions> = {
  includeMemory: true,
  includeHistory: true,
  includeUserInputs: true,
  maxHistoryItems: 10,
  maxMemoryLines: 500,
  customVars: {},
};

// ============================================================================
// Prompt Template
// ============================================================================

/**
 * 提示词模板
 */
export interface PromptTemplate {
  /** 模板 ID */
  id: string;

  /** 模板名称 */
  name: string;

  /** 系统提示词模板 */
  systemTemplate: string;

  /** 用户提示词模板 */
  userTemplate: string;

  /** 变量定义 */
  variables: TemplateVariable[];
}

/**
 * 模板变量
 */
export interface TemplateVariable {
  /** 变量名 */
  name: string;

  /** 描述 */
  description: string;

  /** 默认值 */
  defaultValue?: string;

  /** 是否必填 */
  required: boolean;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * 创建空的用户输入
 */
export function createEmptyUserInput(type: UserInputType, content: string): UserInput {
  return {
    id: `input_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    type,
    content,
    timestamp: Date.now(),
    processed: false,
  };
}

/**
 * 生成上下文 ID
 */
export function generateContextId(): string {
  return `ctx_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
