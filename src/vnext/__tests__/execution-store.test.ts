/**
 * Scheduler vNext - ExecutionStore Tests
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ExecutionStore,
  getExecutionStore,
  resetExecutionStore,
} from '../execution-store';

// ============================================================================
// Tests
// ============================================================================

describe('ExecutionStore', () => {
  let store: ExecutionStore;

  beforeEach(() => {
    resetExecutionStore();
    store = new ExecutionStore({ enableLog: false, autoCleanup: false });
  });

  afterEach(() => {
    store.destroy();
  });

  // ==========================================================================
  // CRUD 操作
  // ==========================================================================

  describe('create', () => {
    it('should create a new execution record', () => {
      const record = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      expect(record.id).toBeDefined();
      expect(record.nodeId).toBe('node-1');
      expect(record.workflowId).toBe('wf-1');
      expect(record.status).toBe('PENDING');
    });

    it('should generate unique IDs', () => {
      const record1 = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });
      const record2 = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 2,
      });

      expect(record1.id).not.toBe(record2.id);
    });
  });

  describe('get', () => {
    it('should return existing record', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      const record = store.get(created.id);

      expect(record).toBeDefined();
      expect(record?.id).toBe(created.id);
    });

    it('should return undefined for non-existent record', () => {
      const record = store.get('non-existent');

      expect(record).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update existing record', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      const updated = store.update(created.id, { status: 'RUNNING' });

      expect(updated?.status).toBe('RUNNING');
    });

    it('should calculate duration when finished', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      // Use startedAt to override the create timestamp
      store.update(created.id, {
        status: 'RUNNING',
        startedAt: Date.now() - 1000,
      });
      store.update(created.id, {
        status: 'SUCCESS',
        finishedAt: Date.now(),
      });

      const record = store.get(created.id);
      expect(record?.durationMs).toBeGreaterThanOrEqual(1000);
    });

    it('should return undefined for non-existent record', () => {
      const updated = store.update('non-existent', { status: 'RUNNING' });

      expect(updated).toBeUndefined();
    });
  });

  describe('delete', () => {
    it('should delete existing record', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      const result = store.delete(created.id);

      expect(result).toBe(true);
      expect(store.get(created.id)).toBeUndefined();
    });

    it('should return false for non-existent record', () => {
      const result = store.delete('non-existent');

      expect(result).toBe(false);
    });
  });

  // ==========================================================================
  // 状态更新
  // ==========================================================================

  describe('startExecution', () => {
    it('should mark execution as running', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.startExecution(created.id);

      const record = store.get(created.id);
      expect(record?.status).toBe('RUNNING');
    });
  });

  describe('completeExecution', () => {
    it('should mark execution as success', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.completeExecution(created.id, {
        outputSnippet: 'Test output',
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });

      const record = store.get(created.id);
      expect(record?.status).toBe('SUCCESS');
      expect(record?.outputSnippet).toBe('Test output');
      expect(record?.tokenUsage?.totalTokens).toBe(150);
    });
  });

  describe('failExecution', () => {
    it('should mark execution as failed', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.failExecution(created.id, 'Test error');

      const record = store.get(created.id);
      expect(record?.status).toBe('FAILED');
      expect(record?.error).toBe('Test error');
    });
  });

  describe('timeoutExecution', () => {
    it('should mark execution as timeout', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.timeoutExecution(created.id);

      const record = store.get(created.id);
      expect(record?.status).toBe('TIMEOUT');
    });
  });

  describe('cancelExecution', () => {
    it('should mark execution as cancelled', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.cancelExecution(created.id, 'User cancelled');

      const record = store.get(created.id);
      expect(record?.status).toBe('CANCELLED');
      expect(record?.error).toBe('User cancelled');
    });
  });

  // ==========================================================================
  // 工具调用记录
  // ==========================================================================

  describe('addToolCall', () => {
    it('should add tool call to record', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.addToolCall(created.id, {
        tool: 'read_file',
        input: '{"path": "test.ts"}',
        success: true,
        resultSnippet: 'file content',
      });

      const record = store.get(created.id);
      expect(record?.toolCalls.length).toBe(1);
      expect(record?.toolCalls[0].tool).toBe('read_file');
      expect(record?.toolCalls[0].timestamp).toBeDefined();
    });

    it('should add multiple tool calls', () => {
      const created = store.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      store.addToolCall(created.id, {
        tool: 'read_file',
        input: '{}',
        success: true,
      });
      store.addToolCall(created.id, {
        tool: 'write_file',
        input: '{}',
        success: false,
        error: 'Permission denied',
      });

      const record = store.get(created.id);
      expect(record?.toolCalls.length).toBe(2);
    });
  });

  // ==========================================================================
  // 查询
  // ==========================================================================

  describe('query', () => {
    beforeEach(() => {
      // 创建测试数据
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 2 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-1', workflowId: 'wf-2', round: 1 });
    });

    it('should query by workflow ID', () => {
      const results = store.query({ workflowId: 'wf-1' });

      expect(results.length).toBe(3);
    });

    it('should query by node ID', () => {
      const results = store.query({ nodeId: 'node-1' });

      expect(results.length).toBe(3);
    });

    it('should query by status', () => {
      // 先完成一个记录
      const records = store.query({});
      store.completeExecution(records[0].id, {});

      const results = store.query({ status: 'SUCCESS' });

      expect(results.length).toBe(1);
    });

    it('should apply limit and offset', () => {
      const results = store.query({ limit: 2, offset: 1 });

      expect(results.length).toBe(2);
    });
  });

  describe('getByNode', () => {
    it('should return records for specific node', () => {
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 1 });

      const results = store.getByNode('node-1');

      expect(results.length).toBe(1);
      expect(results[0].nodeId).toBe('node-1');
    });
  });

  describe('getByWorkflow', () => {
    it('should return records for specific workflow', () => {
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-1', workflowId: 'wf-2', round: 1 });

      const results = store.getByWorkflow('wf-1');

      expect(results.length).toBe(1);
      expect(results[0].workflowId).toBe('wf-1');
    });
  });

  describe('getRunning', () => {
    it('should return running records', () => {
      const r1 = store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 1 });

      store.startExecution(r1.id);

      const results = store.getRunning();

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(r1.id);
    });
  });

  describe('getFailed', () => {
    it('should return failed records', () => {
      const r1 = store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 1 });

      store.failExecution(r1.id, 'Error');

      const results = store.getFailed();

      expect(results.length).toBe(1);
      expect(results[0].id).toBe(r1.id);
    });
  });

  // ==========================================================================
  // 统计
  // ==========================================================================

  describe('getStats', () => {
    it('should return correct stats', () => {
      const r1 = store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      const r2 = store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 2 });
      const r3 = store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 3 });

      store.completeExecution(r1.id, { tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
      store.failExecution(r2.id, 'Error');
      store.startExecution(r3.id);

      const stats = store.getStats();

      expect(stats.totalRecords).toBe(3);
      expect(stats.successCount).toBe(1);
      expect(stats.failedCount).toBe(1);
      expect(stats.runningCount).toBe(1);
      expect(stats.totalTokens).toBe(150);
    });
  });

  // ==========================================================================
  // 清理
  // ==========================================================================

  describe('cleanupExpired', () => {
    it('should remove expired records', async () => {
      const shortRetentionStore = new ExecutionStore({
        enableLog: false,
        autoCleanup: false,
        retentionMs: 100, // 100ms retention
      });

      const r1 = shortRetentionStore.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      // 等待过期
      await new Promise(resolve => setTimeout(resolve, 150));

      shortRetentionStore.completeExecution(r1.id, {});
      const removed = shortRetentionStore.cleanupExpired();

      expect(removed).toBe(1);
      expect(shortRetentionStore.get(r1.id)).toBeUndefined();

      shortRetentionStore.destroy();
    });

    it('should not remove non-terminal records', async () => {
      const shortRetentionStore = new ExecutionStore({
        enableLog: false,
        autoCleanup: false,
        retentionMs: 100,
      });

      const r1 = shortRetentionStore.create({
        nodeId: 'node-1',
        workflowId: 'wf-1',
        round: 1,
      });

      await new Promise(resolve => setTimeout(resolve, 150));

      // Still running, should not be removed
      shortRetentionStore.startExecution(r1.id);
      const removed = shortRetentionStore.cleanupExpired();

      expect(removed).toBe(0);
      expect(shortRetentionStore.get(r1.id)).toBeDefined();

      shortRetentionStore.destroy();
    });
  });

  describe('clear', () => {
    it('should clear all records', () => {
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 1 });

      store.clear();

      const results = store.query({});
      expect(results.length).toBe(0);
    });
  });

  // ==========================================================================
  // 导入导出
  // ==========================================================================

  describe('export/import', () => {
    it('should export and import records', () => {
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      store.create({ nodeId: 'node-2', workflowId: 'wf-1', round: 2 });

      const exported = store.export();
      expect(exported.length).toBe(2);

      const newStore = new ExecutionStore({ enableLog: false, autoCleanup: false });
      const imported = newStore.import(exported);

      expect(imported).toBe(2);
      expect(newStore.query({}).length).toBe(2);

      newStore.destroy();
    });

    it('should not duplicate on import', () => {
      store.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });

      const exported = store.export();
      const imported = store.import(exported);

      expect(imported).toBe(0); // Already exists
      expect(store.query({}).length).toBe(1);
    });
  });

  // ==========================================================================
  // 全局实例
  // ==========================================================================

  describe('getExecutionStore', () => {
    it('should return global instance', () => {
      const store1 = getExecutionStore();
      const store2 = getExecutionStore();

      expect(store1).toBe(store2);
    });
  });

  describe('resetExecutionStore', () => {
    it('should reset global instance', () => {
      const store1 = getExecutionStore();
      resetExecutionStore();
      const store2 = getExecutionStore();

      expect(store1).not.toBe(store2);
    });
  });

  // ==========================================================================
  // 溢出清理
  // ==========================================================================

  describe('cleanupOverflow', () => {
    it('should remove oldest records when over limit', () => {
      const limitedStore = new ExecutionStore({
        enableLog: false,
        autoCleanup: false,
        maxRecords: 3,
      });

      const r1 = limitedStore.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 1 });
      const r2 = limitedStore.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 2 });
      limitedStore.completeExecution(r1.id, {});
      limitedStore.completeExecution(r2.id, {});

      // 这些记录应该触发溢出清理
      limitedStore.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 3 });
      limitedStore.create({ nodeId: 'node-1', workflowId: 'wf-1', round: 4 });

      // 由于溢出清理，记录数应该不超过 maxRecords
      const results = limitedStore.query({});
      expect(results.length).toBeLessThanOrEqual(3);

      limitedStore.destroy();
    });
  });
});
