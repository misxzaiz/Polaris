/**
 * Scheduler vNext - Workflow Runtime Types
 *
 * 工作流运行时类型定义
 */

import type { Workflow, WorkflowNode } from '../types/workflow';
import type { AgentProfile } from '../types/profile';
import type { ExecutionStatus, ExecutionRecord } from '../types/execution';

// ============================================================================
// Runtime Configuration
// ============================================================================

/**
 * 运行时配置
 */
export interface WorkflowRuntimeConfig {
  /** 最大并发节点数 */
  maxConcurrency?: number;

  /** 最大轮次 */
  maxRounds?: number;

  /** 执行间隔（毫秒） */
  executionInterval?: number;

  /** 是否启用监控 */
  enableMonitoring?: boolean;

  /** 是否启用持久化 */
  enablePersistence?: boolean;

  /** 是否启用错误恢复 */
  enableErrorRecovery?: boolean;

  /** 是否启用内存管理 */
  enableMemory?: boolean;

  /** 是否启用日志 */
  enableLog?: boolean;

  /** 自动保存间隔（毫秒） */
  autoSaveInterval?: number;

  /** 错误重试次数 */
  maxRetries?: number;
}

/**
 * 默认运行时配置
 */
export const DEFAULT_RUNTIME_CONFIG: Required<WorkflowRuntimeConfig> = {
  maxConcurrency: 3,
  maxRounds: 100,
  executionInterval: 100,
  enableMonitoring: true,
  enablePersistence: true,
  enableErrorRecovery: true,
  enableMemory: true,
  enableLog: true,
  autoSaveInterval: 30000,
  maxRetries: 3,
};

// ============================================================================
// Runtime State
// ============================================================================

/**
 * 运行时状态
 */
export type RuntimeState =
  | 'IDLE'      // 空闲
  | 'STARTING'  // 启动中
  | 'RUNNING'   // 运行中
  | 'PAUSED'    // 已暂停
  | 'STOPPING'  // 停止中
  | 'STOPPED'   // 已停止
  | 'COMPLETED' // 已完成
  | 'FAILED';   // 已失败

/**
 * 工作流运行状态
 */
export interface WorkflowRunStatus {
  /** 工作流 ID */
  workflowId: string;

  /** 运行时状态 */
  state: RuntimeState;

  /** 当前轮次 */
  currentRound: number;

  /** 已执行节点数 */
  executedNodes: number;

  /** 成功节点数 */
  successNodes: number;

  /** 失败节点数 */
  failedNodes: number;

  /** 跳过节点数 */
  skippedNodes: number;

  /** 开始时间 */
  startTime: number;

  /** 结束时间 */
  endTime?: number;

  /** 运行时长（毫秒） */
  duration?: number;

  /** 错误信息 */
  error?: string;

  /** 当前运行节点 */
  runningNodes: string[];

  /** 待执行节点 */
  pendingNodes: string[];

  /** 已完成节点 */
  completedNodes: string[];
}

// ============================================================================
// Runtime Events
// ============================================================================

/**
 * 运行时事件类型
 */
export type RuntimeEventType =
  | 'workflow_started'
  | 'workflow_paused'
  | 'workflow_resumed'
  | 'workflow_completed'
  | 'workflow_failed'
  | 'workflow_stopped'
  | 'node_started'
  | 'node_completed'
  | 'node_failed'
  | 'node_skipped'
  | 'error_occurred'
  | 'state_changed';

/**
 * 运行时事件
 */
export interface RuntimeEvent {
  /** 事件类型 */
  type: RuntimeEventType;

  /** 时间戳 */
  timestamp: number;

  /** 工作流 ID */
  workflowId: string;

  /** 节点 ID（可选） */
  nodeId?: string;

  /** 事件数据 */
  data?: Record<string, unknown>;

  /** 错误信息（可选） */
  error?: string;
}

/**
 * 运行时事件监听器
 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

// ============================================================================
// Execution Result
// ============================================================================

/**
 * 工作流执行结果
 */
export interface WorkflowRunResult {
  /** 是否成功 */
  success: boolean;

  /** 工作流 ID */
  workflowId: string;

  /** 最终状态 */
  finalState: RuntimeState;

  /** 执行统计 */
  stats: {
    totalNodes: number;
    executedNodes: number;
    successNodes: number;
    failedNodes: number;
    skippedNodes: number;
    totalRounds: number;
    duration: number;
  };

  /** 错误列表 */
  errors: Array<{
    nodeId: string;
    error: string;
    timestamp: number;
  }>;

  /** 执行记录 */
  records: ExecutionRecord[];
}

// ============================================================================
// Node Execution Callbacks
// ============================================================================

/**
 * 节点执行器函数
 */
export type NodeExecutorFn = (
  workflow: Workflow,
  node: WorkflowNode,
  context: NodeExecutionContext
) => Promise<NodeExecutionResult>;

/**
 * 节点执行上下文
 */
export interface NodeExecutionContext {
  /** 当前轮次 */
  round: number;

  /** Profile */
  profile?: AgentProfile;

  /** 待处理事件 */
  pendingEvents: Array<{ type: string; data?: unknown }>;

  /** 用户输入 */
  userInput?: string;

  /** 额外数据 */
  extra?: Record<string, unknown>;
}

/**
 * 节点执行结果
 */
export interface NodeExecutionResult {
  /** 是否成功 */
  success: boolean;

  /** 输出摘要 */
  output?: string;

  /** 错误信息 */
  error?: string;

  /** 要发射的事件 */
  emitEvents?: Array<{ type: string; data?: unknown }>;

  /** Token 使用量 */
  tokenUsage?: {
    input: number;
    output: number;
  };
}

// ============================================================================
// Workflow Registration
// ============================================================================

/**
 * 工作流注册信息
 */
export interface WorkflowRegistration {
  /** 工作流定义 */
  workflow: Workflow;

  /** 节点列表 */
  nodes: WorkflowNode[];

  /** Profile 映射（节点 ID -> Profile ID） */
  profiles?: Record<string, string>;

  /** 自定义执行器（节点 ID -> 执行函数） */
  executors?: Record<string, NodeExecutorFn>;
}
