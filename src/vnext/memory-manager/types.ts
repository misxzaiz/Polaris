/**
 * Scheduler vNext - Memory Manager Types
 *
 * Memory lifecycle management types
 */

import type {
  MemoryLayer,
  MemoryEntry,
  MemoryEntryType,
  ActiveMemory,
  MemorySummary,
  MemoryCheckpoint,
  CompactionTrigger,
  MemoryStats,
  Decision,
  Risk,
} from '../types/memory';

// ============================================================================
// Memory Store Interface
// ============================================================================

/**
 * Memory store interface for different storage backends
 */
export interface IMemoryStore {
  /** Get memory entry by ID */
  get(id: string): Promise<MemoryEntry | null>;

  /** Get all entries in a layer */
  getAll(layer: MemoryLayer, workflowId: string): Promise<MemoryEntry[]>;

  /** Save memory entry */
  save(entry: MemoryEntry): Promise<void>;

  /** Delete memory entry */
  delete(id: string): Promise<boolean>;

  /** Clear all entries in a layer for a workflow */
  clear(layer: MemoryLayer, workflowId: string): Promise<number>;

  /** Query entries with filters */
  query(filter: MemoryQueryFilter): Promise<MemoryEntry[]>;

  /** Count entries in a layer */
  count(layer: MemoryLayer, workflowId: string): Promise<number>;
}

/**
 * Memory query filter
 */
export interface MemoryQueryFilter {
  workflowId?: string;
  layer?: MemoryLayer;
  types?: MemoryEntryType[];
  tags?: string[];
  sourceNodeId?: string;
  sourceExecutionId?: string;
  fromDate?: number;
  toDate?: number;
  minRelevanceScore?: number;
  limit?: number;
  offset?: number;
}

// ============================================================================
// Memory Manager Interface
// ============================================================================

/**
 * Memory manager interface
 */
export interface IMemoryManager {
  /** Initialize memory for a workflow */
  initialize(workflowId: string): Promise<void>;

  /** Get active memory for a workflow */
  getActiveMemory(workflowId: string): Promise<ActiveMemory | null>;

  /** Update active memory */
  updateActiveMemory(workflowId: string, updates: Partial<ActiveMemory>): Promise<void>;

  /** Add entry to a layer */
  addEntry(workflowId: string, layer: MemoryLayer, entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'accessedAt' | 'accessCount'>): Promise<MemoryEntry>;

  /** Get entry by ID */
  getEntry(entryId: string): Promise<MemoryEntry | null>;

  /** Get entries from a layer */
  getEntries(workflowId: string, layer: MemoryLayer): Promise<MemoryEntry[]>;

  /** Update entry */
  updateEntry(entryId: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | null>;

  /** Delete entry */
  deleteEntry(entryId: string): Promise<boolean>;

  /** Move entry to another layer */
  moveEntry(entryId: string, targetLayer: MemoryLayer): Promise<boolean>;

  /** Create checkpoint */
  createCheckpoint(workflowId: string, nodeId: string, round: number, description?: string): Promise<MemoryCheckpoint>;

  /** Get checkpoint */
  getCheckpoint(checkpointId: string): Promise<MemoryCheckpoint | null>;

  /** List checkpoints for a workflow */
  listCheckpoints(workflowId: string): Promise<MemoryCheckpoint[]>;

  /** Restore from checkpoint */
  restoreCheckpoint(checkpointId: string): Promise<boolean>;

  /** Get memory stats */
  getStats(workflowId: string): Promise<MemoryStats>;

  /** Check if compaction is needed */
  needsCompaction(workflowId: string): Promise<boolean>;

  /** Run compaction */
  runCompaction(workflowId: string): Promise<MemorySummary | null>;

  /** Get summaries for a workflow */
  getSummaries(workflowId: string): Promise<MemorySummary[]>;

  /** Archive old memories */
  archiveOld(workflowId: string, olderThan: number): Promise<number>;

  /** Clear all memory for a workflow */
  clearAll(workflowId: string): Promise<void>;
}

// ============================================================================
// Memory Compactor Interface
// ============================================================================

/**
 * Memory compactor interface
 */
export interface IMemoryCompactor {
  /** Check if compaction is needed */
  shouldCompact(activeMemory: ActiveMemory, stats: MemoryStats, trigger: CompactionTrigger): boolean;

