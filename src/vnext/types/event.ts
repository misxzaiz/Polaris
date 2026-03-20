/**
 * Scheduler vNext - Event System
 *
 * Event-driven communication between workflow nodes
 */

// ============================================================================
// Event Types
// ============================================================================

/**
 * Built-in event types
 */
export enum EventType {
  // Lifecycle events
  WORKFLOW_STARTED = 'workflow.started',
  WORKFLOW_COMPLETED = 'workflow.completed',
  WORKFLOW_FAILED = 'workflow.failed',
  WORKFLOW_PAUSED = 'workflow.paused',

  // Node events
  NODE_READY = 'node.ready',
  NODE_STARTED = 'node.started',
  NODE_COMPLETED = 'node.completed',
  NODE_FAILED = 'node.failed',

  // Data events
  REQUIREMENT_READY = 'data.requirement_ready',
  CODE_READY = 'data.code_ready',
  TEST_DONE = 'data.test_done',
  DEPLOY_READY = 'data.deploy_ready',

  // Control events
  FORCE_REPLAN = 'control.force_replan',
  INTERRUPT = 'control.interrupt',
  RESUME = 'control.resume',

  // User events
  USER_INPUT = 'user.input',
  USER_FEEDBACK = 'user.feedback',
}

// ============================================================================
// Agent Event
// ============================================================================

/**
 * AgentEvent represents a message passed between nodes or external systems
 */
export interface AgentEvent {
  /** Unique event identifier */
  id: string;

  /** Event type (from EventType or custom) */
  type: string;

  /** Event payload data */
  payload: unknown;

  /** Source workflow ID */
  workflowId: string;

  /** Source node ID (optional) */
  sourceNodeId?: string;

  /** Target node IDs (empty = broadcast) */
  targetNodeIds?: string[];

  /** Creation timestamp */
  createdAt: number;

  /** Whether event has been consumed */
  consumed: boolean;

  /** Event priority (higher = more urgent) */
  priority: number;

  /** Time-to-live in milliseconds (0 = forever) */
  ttl: number;

  /** Correlation ID for request-response patterns */
  correlationId?: string;
}

// ============================================================================
// Event Creation
// ============================================================================

/**
 * Parameters for creating a new event
 */
export interface CreateEventParams {
  type: string;
  payload: unknown;
  workflowId: string;
  sourceNodeId?: string;
  targetNodeIds?: string[];
  priority?: number;
  ttl?: number;
  correlationId?: string;
}

/**
 * Create a new event with default values
 */
export function createEvent(params: CreateEventParams): AgentEvent {
  return {
    id: generateEventId(),
    type: params.type,
    payload: params.payload,
    workflowId: params.workflowId,
    sourceNodeId: params.sourceNodeId,
    targetNodeIds: params.targetNodeIds,
    createdAt: Date.now(),
    consumed: false,
    priority: params.priority ?? 0,
    ttl: params.ttl ?? 0,
    correlationId: params.correlationId,
  };
}

/**
 * Generate a unique event ID
 */
function generateEventId(): string {
  return `evt_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// ============================================================================
// Event Handler
// ============================================================================

/**
 * Event handler function type
 */
export type EventHandler = (event: AgentEvent) => void | Promise<void>;

/**
 * Event subscription configuration
 */
export interface EventSubscription {
  /** Subscription ID */
  id: string;

  /** Event types to subscribe to (empty = all) */
  eventTypes: string[];

  /** Workflow ID filter (optional) */
  workflowId?: string;

  /** Node ID filter (optional) */
  nodeId?: string;

  /** Handler function */
  handler: EventHandler;

  /** Whether to auto-unsubscribe after first match */
  once: boolean;
}

// ============================================================================
// Event Queue
// ============================================================================

/**
 * Event queue item for prioritization
 */
export interface EventQueueItem {
  event: AgentEvent;
  enqueuedAt: number;
  attempts: number;
  lastError?: string;
}

// ============================================================================
// Event Types Constant (for backward compatibility)
// ============================================================================

/**
 * Built-in event types as constant object
 */
export const EventTypes = {
  /** 工作流启动 */
  WORKFLOW_START: 'workflow:start',
  /** 工作流完成 */
  WORKFLOW_COMPLETE: 'workflow:complete',
  /** 工作流失败 */
  WORKFLOW_FAILED: 'workflow:failed',

  /** 节点就绪 */
  NODE_READY: 'node:ready',
  /** 节点开始执行 */
  NODE_START: 'node:start',
  /** 节点完成 */
  NODE_COMPLETE: 'node:complete',
  /** 节点失败 */
  NODE_FAILED: 'node:failed',

  /** 需求就绪 */
  REQUIREMENT_READY: 'requirement:ready',
  /** 代码就绪 */
  CODE_READY: 'code:ready',
  /** 测试完成 */
  TEST_DONE: 'test:done',
  /** 部署完成 */
  DEPLOY_DONE: 'deploy:done',

  /** 用户输入 */
  USER_INPUT: 'user:input',
  /** 用户中断 */
  USER_INTERRUPT: 'user:interrupt',
} as const;

// ============================================================================
// Context Types
// ============================================================================

import type { Workflow, WorkflowNode, AgentProfile, ExecutionRecord, NodeState } from './index';

/**
 * 工作流执行上下文
 */
export interface WorkflowContext {
  workflow: Workflow;
  nodes: WorkflowNode[];
  currentNode?: WorkflowNode;
  events: AgentEvent[];
  executionRecords: ExecutionRecord[];
}

/**
 * 节点状态转换
 */
export interface NodeStateTransition {
  from: NodeState;
  to: NodeState;
  event?: AgentEvent;
  timestamp: number;
}
