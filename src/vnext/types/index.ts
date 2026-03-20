/**
 * Scheduler vNext - Workflow Engine Types
 *
 * Event Driven Multi-Agent Workflow Engine
 * 核心数据模型定义
 */

// Re-export types from individual modules
export type {
  Workflow,
  WorkflowStatus,
  WorkflowMode,
  CreateWorkflowParams,
  UpdateWorkflowParams,
  WorkflowWithNodes,
} from './workflow';

export type {
  WorkflowNode,
  NodeState,
  NodeTriggerType,
  ExecutionStrategy,
  CreateNodeParams,
  UpdateNodeParams,
  NodeReadyCheck,
} from './node';

export type {
  AgentProfile,
  ScoringRule,
  ScoringCriterion,
  DoneDefinition,
  DoneCondition,
  MemoryPolicy,
  IterationPolicy,
  OutputProtocol,
  AgentConstraint,
} from './profile';

export type {
  AgentEvent,
  EventType,
  EventHandler,
  WorkflowContext,
  NodeStateTransition,
} from './event';

export type {
  ExecutionRecord,
  ExecutionStatus,
  TokenUsage,
  ToolCallRecord,
  ExecutionSummary,
  ExecutionQuery,
} from './execution';

export type {
  MemoryEntry,
  MemoryLayer,
  MemoryStats,
  MemoryState,
  CheckpointData,
} from './memory';

// Export event types constant
export { EventTypes, createEvent, type CreateEventParams, type EventSubscription, type EventQueueItem } from './event';

// Export builtin profiles
export { BUILTIN_PROFILES } from './profile';

// Export helper functions
export {
  isTerminalState,
  isValidTransition,
} from './node';

export {
  isExecutionTerminal,
  calculateDuration,
  generateExecutionId,
} from './execution';
