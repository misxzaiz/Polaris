/**
 * Scheduler vNext - Dispatcher Types
 *
 * 优先级调度器相关类型定义
 */

import type { Workflow, WorkflowNode, AgentEvent } from '../types';
import type { IExecutor, ExecutionResult, ExecutorRunResult } from '../executor/types';

// ============================================================================
// 调度器状态
// ============================================================================

/**
 * 调度器状态
 */
export type DispatcherState =
  | 'IDLE'       // 空闲，未启动
  | 'RUNNING'    // 正在调度
  | 'PAUSED'     // 已暂停
  | 'STOPPED';   // 已停止

// ============================================================================
// Workflow 执行条目
// ============================================================================

/**
 * Workflow 在调度队列中的条目
 */
export interface WorkflowEntry {
  /** Workflow 实例 */
  workflow: Workflow;

  /** 所有节点 */
  nodes: WorkflowNode[];

  /** 优先级 (数值越高优先级越高) */
  priority: number;

  /** 加入队列时间 */
  enqueuedAt: number;

  /** 最后执行时间 */
  lastExecutedAt?: number;

  /** 执行次数 */
  executionCount: number;

  /** 状态 */
  status: 'pending' | 'running' | 'completed' | 'failed';

  /** 分配的执行器 */
  executor?: IExecutor;

  /** 执行结果 */
  result?: ExecutorRunResult;
}

// ============================================================================
// 调度策略
// ============================================================================

/**
 * 调度策略类型
 */
export type DispatchStrategy =
  | 'priority'      // 按优先级选择
  | 'fifo'          // 先进先出
  | 'round_robin'   // 轮询
  | 'shortest_first'; // 最短任务优先

/**
 * Workflow 选择器接口
 */
export interface IWorkflowSelector {
  /** 选择下一个要执行的 Workflow */
  selectWorkflow(entries: WorkflowEntry[]): WorkflowEntry | null;

  /** 获取可执行的 Workflow 列表 */
  getExecutableEntries(entries: WorkflowEntry[]): WorkflowEntry[];
}

// ============================================================================
// 调度器配置
// ============================================================================

/**
 * Priority Dispatcher 配置
 */
export interface PriorityDispatcherConfig {
  /** 最大并发 Workflow 数量 */
  maxConcurrency?: number;

  /** 调度间隔 (ms) */
  dispatchInterval?: number;

  /** 调度策略 */
  strategy?: DispatchStrategy;

  /** 是否启用日志 */
  enableLog?: boolean;

  /** Workflow 超时 (ms) */
  workflowTimeout?: number;

  /** 执行器工厂函数 */
  executorFactory?: (workflow: Workflow) => IExecutor;

  /** Workflow 开始执行回调 */
  onWorkflowStart?: (entry: WorkflowEntry) => void;

  /** Workflow 完成回调 */
  onWorkflowComplete?: (entry: WorkflowEntry, result: ExecutorRunResult) => void;

  /** Workflow 失败回调 */
  onWorkflowError?: (entry: WorkflowEntry, error: Error) => void;
}

// ============================================================================
// 调度结果
// ============================================================================

/**
 * 单次调度结果
 */
export interface DispatchResult {
  /** 选择的 Workflow ID */
  workflowId: string;

  /** 是否成功启动 */
  started: boolean;

  /** 错误信息 */
  error?: string;
}

/**
 * 调度器运行结果
 */
export interface DispatcherRunResult {
  /** 总调度次数 */
  dispatchCount: number;

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
// 调度器接口
// ============================================================================

/**
 * Priority Dispatcher 接口
 */
export interface IDispatcher {
  /** 当前状态 */
  readonly state: DispatcherState;

  /** 队列中的 Workflow 数量 */
  readonly queueSize: number;

  /** 正在执行的 Workflow 数量 */
  readonly runningCount: number;

  /** 添加 Workflow 到队列 */
  enqueue(workflow: Workflow, nodes: WorkflowNode[], priority?: number): WorkflowEntry;

  /** 移除 Workflow */
  dequeue(workflowId: string): WorkflowEntry | null;

  /** 获取队列中的所有条目 */
  getQueue(): WorkflowEntry[];

  /** 获取正在执行的条目 */
  getRunning(): WorkflowEntry[];

  /** 更新 Workflow 优先级 */
  updatePriority(workflowId: string, priority: number): boolean;

  /** 启动调度 */
  start(): Promise<DispatcherRunResult>;

  /** 暂停调度 */
  pause(): void;

  /** 恢复调度 */
  resume(): Promise<DispatcherRunResult>;

  /** 停止调度 */
  stop(): void;
}

// ============================================================================
// 默认配置
// ============================================================================

export const DEFAULT_DISPATCHER_CONFIG: Required<Omit<PriorityDispatcherConfig,
  'executorFactory' | 'onWorkflowStart' | 'onWorkflowComplete' | 'onWorkflowError'>> = {
  maxConcurrency: 3,
  dispatchInterval: 100,
  strategy: 'priority',
  enableLog: false,
  workflowTimeout: 30 * 60 * 1000, // 30 分钟
};
