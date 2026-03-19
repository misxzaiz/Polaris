/**
 * Scheduler vNext - Memory System
 *
 * Memory lifecycle management for workflow execution
 */

// ============================================================================
// Memory Layer
// ============================================================================

/**
 * Memory layers for different retention and access patterns
 */
export type MemoryLayer =
  | 'active'      // Current working memory
  | 'summaries'   // Compressed summaries
  | 'archives'    // Historical archives
  | 'checkpoints' // Execution checkpoints
  | 'semantic'    // Semantic index (for search)
  | 'tasks'       // Task queue state
  | 'user_inputs' // User input history;

// ============================================================================
// Memory Entry
// ============================================================================

/**
 * Base memory entry structure
 */
export interface MemoryEntry {
  /** Unique entry ID */
  id: string;

  /** Entry type */
  type: MemoryEntryType;

  /** Content */
  content: string;

  /** Creation timestamp */
  createdAt: number;

  /** Last access timestamp */
  accessedAt: number;

  /** Access count */
  accessCount: number;

  /** Relevance score (0-100) */
  relevanceScore?: number;

  /** Source execution ID */
  sourceExecutionId?: string;

  /** Source node ID */
  sourceNodeId?: string;

  /** Tags */
  tags: string[];

  /** Token count */
  tokenCount: number;
}

/**
 * Memory entry types
 */
export type MemoryEntryType =
  | 'goal'
  | 'decision'
  | 'accomplishment'
  | 'issue'
  | 'risk'
  | 'todo'
  | 'note'
  | 'context'
  | 'score'
  | 'user_input';

// ============================================================================
// Active Memory
// ============================================================================

/**
 * Active memory structure (current working state)
 */
export interface ActiveMemory {
  /** Workflow ID */
  workflowId: string;

  /** Current goal */
  currentGoal?: string;

  /** Completed items */
  completed: string[];

  /** In-progress items */
  inProgress: string[];

  /** Pending tasks */
  pending: string[];

  /** Decisions made */
  decisions: Decision[];

  /** Risks identified */
  risks: Risk[];

  /** Current focus */
  currentFocus?: string;

  /** Total lines */
  totalLines: number;

  /** Total tokens */
  totalTokens: number;

  /** Last updated */
  updatedAt: number;
}

// ============================================================================
// Decision
// ============================================================================

export interface Decision {
  /** Decision ID */
  id: string;

  /** Decision description */
  description: string;

  /** Rationale */
  rationale?: string;

  /** Alternatives considered */
  alternatives?: string[];

  /** Made at timestamp */
  madeAt: number;

  /** Made by node ID */
  madeBy?: string;
}

// ============================================================================
// Risk
// ============================================================================

export interface Risk {
  /** Risk ID */
  id: string;

  /** Risk description */
  description: string;

  /** Severity: low, medium, high */
  severity: 'low' | 'medium' | 'high';

  /** Mitigation strategy */
  mitigation?: string;

  /** Status */
  status: 'open' | 'mitigated' | 'resolved';

  /** Identified at */
  identifiedAt: number;
}

// ============================================================================
// Memory Summary
// ============================================================================

/**
 * Compressed memory summary
 */
export interface MemorySummary {
  /** Summary ID */
  id: string;

  /** Workflow ID */
  workflowId: string;

  /** Summary period start */
  periodStart: number;

  /** Summary period end */
  periodEnd: number;

  /** Rounds covered */
  roundsCovered: number[];

  /** Completed goals */
  completedGoals: string[];

  /** Key decisions */
  keyDecisions: Decision[];

  /** Pending items */
  pending: string[];

  /** Risks */
  risks: Risk[];

  /** Token count saved */
  tokensSaved: number;

  /** Created at */
  createdAt: number;
}

// ============================================================================
// Memory Checkpoint
// ============================================================================

/**
 * Checkpoint for rollback
 */
export interface MemoryCheckpoint {
  /** Checkpoint ID */
  id: string;

  /** Workflow ID */
  workflowId: string;

  /** Node ID */
  nodeId?: string;

  /** Round number */
  round: number;

  /** Full memory state path */
  memoryPath: string;

  /** Git commit hash (if applicable) */
  gitCommit?: string;

  /** Created at */
  createdAt: number;

  /** Description */
  description?: string;
}

// ============================================================================
// Compaction Trigger
// ============================================================================

/**
 * Conditions that trigger memory compaction
 */
export interface CompactionTrigger {
  /** Max lines before compaction */
  maxLines: number;

  /** Max tokens before compaction */
  maxTokens: number;

  /** Completed nodes threshold */
  completedNodesThreshold: number;

  /** Phase change triggers */
  phaseChangeTrigger: boolean;

  /** Workflow idle trigger */
  idleTrigger: boolean;

  /** Idle duration in ms */
  idleDurationMs: number;
}

/**
 * Default compaction triggers
 */
export const DEFAULT_COMPACTION_TRIGGER: CompactionTrigger = {
  maxLines: 1500,
  maxTokens: 60000,
  completedNodesThreshold: 5,
  phaseChangeTrigger: true,
  idleTrigger: true,
  idleDurationMs: 30000,
};

// ============================================================================
// Memory Stats
// ============================================================================

export interface MemoryStats {
  /** Total entries */
  totalEntries: number;

  /** Total tokens */
  totalTokens: number;

  /** Total lines */
  totalLines: number;

  /** Entries by type */
  entriesByType: Record<MemoryEntryType, number>;

  /** Oldest entry timestamp */
  oldestEntry?: number;

  /** Newest entry timestamp */
  newestEntry?: number;

  /** Average access count */
  avgAccessCount: number;
}
