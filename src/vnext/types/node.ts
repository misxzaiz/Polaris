/**
 * Scheduler vNext - WorkflowNode Data Models
 *
 * Represents an agent node within a workflow
 */

// ============================================================================
// Node State
// ============================================================================

/**
 * WorkflowNode execution state
 */
export type NodeState =
  | 'IDLE'           // Initial state, waiting to be activated
  | 'READY'          // Ready to execute (dependencies met)
  | 'RUNNING'        // Currently executing
  | 'WAITING_INPUT'  // Waiting for external input/event
  | 'DONE'           // Execution completed successfully
  | 'FAILED'         // Execution failed
  | 'SKIPPED';       // Skipped due to condition

/**
 * Node trigger type
 */
export type NodeTriggerType =
  | 'start'       // Triggered on workflow start
  | 'event'       // Triggered by event
  | 'dependency'  // Triggered when dependencies complete
  | 'manual';     // Requires manual trigger

/**
 * Agent execution strategy
 */
export type ExecutionStrategy =
  | 'PLAN_FIRST'     // Plan before coding
  | 'CODE_FIRST'     // Start coding immediately
  | 'TEST_DRIVEN'    // Write tests first
  | 'EXPLORE'        // Explore and research
  | 'ITERATIVE';     // Iterative refinement

// ============================================================================
// WorkflowNode
// ============================================================================

/**
 * WorkflowNode represents a single agent execution unit within a workflow
 */
export interface WorkflowNode {
  /** Unique node identifier */
  id: string;

  /** Parent workflow ID */
  workflowId: string;

  /** Node name/label */
  name: string;

  /** Agent role (product, developer, tester, researcher, etc.) */
  role: string;

  /** Agent profile template ID */
  agentProfileId?: string;

  /** Current execution state */
  state: NodeState;

  /** How this node is triggered */
  triggerType: NodeTriggerType;

  /** Event types this node subscribes to */
  subscribeEvents: string[];

  /** Event types this node can emit */
  emitEvents: string[];

  /** IDs of nodes that must complete before this node can start */
  dependencies: string[];

  /** IDs of nodes to execute after this node completes */
  nextNodes: string[];

  /** Maximum execution rounds for this node */
  maxRounds: number;

  /** Current round number */
  currentRound: number;

  /** Execution strategy for this node */
  executionStrategy?: ExecutionStrategy;

  /** Custom system prompt override */
  systemPrompt?: string;

  /** Working directory relative to workflow workDir */
  workDir?: string;

  /** Timeout in milliseconds (0 = no timeout) */
  timeoutMs: number;

  /** Retry count on failure */
  retryCount: number;

  /** Maximum retries allowed */
  maxRetries: number;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Custom node configuration */
  config?: Record<string, unknown>;
}

// ============================================================================
// Node Creation Params
// ============================================================================

export interface CreateNodeParams {
  workflowId: string;
  name: string;
  role: string;
  agentProfileId?: string;
  triggerType?: NodeTriggerType;
  subscribeEvents?: string[];
  emitEvents?: string[];
  dependencies?: string[];
  nextNodes?: string[];
  maxRounds?: number;
  executionStrategy?: ExecutionStrategy;
  systemPrompt?: string;
  workDir?: string;
  timeoutMs?: number;
  maxRetries?: number;
  config?: Record<string, unknown>;
}

// ============================================================================
// Node Update Params
// ============================================================================

export interface UpdateNodeParams {
  name?: string;
  state?: NodeState;
  subscribeEvents?: string[];
  emitEvents?: string[];
  dependencies?: string[];
  nextNodes?: string[];
  currentRound?: number;
  config?: Record<string, unknown>;
}

// ============================================================================
// Node Ready Check
// ============================================================================

/**
 * Result of checking if a node is ready to execute
 */
export interface NodeReadyCheck {
  nodeId: string;
  isReady: boolean;
  blockedBy: string[];  // Node IDs or event names blocking execution
  reason: string;
}

/**
 * Check if node state is terminal (completed or failed)
 */
export function isTerminalState(state: NodeState): boolean {
  return state === 'DONE' || state === 'FAILED' || state === 'SKIPPED';
}

/**
 * Check if node can transition to a new state
 */
export function isValidTransition(from: NodeState, to: NodeState): boolean {
  const validTransitions: Record<NodeState, NodeState[]> = {
    'IDLE': ['READY', 'SKIPPED'],
    'READY': ['RUNNING', 'SKIPPED'],
    'RUNNING': ['DONE', 'FAILED', 'WAITING_INPUT'],
    'WAITING_INPUT': ['RUNNING', 'FAILED'],
    'DONE': ['READY'], // For continuous mode
    'FAILED': ['READY'], // For retry
    'SKIPPED': [],
  };

  return validTransitions[from]?.includes(to) ?? false;
}
