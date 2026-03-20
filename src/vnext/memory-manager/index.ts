/**
 * Scheduler vNext - Memory Manager
 *
 * Memory lifecycle management for workflow execution
 */

import type {
  MemoryLayer,
  MemoryEntry,
  ActiveMemory,
  MemorySummary,
  MemoryCheckpoint,
  CompactionTrigger,
  MemoryStats,
  Decision,
  Risk,
} from '../types/memory';

import type {
  IMemoryManager,
  IMemoryStore,
  IMemoryCompactor,
  ISemanticIndex,
  MemoryManagerConfig,
  MemoryEventListener,
  MemoryEvent,
  MemoryEventType,
  MemoryQueryFilter,
  CompactionResult,
  MemoryWorkflowState,
  MemoryLayerInfo,
} from './types';

import { DEFAULT_MEMORY_MANAGER_CONFIG } from './types';

// ============================================================================
// In-Memory Store Implementation
// ============================================================================

/**
 * In-memory implementation of memory store
 */
export class InMemoryStore implements IMemoryStore {
  private entries: Map<string, MemoryEntry> = new Map();
  private layerIndex: Map<string, Set<string>> = new Map(); // layer:workflowId -> entryIds

  private getLayerKey(layer: MemoryLayer, workflowId: string): string {
    return `${layer}:${workflowId}`;
  }

  async get(id: string): Promise<MemoryEntry | null> {
    return this.entries.get(id) || null;
  }

  async getAll(layer: MemoryLayer, workflowId: string): Promise<MemoryEntry[]> {
    const key = this.getLayerKey(layer, workflowId);
    const ids = this.layerIndex.get(key);
    if (!ids) return [];

    const entries: MemoryEntry[] = [];
    for (const id of ids) {
      const entry = this.entries.get(id);
      if (entry) entries.push(entry);
    }
    return entries.sort((a, b) => b.createdAt - a.createdAt);
  }

  async save(entry: MemoryEntry): Promise<void> {
    this.entries.set(entry.id, entry);

    // Find workflowId from tags
    const _workflowId = entry.tags.find(t => t.startsWith('workflow:'))?.split(':')[1];
    if (_workflowId) {
      const activeKey = this.getLayerKey('active', _workflowId);
      if (!this.layerIndex.has(activeKey)) {
        this.layerIndex.set(activeKey, new Set());
      }
      this.layerIndex.get(activeKey)?.add(entry.id);
    }
  }

  async delete(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;

    this.entries.delete(id);

    // Remove from all layer indexes
    for (const [, ids] of this.layerIndex) {
      ids.delete(id);
    }

    return true;
  }

  async clear(layer: MemoryLayer, workflowId: string): Promise<number> {
    const key = this.getLayerKey(layer, workflowId);
    const ids = this.layerIndex.get(key);
    if (!ids) return 0;

    const count = ids.size;
    for (const id of ids) {
      this.entries.delete(id);
    }
    this.layerIndex.delete(key);
    return count;
  }

  async query(filter: MemoryQueryFilter): Promise<MemoryEntry[]> {
    let results = Array.from(this.entries.values());

    const filterTypes = filter.types;
    if (filterTypes && filterTypes.length > 0) {
      results = results.filter(e => filterTypes.includes(e.type));
    }

    const filterTags = filter.tags;
    if (filterTags && filterTags.length > 0) {
      results = results.filter(e => filterTags.some(t => e.tags.includes(t)));
    }

    const fromDate = filter.fromDate;
    if (fromDate !== undefined) {
      results = results.filter(e => e.createdAt >= fromDate);
    }

    const toDate = filter.toDate;
    if (toDate !== undefined) {
      results = results.filter(e => e.createdAt <= toDate);
    }

    const minRelevanceScore = filter.minRelevanceScore;
    if (minRelevanceScore !== undefined) {
      results = results.filter(e => (e.relevanceScore || 0) >= minRelevanceScore);
    }

    results.sort((a, b) => b.createdAt - a.createdAt);

    if (filter.offset !== undefined) {
      results = results.slice(filter.offset);
    }

    if (filter.limit !== undefined) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  async count(layer: MemoryLayer, workflowId: string): Promise<number> {
    const key = this.getLayerKey(layer, workflowId);
    const ids = this.layerIndex.get(key);
    return ids ? ids.size : 0;
  }
}

// ============================================================================
// Memory Compactor Implementation
// ============================================================================

/**
 * Default memory compactor implementation
 */
export class DefaultMemoryCompactor implements IMemoryCompactor {
  shouldCompact(activeMemory: ActiveMemory, _stats: MemoryStats, trigger: CompactionTrigger): boolean {
    // Check line threshold
    if (activeMemory.totalLines >= trigger.maxLines) {
      return true;
    }

    // Check token threshold
    if (activeMemory.totalTokens >= trigger.maxTokens) {
      return true;
    }

    // Check completed nodes threshold
    if (activeMemory.completed.length >= trigger.completedNodesThreshold) {
      return true;
    }

    return false;
  }

