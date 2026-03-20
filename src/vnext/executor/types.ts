/**
 * Scheduler vNext - Executor Types
 *
 * 执行器相关类型定义
 */

import type { Workflow, WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// Executor 状态
// ============================================================================

/**
 * 执行器状态
 */
export type ExecutorState =
  | 'IDLE'        // 空闲，未启动
  | 'RUNNING'     // 正在执行
  | 'PAUSED'      // 已暂停
  | 'STOPPED';    // 已停止

// ============================================================================
// 执行上下文
// ============================================================================

/**
 * 执行上下文 - 包含执行所需的所有信息
 */
export interface ExecutionContext {
  /** 当前工作流 */
  workflow: Workflow;

  /** 所有节点 */
  nodes: WorkflowNode[];

  /** 待处理事件 */
  pendingEvents: AgentEvent[];

  /** 当前执行轮次 */
  currentRound: number;

  /** 当前执行的节点 ID */
  currentNodeId?: string;
}

// ============================================================================
// 执行结果
// ============================================================================

/**
 * 单次执行结果
 */
export interface ExecutionResult {
  /** 执行的节点 ID */
  nodeId: string;

  /** 是否成功 */
  success: boolean;

  /** 错误信息 */
  error?: string;

  /** 执行时长 (ms) */
  duration: number;

  /** 输出事件 */
  emittedEvents: AgentEvent[];

  /** 执行摘要 */
  summary?: string;
}

/**
 * 执行循环结果
 */
export interface ExecutorRunResult {
  /** 执行的节点数量 */
  executedNodes: number;

  /** 成功数量 */
  successCount: number;

  /** 失败数量 */
  failedCount: number;

  /** 总耗时 (ms) */
  totalDuration: number;

  /** 是否已暂停 */
  paused: boolean;

  /** 是否已完成 */
  completed: boolean;

  /** 停止原因 */
  stopReason?: string;
}

// ============================================================================
// Executor 接口
// ============================================================================

/**
 * 执行器接口
 */
export interface IExecutor {
  /** 当前状态 */
  readonly state: ExecutorState;

  /** 启动执行 */
  start(context: ExecutionContext): Promise<ExecutorRunResult>;

  /** 暂停执行 */
  pause(): void;

  /** 恢复执行 */
  resume(): Promise<ExecutorRunResult>;

  /** 停止执行 */
  stop(): void;

  /** 执行单个节点 */
  executeNode(node: WorkflowNode, context: ExecutionContext): Promise<ExecutionResult>;
}

// ============================================================================
// 执行器配置
// ============================================================================

/**
 * Continuous Executor 配置
 */
export interface ContinuousExecutorConfig {
  /** 最大连续执行轮次 (0 = 无限) */
  maxRounds?: number;

  /** 节点执行超时 (ms) */
  nodeTimeout?: number;

  /** 执行间隔 (ms) */
  executionInterval?: number;

  /** 失败后是否继续 */
  continueOnFailure?: boolean;

  /** 是否启用日志 */
  enableLog?: boolean;

  /** 执行前回调 */
  onBeforeExecute?: (node: WorkflowNode, context: ExecutionContext) => void;

  /** 执行后回调 */
  onAfterExecute?: (result: ExecutionResult, context: ExecutionContext) => void;
}

// Default configuration - exported for external use
export const DEFAULT_EXECUTOR_CONFIG: Required<Omit<ContinuousExecutorConfig, 'onBeforeExecute' | 'onAfterExecute'>> = {
  maxRounds: 0,
  nodeTimeout: 5 * 60 * 1000, // 5 分钟
  executionInterval: 100, // 100ms
  continueOnFailure: false,
  enableLog: false,
};

// ============================================================================
// 节点选择策略
// ============================================================================

/**
 * 节点选择策略类型
 */
export type NodeSelectionStrategy =
  | 'priority'      // 按优先级选择
  | 'sequential'    // 按顺序选择
  | 'ready_first';  // 优先选择就绪节点

/**
 * 节点选择器接口
 */
export interface INodeSelector {
  /** 选择下一个要执行的节点 */
  selectNode(context: ExecutionContext): WorkflowNode | null;

  /** 获取所有可执行节点 */
  getExecutableNodes(context: ExecutionContext): WorkflowNode[];
}
