/**
 * Scheduler vNext - Pipeline Types
 *
 * Pipeline 相关类型定义
 */

import type { WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// Pipeline 状态
// ============================================================================

/**
 * Pipeline 状态
 */
export type PipelineState =
  | 'IDLE'       // 空闲
  | 'RUNNING'    // 运行中
  | 'PAUSED'     // 已暂停
  | 'COMPLETED'  // 已完成
  | 'FAILED';    // 失败

// ============================================================================
// 节点执行状态
// ============================================================================

/**
 * 节点执行状态记录
 */
export interface NodeExecutionState {
  /** 节点 ID */
  nodeId: string;

  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

  /** 开始时间 */
  startTime?: number;

  /** 结束时间 */
  endTime?: number;

  /** 错误信息 */
  error?: string;
}

// ============================================================================
// Pipeline 结果
// ============================================================================

/**
 * Pipeline 推进结果
 */
export interface PipelineAdvanceResult {
  /** 是否成功推进 */
  success: boolean;

  /** 当前状态 */
  state: PipelineState;

  /** 已完成的节点 */
  completedNodes: string[];

  /** 当前执行中的节点 */
  runningNodes: string[];

  /** 待执行的节点 */
  pendingNodes: string[];

  /** 被阻塞的节点及其原因 */
  blockedNodes: Array<{ nodeId: string; reason: string }>;

  /** 下一个要执行的节点 */
  nextNode?: WorkflowNode;

  /** 发出的事件 */
  emittedEvents: AgentEvent[];
}

// ============================================================================
// Pipeline 配置
// ============================================================================

/**
 * Pipeline 配置
 */
export interface PipelineConfig {
  /** 是否自动推进 */
  autoAdvance?: boolean;

  /** 并行执行最大数量 */
  maxParallel?: number;

  /** 节点执行回调 */
  onNodeStart?: (node: WorkflowNode) => void;
  onNodeComplete?: (node: WorkflowNode, success: boolean) => void;

  /** 是否启用日志 */
  enableLog?: boolean;
}

// ============================================================================
// Pipeline 进度
// ============================================================================

/**
 * Pipeline 执行进度
 */
export interface PipelineProgress {
  /** 总节点数 */
  total: number;

  /** 已完成数量 */
  completed: number;

  /** 执行中数量 */
  running: number;

  /** 待执行数量 */
  pending: number;

  /** 失败数量 */
  failed: number;

  /** 跳过数量 */
  skipped: number;
}