  async compact(workflowId: string, activeMemory: ActiveMemory, entries: MemoryEntry[]): Promise<CompactionResult> {
    const now = Date.now();

    // Build summary from active memory
    const summary: MemorySummary = {
      id: `summary-${workflowId}-${now}`,
      workflowId,
      periodStart: now - 24 * 60 * 60 * 1000, // Last 24 hours
      periodEnd: now,
      roundsCovered: [], // Will be populated from entries
      completedGoals: activeMemory.completed,
      keyDecisions: activeMemory.decisions,
      pending: activeMemory.pending,
      risks: activeMemory.risks.filter(r => r.status === 'open'),
      tokensSaved: activeMemory.totalTokens,
      createdAt: now,
    };

    // Extract rounds from entries
    const rounds = new Set<number>();
    for (const entry of entries) {
      // Assume round is embedded in sourceExecutionId
      const match = entry.sourceExecutionId?.match(/round-(\d+)/);
      if (match) {
        rounds.add(parseInt(match[1], 10));
      }
    }
    summary.roundsCovered = Array.from(rounds).sort((a, b) => a - b);

    // Calculate saved tokens and lines
    const tokensSaved = activeMemory.totalTokens;
    const linesReduced = activeMemory.totalLines;

    // Determine archived entries (completed items)
    const archivedEntries = entries
      .filter(e => e.type === 'accomplishment' || e.tags.includes('completed'))
      .map(e => e.id);

    return {
      summary,
      archivedEntries,
      tokensSaved,
      linesReduced,
    };
  }
}

// ============================================================================
// Semantic Index Stub
// ============================================================================

/**
 * Stub implementation of semantic index
 * Future: Will integrate with vector database for semantic search
 */
export class SemanticIndexStub implements ISemanticIndex {
  private entries: Map<string, MemoryEntry> = new Map();

  async index(entry: MemoryEntry): Promise<void> {
    // Stub: Just store in memory
    this.entries.set(entry.id, entry);
  }

  async search(query: string, options?: import('./types').SemanticSearchOptions): Promise<import('./types').SemanticSearchResult[]> {
    // Stub: Simple text matching
    const results: import('./types').SemanticSearchResult[] = [];
    const lowerQuery = query.toLowerCase();

    for (const entry of this.entries.values()) {
      if (entry.content.toLowerCase().includes(lowerQuery)) {
        // Apply filters
        if (options?.workflowId && !entry.tags.includes(`workflow:${options.workflowId}`)) {
          continue;
        }
        if (options?.types && !options.types.includes(entry.type)) {
          continue;
        }

        results.push({
          entry,
          score: 0.5, // Simple match score
          highlights: [entry.content.substring(0, 100)],
        });

        if (options?.limit && results.length >= options.limit) {
          break;
        }
      }
    }

    return results;
  }

  async remove(entryId: string): Promise<boolean> {
    return this.entries.delete(entryId);
  }

  async clearWorkflow(workflowId: string): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.tags.includes(`workflow:${workflowId}`)) {
        this.entries.delete(id);
      }
    }
  }
}

// ============================================================================
// Memory Manager Implementation
// ============================================================================

/**
 * Memory Manager implementation
 */
