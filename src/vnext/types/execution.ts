/**
 * Scheduler vNext - Execution Record
 *
 * Tracks execution history for workflow nodes
 */

// ============================================================================
// Execution Status
// ============================================================================

/**
 * Execution record status
 */
export type ExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

// ============================================================================
// Execution Record
// ============================================================================

/**
 * ExecutionRecord tracks a single node execution instance
 */
export interface ExecutionRecord {
  /** Unique execution identifier */
  id: string;

  /** Node being executed */
  nodeId: string;

  /** Workflow ID */
  workflowId: string;

  /** Execution round number */
  round: number;

  /** Execution status */
  status: ExecutionStatus;

  /** Execution start timestamp */
  startedAt: number;

  /** Execution start timestamp (alias for startedAt) */
  startTime?: number;

  /** Execution end timestamp */
  finishedAt?: number;

  /** Execution end timestamp (alias for finishedAt) */
  endTime?: number;

  /** Duration in milliseconds */
  durationMs?: number;

  /** AI session ID used */
  sessionId?: string;

  /** Engine ID used */
  engineId?: string;

  /** Path to execution summary file */
  summaryPath?: string;

  /** Output snippet (truncated) */
  outputSnippet?: string;

  /** Error message if failed */
  error?: string;

  /** Token count */
  tokenCount?: number;

  /** Tool call count */
  toolCallCount?: number;

  /** Token usage */
  tokenUsage?: TokenUsage;

  /** Tool calls made during execution */
  toolCalls: ToolCallRecord[];

  /** Self-evaluation score */
  score?: number;

  /** User feedback rating */
  userRating?: number;

  /** Checkpoint path for rollback */
  checkpointPath?: string;
}

// ============================================================================
// Token Usage
// ============================================================================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ============================================================================
// Tool Call Record
// ============================================================================

export interface ToolCallRecord {
  /** Tool name */
  tool: string;

  /** Tool input (JSON string) */
  input: string;

  /** Execution timestamp */
  timestamp: number;

  /** Whether successful */
  success: boolean;

  /** Result snippet */
  resultSnippet?: string;

  /** Error if failed */
  error?: string;
}

// ============================================================================
// Execution Summary
// ============================================================================

/**
 * Summary of an execution for memory storage
 */
export interface ExecutionSummary {
  /** Execution record ID */
  executionId: string;

  /** Node ID */
  nodeId: string;

  /** Round number */
  round: number;

  /** Completion status */
  status: ExecutionStatus;

  /** Key accomplishments */
  accomplishments: string[];

  /** Decisions made */
  decisions: string[];

  /** Files modified */
  filesModified: string[];

  /** Issues encountered */
  issues: string[];

  /** Next steps */
  nextSteps: string[];

  /** Score */
  score?: number;

  /** Generated at */
  generatedAt: number;
}

// ============================================================================
// Execution Query
// ============================================================================

export interface ExecutionQuery {
  workflowId?: string;
  nodeId?: string;
  status?: ExecutionStatus;
  fromTime?: number;
  toTime?: number;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if execution is in terminal state
 */
export function isExecutionTerminal(status: ExecutionStatus): boolean {
  return status !== 'PENDING' && status !== 'RUNNING';
}

/**
 * Calculate execution duration
 */
export function calculateDuration(record: ExecutionRecord): number {
  if (!record.finishedAt || !record.startedAt) return 0;
  return record.finishedAt - record.startedAt;
}

/**
 * Generate execution ID
 */
export function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}
