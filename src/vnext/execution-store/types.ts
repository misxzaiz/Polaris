/**
 * Scheduler vNext - Execution Store Types
 *
 * 执行存储相关类型定义
 */

import type { TokenUsage } from '../types';

// ============================================================================
// 存储配置
// ============================================================================

/**
 * 执行记录存储配置
 */
export interface ExecutionStoreConfig {
  /** 最大记录数量 */
  maxRecords?: number;

  /** 记录保留时间（毫秒） */
  retentionMs?: number;

  /** 是否自动清理 */
  autoCleanup?: boolean;

  /** 清理间隔（毫秒） */
  cleanupInterval?: number;

  /** 是否启用日志 */
  enableLog?: boolean;
}

// ============================================================================
// 统计
// ============================================================================

/**
 * 执行记录统计
 */
export interface ExecutionStats {
  /** 总记录数 */
  totalRecords: number;

  /** 成功数 */
  successCount: number;

  /** 失败数 */
  failedCount: number;

  /** 运行中数 */
  runningCount: number;

  /** 平均执行时间 */
  avgDurationMs: number;

  /** 总 Token 消耗 */
  totalTokens: number;
}

// ============================================================================
// 创建参数
// ============================================================================

/**
 * 创建执行记录参数
 */
export interface CreateExecutionParams {
  /** 节点 ID */
  nodeId: string;

  /** 工作流 ID */
  workflowId: string;

  /** 执行轮次 */
  round: number;

  /** 会话 ID */
  sessionId?: string;

  /** 引擎 ID */
  engineId?: string;
}

/**
 * 完成执行参数
 */
export interface CompleteExecutionParams {
  /** 输出片段 */
  outputSnippet?: string;

  /** 摘要路径 */
  summaryPath?: string;

  /** Token 使用量 */
  tokenUsage?: TokenUsage;

  /** 评分 */
  score?: number;
}