export class MemoryManager implements IMemoryManager {
  private store: IMemoryStore;
  private compactor: IMemoryCompactor;
  private semanticIndex: ISemanticIndex;
  private config: MemoryManagerConfig;

  // In-memory caches
  private activeMemories: Map<string, ActiveMemory> = new Map();
  private checkpoints: Map<string, MemoryCheckpoint> = new Map();
  private summaries: Map<string, MemorySummary[]> = new Map();

  // Event listeners
  private listeners: MemoryEventListener[] = [];

  // Entry ID counter
  private entryCounter = 0;
  private checkpointCounter = 0;

  constructor(
    store?: IMemoryStore,
    compactor?: IMemoryCompactor,
    semanticIndex?: ISemanticIndex,
    config?: Partial<MemoryManagerConfig>
  ) {
    this.store = store || new InMemoryStore();
    this.compactor = compactor || new DefaultMemoryCompactor();
    this.semanticIndex = semanticIndex || new SemanticIndexStub();
    this.config = { ...DEFAULT_MEMORY_MANAGER_CONFIG, ...config };
  }

  // =========================================================================
  // Initialization
  // =========================================================================

  async initialize(workflowId: string): Promise<void> {
    // Create initial active memory
    const activeMemory: ActiveMemory = {
      workflowId,
      completed: [],
      inProgress: [],
      pending: [],
      decisions: [],
      risks: [],
      totalLines: 0,
      totalTokens: 0,
      updatedAt: Date.now(),
    };

    this.activeMemories.set(workflowId, activeMemory);
    this.emit({ type: 'entry_added', workflowId, timestamp: Date.now() });
  }

  // =========================================================================
  // Active Memory Management
  // =========================================================================

  async getActiveMemory(workflowId: string): Promise<ActiveMemory | null> {
    return this.activeMemories.get(workflowId) || null;
  }

  async updateActiveMemory(workflowId: string, updates: Partial<ActiveMemory>): Promise<void> {
    const active = this.activeMemories.get(workflowId);
    if (!active) {
      throw new Error(`Active memory not found for workflow: ${workflowId}`);
    }

    // Apply updates
    Object.assign(active, updates, { updatedAt: Date.now() });

    // Recalculate totals
    if (updates.completed || updates.inProgress || updates.pending || updates.decisions || updates.risks) {
      active.totalLines = this.calculateLines(active);
      active.totalTokens = this.calculateTokens(active);
    }

    this.emit({ type: 'entry_updated', workflowId, timestamp: Date.now() });
  }

  private calculateLines(memory: ActiveMemory): number {
    let lines = 0;
    lines += memory.completed.length;
    lines += memory.inProgress.length;
    lines += memory.pending.length;
    lines += memory.decisions.length * 3; // Decisions are multi-line
    lines += memory.risks.length * 3; // Risks are multi-line
    if (memory.currentGoal) lines += 2;
    if (memory.currentFocus) lines += 2;
    return lines;
  }

  private calculateTokens(memory: ActiveMemory): number {
    // Rough estimate: ~4 characters per token
    let chars = 0;
    chars += memory.completed.join('').length;
    chars += memory.inProgress.join('').length;
    chars += memory.pending.join('').length;
    chars += memory.decisions.map(d => d.description + (d.rationale || '')).join('').length;
    chars += memory.risks.map(r => r.description + (r.mitigation || '')).join('').length;
    if (memory.currentGoal) chars += memory.currentGoal.length;
    if (memory.currentFocus) chars += memory.currentFocus.length;
    return Math.ceil(chars / 4);
  }

  // =========================================================================
  // Entry Management
  // =========================================================================

  async addEntry(
    workflowId: string,
    layer: MemoryLayer,
    entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'accessedAt' | 'accessCount'>
  ): Promise<MemoryEntry> {
    const now = Date.now();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: `mem-${workflowId}-${++this.entryCounter}`,
      createdAt: now,
      accessedAt: now,
      accessCount: 0,
    };

    // Add workflow tag
    if (!fullEntry.tags.includes(`workflow:${workflowId}`)) {
      fullEntry.tags.push(`workflow:${workflowId}`);
    }

    await this.store.save(fullEntry);