  /** Compact active memory into summary */
  compact(workflowId: string, activeMemory: ActiveMemory, entries: MemoryEntry[]): Promise<CompactionResult>;
}

/**
 * Compaction result
 */
export interface CompactionResult {
  /** Generated summary */
  summary: MemorySummary;

  /** Entries archived */
  archivedEntries: string[];

  /** Tokens saved */
  tokensSaved: number;

  /** Lines reduced */
  linesReduced: number;
}

// ============================================================================
// Semantic Index Interface
// ============================================================================

/**
 * Semantic index interface (stub for future implementation)
 */
export interface ISemanticIndex {
  /** Index an entry */
  index(entry: MemoryEntry): Promise<void>;

  /** Search entries by query */
  search(query: string, options?: SemanticSearchOptions): Promise<SemanticSearchResult[]>;

  /** Remove entry from index */
  remove(entryId: string): Promise<boolean>;

  /** Clear all indexed entries for a workflow */
  clearWorkflow(workflowId: string): Promise<void>;
}

/**
 * Semantic search options
 */
export interface SemanticSearchOptions {
  workflowId?: string;
  layers?: MemoryLayer[];
  types?: MemoryEntryType[];
  limit?: number;
  minScore?: number;
}

/**
 * Semantic search result
 */
export interface SemanticSearchResult {
  entry: MemoryEntry;
  score: number;
  highlights?: string[];
}

// ============================================================================
// Memory Manager Events
// ============================================================================

/**
 * Memory manager event types
 */
export type MemoryEventType =
  | 'entry_added'
  | 'entry_updated'
  | 'entry_deleted'
  | 'entry_moved'
  | 'checkpoint_created'
  | 'checkpoint_restored'
  | 'compaction_started'
  | 'compaction_completed'
  | 'archive_completed';

/**
 * Memory event
 */
export interface MemoryEvent {
  type: MemoryEventType;
  workflowId: string;
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * Memory event listener
 */
export type MemoryEventListener = (event: MemoryEvent) => void;

// ============================================================================
// Memory Manager Config
// ============================================================================

/**
 * Memory manager configuration
 */
export interface MemoryManagerConfig {
  /** Compaction trigger settings */
  compactionTrigger: CompactionTrigger;

  /** Max entries per layer */
  maxEntriesPerLayer: number;

  /** Max checkpoints to keep */
  maxCheckpoints: number;

  /** Auto archive after (ms) */
  autoArchiveAfter: number;

  /** Enable semantic indexing */
  enableSemanticIndex: boolean;
}

/**
 * Default memory manager configuration
 */
export const DEFAULT_MEMORY_MANAGER_CONFIG: MemoryManagerConfig = {
  compactionTrigger: {
    maxLines: 1500,
    maxTokens: 60000,
    completedNodesThreshold: 5,
    phaseChangeTrigger: true,
    idleTrigger: true,
    idleDurationMs: 30000,
  },
  maxEntriesPerLayer: 1000,
  maxCheckpoints: 10,
  autoArchiveAfter: 7 * 24 * 60 * 60 * 1000, // 7 days
  enableSemanticIndex: false,
};

// ============================================================================
// Helper Types
// ============================================================================

/**
 * Memory layer info
 */
export interface MemoryLayerInfo {
  layer: MemoryLayer;
  entryCount: number;
  totalTokens: number;
  totalLines: number;
  oldestEntry?: number;
  newestEntry?: number;
}

/**
 * Memory workflow state
 */
export interface MemoryWorkflowState {
  workflowId: string;
  activeMemory: ActiveMemory | null;
  layers: MemoryLayerInfo[];
  checkpointCount: number;
  summaryCount: number;
  lastCompaction?: number;
  lastCheckpoint?: number;
}
