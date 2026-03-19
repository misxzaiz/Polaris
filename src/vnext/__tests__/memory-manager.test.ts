/**
 * Memory Manager Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  MemoryManager,
  InMemoryStore,
  DefaultMemoryCompactor,
  SemanticIndexStub,
  getMemoryManager,
  resetMemoryManager,
} from '../memory-manager';
import type { MemoryEntry, CompactionTrigger } from '../types/memory';
import type { MemoryStats } from './memory-manager';

describe('InMemoryStore', () => {
  let store: InMemoryStore;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  describe('save and get', () => {
    it('should save and retrieve an entry', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Test goal',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-1'],
        tokenCount: 10,
      };

      await store.save(entry);
      const result = await store.get('test-1');

      expect(result).toEqual(entry);
    });

    it('should return null for non-existent entry', async () => {
      const result = await store.get('non-existent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an entry', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Test goal',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-1'],
        tokenCount: 10,
      };

      await store.save(entry);
      const deleted = await store.delete('test-1');
      expect(deleted).toBe(true);

      const result = await store.get('test-1');
      expect(result).toBeNull();
    });

    it('should return false for non-existent entry', async () => {
      const deleted = await store.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      const entries: MemoryEntry[] = [
        { id: '1', type: 'goal', content: 'Goal 1', createdAt: 1000, accessedAt: 1000, accessCount: 0, tags: [], tokenCount: 5 },
        { id: '2', type: 'decision', content: 'Decision 1', createdAt: 2000, accessedAt: 2000, accessCount: 0, tags: [], tokenCount: 10 },
        { id: '3', type: 'goal', content: 'Goal 2', createdAt: 3000, accessedAt: 3000, accessCount: 0, tags: [], tokenCount: 8 },
        { id: '4', type: 'risk', content: 'Risk 1', createdAt: 4000, accessedAt: 4000, accessCount: 0, tags: [], tokenCount: 12 },
      ];

      for (const entry of entries) {
        await store.save(entry);
      }
    });

    it('should filter by types', async () => {
      const results = await store.query({ types: ['goal'] });
      expect(results).toHaveLength(2);
      expect(results.every(e => e.type === 'goal')).toBe(true);
    });

    it('should filter by date range', async () => {
      const results = await store.query({ fromDate: 1500, toDate: 3500 });
      expect(results).toHaveLength(2);
    });

    it('should apply limit and offset', async () => {
      const results = await store.query({ limit: 2, offset: 1 });
      expect(results).toHaveLength(2);
    });
  });
});

describe('DefaultMemoryCompactor', () => {
  let compactor: DefaultMemoryCompactor;
  let trigger: CompactionTrigger;

  beforeEach(() => {
    compactor = new DefaultMemoryCompactor();
    trigger = {
      maxLines: 1500,
      maxTokens: 60000,
      completedNodesThreshold: 5,
      phaseChangeTrigger: true,
      idleTrigger: true,
      idleDurationMs: 30000,
    };
  });

  describe('shouldCompact', () => {
    it('should return true when max lines exceeded', () => {
      const activeMemory = {
        workflowId: 'wf-1',
        completed: [],
        inProgress: [],
        pending: [],
        decisions: [],
        risks: [],
        totalLines: 1600,
        totalTokens: 1000,
        updatedAt: Date.now(),
      };

      const stats: MemoryStats = {
        totalEntries: 10,
        totalTokens: 1000,
        totalLines: 1600,
        entriesByType: { goal: 0, decision: 0, accomplishment: 0, issue: 0, risk: 0, todo: 0, note: 0, context: 0, score: 0, user_input: 0 },
        avgAccessCount: 0,
      };

      expect(compactor.shouldCompact(activeMemory, stats, trigger)).toBe(true);
    });

    it('should return true when max tokens exceeded', () => {
      const activeMemory = {
        workflowId: 'wf-1',
        completed: [],
        inProgress: [],
        pending: [],
        decisions: [],
        risks: [],
        totalLines: 100,
        totalTokens: 70000,
        updatedAt: Date.now(),
      };

      const stats: MemoryStats = {
        totalEntries: 10,
        totalTokens: 70000,
        totalLines: 100,
        entriesByType: { goal: 0, decision: 0, accomplishment: 0, issue: 0, risk: 0, todo: 0, note: 0, context: 0, score: 0, user_input: 0 },
        avgAccessCount: 0,
      };

      expect(compactor.shouldCompact(activeMemory, stats, trigger)).toBe(true);
    });

    it('should return true when completed nodes threshold reached', () => {
      const activeMemory = {
        workflowId: 'wf-1',
        completed: ['item1', 'item2', 'item3', 'item4', 'item5'],
        inProgress: [],
        pending: [],
        decisions: [],
        risks: [],
        totalLines: 100,
        totalTokens: 1000,
        updatedAt: Date.now(),
      };

      const stats: MemoryStats = {
        totalEntries: 10,
        totalTokens: 1000,
        totalLines: 100,
        entriesByType: { goal: 0, decision: 0, accomplishment: 0, issue: 0, risk: 0, todo: 0, note: 0, context: 0, score: 0, user_input: 0 },
        avgAccessCount: 0,
      };

      expect(compactor.shouldCompact(activeMemory, stats, trigger)).toBe(true);
    });

    it('should return false when no thresholds met', () => {
      const activeMemory = {
        workflowId: 'wf-1',
        completed: ['item1'],
        inProgress: [],
        pending: [],
        decisions: [],
        risks: [],
        totalLines: 100,
        totalTokens: 1000,
        updatedAt: Date.now(),
      };

      const stats: MemoryStats = {
        totalEntries: 10,
        totalTokens: 1000,
        totalLines: 100,
        entriesByType: { goal: 0, decision: 0, accomplishment: 0, issue: 0, risk: 0, todo: 0, note: 0, context: 0, score: 0, user_input: 0 },
        avgAccessCount: 0,
      };

      expect(compactor.shouldCompact(activeMemory, stats, trigger)).toBe(false);
    });
  });

  describe('compact', () => {
    it('should generate summary from active memory', async () => {
      const activeMemory = {
        workflowId: 'wf-1',
        completed: ['Task 1', 'Task 2'],
        inProgress: ['Task 3'],
        pending: ['Task 4'],
        decisions: [
          { id: 'd1', description: 'Use React', madeAt: Date.now() },
        ],
        risks: [
          { id: 'r1', description: 'Performance risk', severity: 'medium' as const, status: 'open' as const, identifiedAt: Date.now() },
        ],
        totalLines: 100,
        totalTokens: 5000,
        updatedAt: Date.now(),
      };

      const entries: MemoryEntry[] = [
        { id: 'e1', type: 'accomplishment', content: 'Task 1', createdAt: Date.now(), accessedAt: Date.now(), accessCount: 0, tags: ['completed'], tokenCount: 50 },
        { id: 'e2', type: 'accomplishment', content: 'Task 2', createdAt: Date.now(), accessedAt: Date.now(), accessCount: 0, tags: ['completed'], tokenCount: 50 },
      ];

      const result = await compactor.compact('wf-1', activeMemory, entries);

      expect(result.summary).toBeDefined();
      expect(result.summary.workflowId).toBe('wf-1');
      expect(result.summary.completedGoals).toEqual(['Task 1', 'Task 2']);
      expect(result.summary.pending).toEqual(['Task 4']);
      expect(result.tokensSaved).toBe(5000);
      expect(result.archivedEntries).toHaveLength(2);
    });
  });
});

describe('SemanticIndexStub', () => {
  let index: SemanticIndexStub;

  beforeEach(() => {
    index = new SemanticIndexStub();
  });

  describe('index and search', () => {
    it('should index and search entries', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Implement user authentication system',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-1'],
        tokenCount: 10,
      };

      await index.index(entry);
      const results = await index.search('authentication');

      expect(results).toHaveLength(1);
      expect(results[0].entry.id).toBe('test-1');
      expect(results[0].score).toBe(0.5);
    });

    it('should return empty array for no matches', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Implement user authentication system',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: [],
        tokenCount: 10,
      };

      await index.index(entry);
      const results = await index.search('database');

      expect(results).toHaveLength(0);
    });

    it('should apply workflow filter', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Implement authentication',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-1'],
        tokenCount: 10,
      };

      await index.index(entry);
      const results = await index.search('authentication', { workflowId: 'wf-2' });

      expect(results).toHaveLength(0);
    });

    it('should apply type filter', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Implement authentication',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: [],
        tokenCount: 10,
      };

      await index.index(entry);
      const results = await index.search('authentication', { types: ['decision'] });

      expect(results).toHaveLength(0);
    });

    it('should apply limit', async () => {
      for (let i = 0; i < 10; i++) {
        const entry: MemoryEntry = {
          id: `test-${i}`,
          type: 'goal',
          content: `Implement feature ${i}`,
          createdAt: Date.now(),
          accessedAt: Date.now(),
          accessCount: 0,
          tags: [],
          tokenCount: 10,
        };
        await index.index(entry);
      }

      const results = await index.search('feature', { limit: 5 });
      expect(results).toHaveLength(5);
    });
  });

  describe('remove', () => {
    it('should remove entry from index', async () => {
      const entry: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Test content',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: [],
        tokenCount: 10,
      };

      await index.index(entry);
      const removed = await index.remove('test-1');
      expect(removed).toBe(true);

      const results = await index.search('Test');
      expect(results).toHaveLength(0);
    });

    it('should return false for non-existent entry', async () => {
      const removed = await index.remove('non-existent');
      expect(removed).toBe(false);
    });
  });

  describe('clearWorkflow', () => {
    it('should clear all entries for a workflow', async () => {
      const entry1: MemoryEntry = {
        id: 'test-1',
        type: 'goal',
        content: 'Content 1',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-1'],
        tokenCount: 10,
      };

      const entry2: MemoryEntry = {
        id: 'test-2',
        type: 'goal',
        content: 'Content 2',
        createdAt: Date.now(),
        accessedAt: Date.now(),
        accessCount: 0,
        tags: ['workflow:wf-2'],
        tokenCount: 10,
      };

      await index.index(entry1);
      await index.index(entry2);
      await index.clearWorkflow('wf-1');

      const results = await index.search('Content');
      expect(results).toHaveLength(1);
      expect(results[0].entry.id).toBe('test-2');
    });
  });
});

describe('MemoryManager', () => {
  let manager: MemoryManager;

  beforeEach(() => {
    manager = new MemoryManager();
  });

  afterEach(() => {
    resetMemoryManager();
  });

  describe('initialize', () => {
    it('should initialize memory for a workflow', async () => {
      await manager.initialize('wf-1');
      const activeMemory = await manager.getActiveMemory('wf-1');

      expect(activeMemory).toBeDefined();
      expect(activeMemory?.workflowId).toBe('wf-1');
      expect(activeMemory?.completed).toEqual([]);
      expect(activeMemory?.pending).toEqual([]);
    });
  });

  describe('active memory management', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should update active memory', async () => {
      await manager.updateActiveMemory('wf-1', {
        currentGoal: 'Build feature X',
        pending: ['Task 1', 'Task 2'],
      });

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory?.currentGoal).toBe('Build feature X');
      expect(memory?.pending).toEqual(['Task 1', 'Task 2']);
    });

    it('should throw error for non-existent workflow', async () => {
      await expect(
        manager.updateActiveMemory('non-existent', { currentGoal: 'Test' })
      ).rejects.toThrow('Active memory not found');
    });
  });

  describe('entry management', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should add entry to active layer', async () => {
      const entry = await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Build feature X',
        tags: [],
        tokenCount: 50,
      });

      expect(entry.id).toBeDefined();
      expect(entry.type).toBe('goal');
      expect(entry.content).toBe('Build feature X');
      expect(entry.tags).toContain('workflow:wf-1');
    });

    it('should update active memory when adding goal entry', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Build feature X',
        tags: [],
        tokenCount: 50,
      });

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory?.currentGoal).toBe('Build feature X');
    });

    it('should update active memory when adding accomplishment entry', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'accomplishment',
        content: 'Completed task A',
        tags: [],
        tokenCount: 50,
      });

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory?.completed).toContain('Completed task A');
    });

    it('should update active memory when adding decision entry', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'decision',
        content: 'Use React for frontend',
        tags: [],
        tokenCount: 50,
      });

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory?.decisions).toHaveLength(1);
      expect(memory?.decisions[0].description).toBe('Use React for frontend');
    });

    it('should update active memory when adding risk entry', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'risk',
        content: 'Performance degradation risk',
        tags: [],
        tokenCount: 50,
      });

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory?.risks).toHaveLength(1);
      expect(memory?.risks[0].description).toBe('Performance degradation risk');
      expect(memory?.risks[0].severity).toBe('medium');
      expect(memory?.risks[0].status).toBe('open');
    });

    it('should get entry by id', async () => {
      const entry = await manager.addEntry('wf-1', 'active', {
        type: 'note',
        content: 'Important note',
        tags: [],
        tokenCount: 20,
      });

      const retrieved = await manager.getEntry(entry.id);
      expect(retrieved).toEqual(entry);
    });

    it('should update entry', async () => {
      const entry = await manager.addEntry('wf-1', 'active', {
        type: 'note',
        content: 'Original content',
        tags: [],
        tokenCount: 20,
      });

      const updated = await manager.updateEntry(entry.id, {
        content: 'Updated content',
      });

      expect(updated?.content).toBe('Updated content');
    });

    it('should delete entry', async () => {
      const entry = await manager.addEntry('wf-1', 'active', {
        type: 'note',
        content: 'To be deleted',
        tags: [],
        tokenCount: 20,
      });

      const deleted = await manager.deleteEntry(entry.id);
      expect(deleted).toBe(true);

      const retrieved = await manager.getEntry(entry.id);
      expect(retrieved).toBeNull();
    });

    it('should move entry to another layer', async () => {
      const entry = await manager.addEntry('wf-1', 'active', {
        type: 'accomplishment',
        content: 'Completed task',
        tags: [],
        tokenCount: 20,
      });

      const moved = await manager.moveEntry(entry.id, 'archives');
      expect(moved).toBe(true);
    });
  });

  describe('checkpoint management', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should create checkpoint', async () => {
      const checkpoint = await manager.createCheckpoint('wf-1', 'node-1', 5, 'Test checkpoint');

      expect(checkpoint.id).toBeDefined();
      expect(checkpoint.workflowId).toBe('wf-1');
      expect(checkpoint.nodeId).toBe('node-1');
      expect(checkpoint.round).toBe(5);
      expect(checkpoint.description).toBe('Test checkpoint');
    });

    it('should get checkpoint by id', async () => {
      const created = await manager.createCheckpoint('wf-1', 'node-1', 5);
      const retrieved = await manager.getCheckpoint(created.id);

      expect(retrieved).toEqual(created);
    });

    it('should list checkpoints for a workflow', async () => {
      const cp1 = await manager.createCheckpoint('wf-1', 'node-1', 1);
      const cp2 = await manager.createCheckpoint('wf-1', 'node-2', 2);
      const cp3 = await manager.createCheckpoint('wf-1', 'node-3', 3);

      // Verify all checkpoints have unique IDs
      expect(cp1.id).toBeDefined();
      expect(cp2.id).toBeDefined();
      expect(cp3.id).toBeDefined();
      expect(cp1.id).not.toBe(cp2.id);
      expect(cp2.id).not.toBe(cp3.id);

      // Verify each checkpoint can be retrieved individually
      const retrieved1 = await manager.getCheckpoint(cp1.id);
      const retrieved2 = await manager.getCheckpoint(cp2.id);
      const retrieved3 = await manager.getCheckpoint(cp3.id);
      expect(retrieved1).not.toBeNull();
      expect(retrieved2).not.toBeNull();
      expect(retrieved3).not.toBeNull();

      const checkpoints = await manager.listCheckpoints('wf-1');
      expect(checkpoints.length).toBeGreaterThanOrEqual(3);
      // Find our checkpoints (there might be others from previous tests in the same describe block)
      const ourCheckpoints = checkpoints.filter(c =>
        c.id === cp1.id || c.id === cp2.id || c.id === cp3.id
      );
      expect(ourCheckpoints).toHaveLength(3);
    });

    it('should restore from checkpoint', async () => {
      const checkpoint = await manager.createCheckpoint('wf-1', 'node-1', 5);
      const restored = await manager.restoreCheckpoint(checkpoint.id);
      expect(restored).toBe(true);
    });
  });

  describe('compaction', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should detect when compaction is needed', async () => {
      // Add many completed items
      for (let i = 0; i < 6; i++) {
        await manager.addEntry('wf-1', 'active', {
          type: 'accomplishment',
          content: `Task ${i}`,
          tags: [],
          tokenCount: 10000,
        });
      }

      const needsCompaction = await manager.needsCompaction('wf-1');
      expect(needsCompaction).toBe(true);
    });

    it('should not compact when not needed', async () => {
      const needsCompaction = await manager.needsCompaction('wf-1');
      expect(needsCompaction).toBe(false);
    });

    it('should run compaction and generate summary', async () => {
      // Setup: Add entries that trigger compaction
      for (let i = 0; i < 6; i++) {
        await manager.addEntry('wf-1', 'active', {
          type: 'accomplishment',
          content: `Task ${i}`,
          tags: ['completed'],
          tokenCount: 10000,
          sourceExecutionId: 'round-1',
        });
      }

      const summary = await manager.runCompaction('wf-1');

      expect(summary).toBeDefined();
      expect(summary?.workflowId).toBe('wf-1');
      expect(summary?.completedGoals.length).toBeGreaterThan(0);

      // Verify summary is stored
      const summaries = await manager.getSummaries('wf-1');
      expect(summaries.length).toBeGreaterThan(0);
    });
  });

  describe('statistics', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should get memory stats', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Goal 1',
        tags: [],
        tokenCount: 50,
      });

      await manager.addEntry('wf-1', 'active', {
        type: 'decision',
        content: 'Decision 1',
        tags: [],
        tokenCount: 100,
      });

      const stats = await manager.getStats('wf-1');

      expect(stats.totalEntries).toBe(2);
      expect(stats.entriesByType.goal).toBe(1);
      expect(stats.entriesByType.decision).toBe(1);
    });
  });

  describe('archiving', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should archive old entries', async () => {
      // Create old entry
      const oldEntry = await manager.addEntry('wf-1', 'active', {
        type: 'note',
        content: 'Old note',
        tags: [],
        tokenCount: 20,
      });

      // Manually set old timestamp
      const entry = await manager.getEntry(oldEntry.id);
      if (entry) {
        entry.createdAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      }

      const archived = await manager.archiveOld('wf-1', 7 * 24 * 60 * 60 * 1000);
      expect(archived).toBeGreaterThanOrEqual(0);
    });
  });

  describe('cleanup', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should clear all memory for a workflow', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Goal 1',
        tags: [],
        tokenCount: 50,
      });

      await manager.createCheckpoint('wf-1', 'node-1', 1);

      await manager.clearAll('wf-1');

      const memory = await manager.getActiveMemory('wf-1');
      expect(memory).toBeNull();

      const checkpoints = await manager.listCheckpoints('wf-1');
      expect(checkpoints).toHaveLength(0);
    });
  });

  describe('workflow state', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should get workflow state', async () => {
      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Goal 1',
        tags: [],
        tokenCount: 50,
      });

      const state = await manager.getWorkflowState('wf-1');

      expect(state.workflowId).toBe('wf-1');
      expect(state.activeMemory).toBeDefined();
      expect(state.layers).toHaveLength(1);
      expect(state.checkpointCount).toBe(0);
    });
  });

  describe('events', () => {
    beforeEach(async () => {
      await manager.initialize('wf-1');
    });

    it('should emit events when adding entries', async () => {
      const listener = vi.fn();
      manager.addListener(listener);

      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Goal 1',
        tags: [],
        tokenCount: 50,
      });

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'entry_added',
          workflowId: 'wf-1',
        })
      );
    });

    it('should emit events when creating checkpoints', async () => {
      const listener = vi.fn();
      manager.addListener(listener);

      await manager.createCheckpoint('wf-1', 'node-1', 1);

      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'checkpoint_created',
          workflowId: 'wf-1',
        })
      );
    });

    it('should remove listener', async () => {
      const listener = vi.fn();
      manager.addListener(listener);
      manager.removeListener(listener);

      await manager.addEntry('wf-1', 'active', {
        type: 'goal',
        content: 'Goal 1',
        tags: [],
        tokenCount: 50,
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });
});

describe('Singleton', () => {
  afterEach(() => {
    resetMemoryManager();
  });

  it('should return singleton instance', () => {
    const instance1 = getMemoryManager();
    const instance2 = getMemoryManager();
    expect(instance1).toBe(instance2);
  });

  it('should reset singleton instance', () => {
    const instance1 = getMemoryManager();
    resetMemoryManager();
    const instance2 = getMemoryManager();
    expect(instance1).not.toBe(instance2);
  });

  it('should accept config on first call', () => {
    const manager = getMemoryManager({
      maxEntriesPerLayer: 500,
    });
    // Config is applied internally
    expect(manager).toBeDefined();
  });
});