    // Update active memory if needed
    await this.updateActiveMemoryFromEntry(workflowId, fullEntry);

    // Index for semantic search
    if (this.config.enableSemanticIndex) {
      await this.semanticIndex.index(fullEntry);
    }

    this.emit({
      type: 'entry_added',
      workflowId,
      timestamp: now,
      data: { entryId: fullEntry.id, layer },
    });

    return fullEntry;
  }

  private async updateActiveMemoryFromEntry(workflowId: string, entry: MemoryEntry): Promise<void> {
    const active = this.activeMemories.get(workflowId);
    if (!active) return;

    switch (entry.type) {
      case 'goal':
        active.currentGoal = entry.content;
        break;
      case 'accomplishment':
        if (!active.completed.includes(entry.content)) {
          active.completed.push(entry.content);
        }
        // Remove from inProgress if present
        active.inProgress = active.inProgress.filter(i => i !== entry.content);
        break;
      case 'todo':
        if (!active.pending.includes(entry.content)) {
          active.pending.push(entry.content);
        }
        break;
      case 'decision': {
        const decision: Decision = {
          id: entry.id,
          description: entry.content,
          madeAt: entry.createdAt,
        };
        active.decisions.push(decision);
        break;
      }
      case 'risk': {
        const risk: Risk = {
          id: entry.id,
          description: entry.content,
          severity: 'medium',
          status: 'open',
          identifiedAt: entry.createdAt,
        };
        active.risks.push(risk);
        break;
      }
    }

    active.updatedAt = Date.now();
    active.totalLines = this.calculateLines(active);
    active.totalTokens = this.calculateTokens(active);
  }

  async getEntry(entryId: string): Promise<MemoryEntry | null> {
    const entry = await this.store.get(entryId);
    if (entry) {
      // Update access stats
      entry.accessedAt = Date.now();
      entry.accessCount++;
    }
    return entry;
  }

  async getEntries(workflowId: string, layer: MemoryLayer): Promise<MemoryEntry[]> {
    return this.store.getAll(layer, workflowId);
  }

  async updateEntry(entryId: string, updates: Partial<MemoryEntry>): Promise<MemoryEntry | null> {
    const entry = await this.store.get(entryId);
    if (!entry) return null;

    const updated = { ...entry, ...updates };
    await this.store.save(updated);

    this.emit({
      type: 'entry_updated',
      workflowId: entry.tags.find(t => t.startsWith('workflow:'))?.split(':')[1] || '',
      timestamp: Date.now(),
      data: { entryId },
    });

    return updated;
  }

  async deleteEntry(entryId: string): Promise<boolean> {
    const entry = await this.store.get(entryId);
    if (!entry) return false;

    const result = await this.store.delete(entryId);

    if (result) {
      // Remove from semantic index
      await this.semanticIndex.remove(entryId);

      this.emit({
        type: 'entry_deleted',
        workflowId: entry.tags.find(t => t.startsWith('workflow:'))?.split(':')[1] || '',
        timestamp: Date.now(),
        data: { entryId },
      });
    }

    return result;
  }

  async moveEntry(entryId: string, targetLayer: MemoryLayer): Promise<boolean> {
    const entry = await this.store.get(entryId);
    if (!entry) return false;

    // In the in-memory store, we just update tags
    if (!entry.tags.includes(`layer:${targetLayer}`)) {
      entry.tags.push(`layer:${targetLayer}`);
      await this.store.save(entry);
    }

    this.emit({
      type: 'entry_moved',
      workflowId: entry.tags.find(t => t.startsWith('workflow:'))?.split(':')[1] || '',
      timestamp: Date.now(),
      data: { entryId, targetLayer },
    });

    return true;
  }

  // =========================================================================
  // Checkpoint Management
  // =========================================================================

  async createCheckpoint(
    workflowId: string,
    nodeId: string,
    round: number,
    description?: string
  ): Promise<MemoryCheckpoint> {
    const now = Date.now();
    const checkpoint: MemoryCheckpoint = {
      id: `checkpoint-${workflowId}-${now}-${++this.checkpointCounter}`,
      workflowId,
      nodeId,
      round,
      memoryPath: `memory/${workflowId}/checkpoints/${now}`,
      createdAt: now,
      description,
    };

    this.checkpoints.set(checkpoint.id, checkpoint);

    this.emit({
      type: 'checkpoint_created',
      workflowId,
      timestamp: now,
      data: { checkpointId: checkpoint.id, nodeId, round },
    });

    return checkpoint;
  }

  async getCheckpoint(checkpointId: string): Promise<MemoryCheckpoint | null> {
    return this.checkpoints.get(checkpointId) || null;
  }

  async listCheckpoints(workflowId: string): Promise<MemoryCheckpoint[]> {
    const checkpoints: MemoryCheckpoint[] = [];
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.workflowId === workflowId) {
        checkpoints.push(checkpoint);
      }
    }
    return checkpoints.sort((a, b) => b.createdAt - a.createdAt);
  }

  async restoreCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) return false;

    // In a real implementation, this would restore memory state from disk
    // For now, we just emit the event
    this.emit({
      type: 'checkpoint_restored',
      workflowId: checkpoint.workflowId,
      timestamp: Date.now(),
      data: { checkpointId },
    });

    return true;
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  async needsCompaction(workflowId: string): Promise<boolean> {
    const activeMemory = await this.getActiveMemory(workflowId);
    if (!activeMemory) return false;

    const stats = await this.getStats(workflowId);
    return this.compactor.shouldCompact(activeMemory, stats, this.config.compactionTrigger);
  }

  async runCompaction(workflowId: string): Promise<MemorySummary | null> {
    const activeMemory = await this.getActiveMemory(workflowId);
    if (!activeMemory) return null;

    // Check if compaction is needed
    const stats = await this.getStats(workflowId);
    if (!this.compactor.shouldCompact(activeMemory, stats, this.config.compactionTrigger)) {
      return null;
    }

    this.emit({
      type: 'compaction_started',
      workflowId,
      timestamp: Date.now(),
    });

    // Get entries to compact
    const entries = await this.getEntries(workflowId, 'active');

    // Run compaction
    const result = await this.compactor.compact(workflowId, activeMemory, entries);

    // Store summary
    const workflowSummaries = this.summaries.get(workflowId) || [];
    workflowSummaries.push(result.summary);
    this.summaries.set(workflowId, workflowSummaries);

    // Archive old entries
    for (const entryId of result.archivedEntries) {
      await this.moveEntry(entryId, 'archives');
    }

    // Reset active memory (keep pending items)
    const newActiveMemory: ActiveMemory = {
      workflowId,
      completed: [],
      inProgress: [],
      pending: activeMemory.pending,
      decisions: activeMemory.decisions.slice(-3), // Keep last 3 decisions
      risks: activeMemory.risks.filter(r => r.status === 'open'),
      totalLines: 0,
      totalTokens: 0,
      updatedAt: Date.now(),
    };
    newActiveMemory.totalLines = this.calculateLines(newActiveMemory);
    newActiveMemory.totalTokens = this.calculateTokens(newActiveMemory);
    this.activeMemories.set(workflowId, newActiveMemory);

    this.emit({
      type: 'compaction_completed',
      workflowId,
      timestamp: Date.now(),
      data: {
        summaryId: result.summary.id,
        tokensSaved: result.tokensSaved,
        linesReduced: result.linesReduced,
      },
    });

    return result.summary;
  }

  // =========================================================================
  // Summaries
  // =========================================================================

  async getSummaries(workflowId: string): Promise<MemorySummary[]> {
    return this.summaries.get(workflowId) || [];
  }

  // =========================================================================
  // Statistics
  // =========================================================================

  async getStats(workflowId: string): Promise<MemoryStats> {
    const _activeMemory = this.activeMemories.get(workflowId);

    const stats: MemoryStats = {
      totalEntries: 0,
      totalTokens: 0,
      totalLines: 0,
      entriesByType: {
        goal: 0,
        decision: 0,
        accomplishment: 0,
        issue: 0,
        risk: 0,
        todo: 0,
        note: 0,
        context: 0,
        score: 0,
        user_input: 0,
      },
      avgAccessCount: 0,
    };

    // Get all entries
    const entries = await this.getEntries(workflowId, 'active');

    stats.totalEntries = entries.length;
    stats.totalTokens = entries.reduce((sum, e) => sum + e.tokenCount, 0);
    stats.totalLines = entries.reduce((sum, e) => sum + Math.ceil(e.content.length / 80), 0);

    for (const entry of entries) {
      stats.entriesByType[entry.type]++;
    }

    if (entries.length > 0) {
      const totalAccess = entries.reduce((sum, e) => sum + e.accessCount, 0);
      stats.avgAccessCount = totalAccess / entries.length;
    }

    if (entries.length > 0) {
      stats.oldestEntry = Math.min(...entries.map(e => e.createdAt));
      stats.newestEntry = Math.max(...entries.map(e => e.createdAt));
    }

    // Add active memory stats
    if (_activeMemory) {
      stats.totalTokens += _activeMemory.totalTokens;
      stats.totalLines += _activeMemory.totalLines;
    }

    return stats;
  }

  // =========================================================================
  // Archiving
  // =========================================================================

  async archiveOld(workflowId: string, olderThan: number): Promise<number> {
    const entries = await this.getEntries(workflowId, 'active');
    const threshold = Date.now() - olderThan;

    let archived = 0;
    for (const entry of entries) {
      if (entry.createdAt < threshold) {
        await this.moveEntry(entry.id, 'archives');
        archived++;
      }
    }

    if (archived > 0) {
      this.emit({
        type: 'archive_completed',
        workflowId,
        timestamp: Date.now(),
        data: { count: archived },
      });
    }

    return archived;
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  async clearAll(workflowId: string): Promise<void> {
    // Clear active memory
    this.activeMemories.delete(workflowId);

    // Clear summaries
    this.summaries.delete(workflowId);

    // Clear checkpoints
    for (const [id, checkpoint] of this.checkpoints) {
      if (checkpoint.workflowId === workflowId) {
        this.checkpoints.delete(id);
      }
    }

    // Clear store
    await this.store.clear('active', workflowId);

    // Clear semantic index
    await this.semanticIndex.clearWorkflow(workflowId);
  }

  // =========================================================================
  // State Info
  // =========================================================================

  async getWorkflowState(workflowId: string): Promise<MemoryWorkflowState> {
    const activeMemory = await this.getActiveMemory(workflowId);
    const stats = await this.getStats(workflowId);
    const checkpoints = await this.listCheckpoints(workflowId);
    const summaries = await this.getSummaries(workflowId);

    const layerInfo: MemoryLayerInfo = {
      layer: 'active',
      entryCount: stats.totalEntries,
      totalTokens: stats.totalTokens,
      totalLines: stats.totalLines,
      oldestEntry: stats.oldestEntry,
      newestEntry: stats.newestEntry,
    };

    return {
      workflowId,
      activeMemory,
      layers: [layerInfo],
      checkpointCount: checkpoints.length,
      summaryCount: summaries.length,
      lastCheckpoint: checkpoints[0]?.createdAt,
      lastCompaction: summaries[summaries.length - 1]?.createdAt,
    };
  }

  // =========================================================================
  // Events
  // =========================================================================

  addListener(listener: MemoryEventListener): void {
    this.listeners.push(listener);
  }

  removeListener(listener: MemoryEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) {
      this.listeners.splice(index, 1);
    }
  }

  private emit(event: MemoryEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let memoryManagerInstance: MemoryManager | null = null;

export function getMemoryManager(config?: Partial<MemoryManagerConfig>): MemoryManager {
  if (!memoryManagerInstance) {
    memoryManagerInstance = new MemoryManager(undefined, undefined, undefined, config);
  }
  return memoryManagerInstance;
}

export function resetMemoryManager(): void {
  memoryManagerInstance = null;
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  IMemoryManager,
  IMemoryStore,
  IMemoryCompactor,
  ISemanticIndex,
  MemoryManagerConfig,
  MemoryEventListener,
  MemoryEvent,
  MemoryEventType,
  MemoryQueryFilter,
  CompactionResult,
  MemoryWorkflowState,
  MemoryLayerInfo,
};
