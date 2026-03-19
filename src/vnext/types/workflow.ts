/**
 * Scheduler vNext - Workflow Data Models
 *
 * Event Driven Multi-Agent Workflow Engine
 */

// ============================================================================
// Workflow Status
// ============================================================================

/**
 * Workflow lifecycle status
 */
export type WorkflowStatus =
  | 'CREATED'      // Initial state, workflow created but not started
  | 'PLANNING'     // Planning phase, determining execution plan
  | 'RUNNING'      // Normal execution, nodes are being processed
  | 'WAITING_EVENT'// Waiting for external event to proceed
  | 'BLOCKED'      // Blocked due to dependency or resource constraint
  | 'COMPACTING_MEMORY' // Memory compaction in progress
  | 'FAILED'       // Execution failed
  | 'COMPLETED'    // All nodes completed successfully
  | 'EVOLVING';    // Self-evolution mode (optimization/refactoring)

/**
 * Workflow execution mode
 */
export type WorkflowMode =
  | 'continuous'   // Continuous execution, no waiting between rounds
  | 'scheduled'    // Timer-driven execution
  | 'event';       // Event-driven execution only

// ============================================================================
// Workflow
// ============================================================================

/**
 * Workflow represents a complete task flow with multiple agent nodes
 */
export interface Workflow {
  /** Unique workflow identifier */
  id: string;

  /** Human-readable workflow name */
  name: string;

  /** Description of the workflow goal */
  description?: string;

  /** Current workflow status */
  status: WorkflowStatus;

  /** Execution mode */
  mode: WorkflowMode;

  /** Priority for dispatcher (higher = more urgent) */
  priority: number;

  /** Template ID used to create this workflow */
  templateId?: string;

  /** Currently executing node ID */
  currentNodeId?: string;

  /** Root directory for workflow memory */
  memoryRoot: string;

  /** Working directory for file operations */
  workDir: string;

  /** Creation timestamp (ms since epoch) */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;

  /** Total execution rounds completed */
  totalRounds: number;

  /** Maximum allowed rounds (0 = unlimited) */
  maxRounds: number;

  /** Tags for categorization */
  tags: string[];

  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Workflow Creation Params
// ============================================================================

export interface CreateWorkflowParams {
  name: string;
  description?: string;
  mode?: WorkflowMode;
  priority?: number;
  templateId?: string;
  workDir: string;
  memoryRoot?: string;
  maxRounds?: number;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Workflow Update Params
// ============================================================================

export interface UpdateWorkflowParams {
  name?: string;
  description?: string;
  status?: WorkflowStatus;
  mode?: WorkflowMode;
  priority?: number;
  currentNodeId?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
