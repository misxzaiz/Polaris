/**
 * Scheduler vNext - Event Controller Types
 *
 * 事件控制器相关类型定义
 */

import type { WorkflowNode, AgentEvent } from '../types';

// ============================================================================
// 节点事件订阅记录
// ============================================================================

/**
 * 节点事件订阅记录
 */
export interface NodeSubscriptionRecord {
  /** 节点 ID */
  nodeId: string;

  /** 订阅的事件类型 */
  eventType: string;

  /** 取消订阅函数 */
  unsubscribe: () => void;

  /** 订阅时间 */
  subscribedAt: number;
}

// ============================================================================
// 事件匹配
// ============================================================================

/**
 * 事件匹配结果
 */
export interface EventMatchResult {
  /** 是否匹配 */
  matched: boolean;

  /** 匹配的事件 */
  event: AgentEvent;

  /** 匹配的目标节点 */
  targetNodes: WorkflowNode[];
}

// ============================================================================
// 控制器配置
// ============================================================================

/**
 * 节点事件控制器配置
 */
export interface NodeEventControllerConfig {
  /** 是否自动激活订阅 */
  autoActivate?: boolean;

  /** 事件回调 */
  onEventReceived?: (nodeId: string, event: AgentEvent) => void;

  /** 是否启用日志 */
  enableLog?: boolean;
}

// ============================================================================
// 事件发射选项
// ============================================================================

/**
 * 事件发射选项
 */
export interface EmitEventOptions {
  /** 事件优先级 */
  priority?: number;

  /** 目标节点 ID 列表 */
  targetNodeIds?: string[];
}

/**
 * 节点完成结果
 */
export interface NodeCompletionResult {
  /** 是否成功 */
  success: boolean;

  /** 执行摘要 */
  summary?: string;

  /** 执行时长 (ms) */
  duration: number;
}
