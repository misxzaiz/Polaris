/**
 * Scheduler vNext - Execution Record Store
 *
 * 执行记录存储系统，管理执行历史
 */

import type { ExecutionRecord, ExecutionStatus } from '../types';
import type {
  ExecutionStoreConfig as ExecutionStoreConfigType,
  ExecutionStats as ExecutionStatsType,
  CreateExecutionParams,
  CompleteExecutionParams,
} from './types';

// Re-export types from types.ts
export type {
  ExecutionStoreConfig,
  ExecutionStats,
  CreateExecutionParams,
  CompleteExecutionParams,
} from './types';

// Use aliased names for local use
type ExecutionStoreConfig = ExecutionStoreConfigType;
type ExecutionStats = ExecutionStatsType;

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 执行查询参数
 */
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
// 辅助函数
// ============================================================================

function generateExecutionId(): string {
  return `exec_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// Duration calculation utility - kept for potential future use
export function calculateDuration(record: ExecutionRecord): number {
  const start = record.startedAt ?? record.startTime;
  const end = record.finishedAt ?? record.endTime;
  if (!end || !start) return 0;
  return end - start;
}

function isExecutionTerminal(status: ExecutionStatus): boolean {
  return status !== 'PENDING' && status !== 'RUNNING';
}

// ============================================================================
// ExecutionStore 实现
// ============================================================================

/**
 * ExecutionStore - 执行记录存储
 *
 * 职责：
 * 1. 存储和管理执行记录
 * 2. 支持查询和统计
 * 3. 自动清理过期记录
 */
export class ExecutionStore {
  private config: Required<ExecutionStoreConfig>;
  private records: Map<string, ExecutionRecord> = new Map();
  private recordsByWorkflow: Map<string, Set<string>> = new Map();
  private recordsByNode: Map<string, Set<string>> = new Map();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: ExecutionStoreConfig = {}) {
    this.config = {
      maxRecords: config.maxRecords ?? 10000,
      retentionMs: config.retentionMs ?? 7 * 24 * 60 * 60 * 1000, // 7 天
      autoCleanup: config.autoCleanup ?? true,
      cleanupInterval: config.cleanupInterval ?? 60 * 60 * 1000, // 1 小时
      enableLog: config.enableLog ?? false,
    };

    if (this.config.autoCleanup) {
      this.startAutoCleanup();
    }
  }

  // ==========================================================================
  // CRUD 操作
  // ==========================================================================

  /**
   * 创建新的执行记录
   */
  create(params: CreateExecutionParams): ExecutionRecord {
    const id = generateExecutionId();
    const now = Date.now();
    const record: ExecutionRecord = {
      id,
      nodeId: params.nodeId,
      workflowId: params.workflowId,
      round: params.round,
      status: 'PENDING',
      startedAt: now,
      startTime: now,
      sessionId: params.sessionId,
      engineId: params.engineId,
      toolCalls: [],
    };

    this.addRecord(record);
    this.log(`Created execution record: ${id}`);

    return record;
  }

  /**
   * 获取执行记录
   */
  get(id: string): ExecutionRecord | undefined {
    return this.records.get(id);
  }

  /**
   * 更新执行记录
   */
  update(id: string, updates: Partial<ExecutionRecord>): ExecutionRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;

    Object.assign(record, updates);

    // 计算持续时间
    const endTime = record.finishedAt ?? record.endTime;
    const startTime = record.startedAt ?? record.startTime;
    if (endTime && startTime) {
      record.durationMs = endTime - startTime;
    }

    this.log(`Updated execution record: ${id}`);
    return record;
  }

  /**
   * 删除执行记录
   */
  delete(id: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;

    this.records.delete(id);

    // 从索引中删除
    this.recordsByWorkflow.get(record.workflowId)?.delete(id);
    this.recordsByNode.get(record.nodeId)?.delete(id);

    this.log(`Deleted execution record: ${id}`);
    return true;
  }

  // ==========================================================================
  // 状态更新
  // ==========================================================================

  /**
   * 标记执行开始
   */
  startExecution(id: string): ExecutionRecord | undefined {
    const now = Date.now();
    return this.update(id, {
      status: 'RUNNING',
      startedAt: now,
      startTime: now,
    });
  }

  /**
   * 标记执行成功
   */
  completeExecution(
    id: string,
    result: CompleteExecutionParams = {}
  ): ExecutionRecord | undefined {
    const endTime = Date.now();
    return this.update(id, {
      status: 'SUCCESS',
      finishedAt: endTime,
      endTime,
      outputSnippet: result.outputSnippet,
      summaryPath: result.summaryPath,
      tokenUsage: result.tokenUsage,
      score: result.score,
    });
  }

  /**
   * 标记执行失败
   */
  failExecution(id: string, error: string): ExecutionRecord | undefined {
    const endTime = Date.now();
    return this.update(id, {
      status: 'FAILED',
      finishedAt: endTime,
      endTime,
      error,
    });
  }

  /**
   * 标记执行超时
   */
  timeoutExecution(id: string): ExecutionRecord | undefined {
    const endTime = Date.now();
    return this.update(id, {
      status: 'TIMEOUT',
      finishedAt: endTime,
      endTime,
      error: 'Execution timed out',
    });
  }

  /**
   * 标记执行取消
   */
  cancelExecution(id: string, reason?: string): ExecutionRecord | undefined {
    const endTime = Date.now();
    return this.update(id, {
      status: 'CANCELLED',
      finishedAt: endTime,
      endTime,
      error: reason ?? 'Execution cancelled',
    });
  }

  // ==========================================================================
  // 工具调用记录
  // ==========================================================================

  /**
   * 添加工具调用记录
   */
  addToolCall(
    id: string,
    toolCall: { tool: string; input: string; success: boolean; resultSnippet?: string; error?: string }
  ): ExecutionRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;

    record.toolCalls.push({
      ...toolCall,
      timestamp: Date.now(),
    });

    return record;
  }

  // ==========================================================================
  // 查询
  // ==========================================================================

  /**
   * 查询执行记录
   */
  query(queryParams: ExecutionQuery): ExecutionRecord[] {
    let results = Array.from(this.records.values());

    // 按工作流过滤
    if (queryParams.workflowId) {
      const ids = this.recordsByWorkflow.get(queryParams.workflowId);
      if (ids) {
        results = results.filter(r => ids.has(r.id));
      } else {
        results = [];
      }
    }

    // 按节点过滤
    if (queryParams.nodeId) {
      const ids = this.recordsByNode.get(queryParams.nodeId);
      if (ids) {
        results = results.filter(r => ids.has(r.id));
      } else {
        results = [];
      }
    }

    // 按状态过滤
    if (queryParams.status) {
      results = results.filter(r => r.status === queryParams.status);
    }

    // 按时间过滤
    if (queryParams.fromTime) {
      results = results.filter(r => {
        const start = r.startedAt ?? r.startTime ?? 0;
        return start >= queryParams.fromTime!;
      });
    }
    if (queryParams.toTime) {
      results = results.filter(r => {
        const start = r.startedAt ?? r.startTime ?? 0;
        return start <= queryParams.toTime!;
      });
    }

    // 按时间排序（最新优先）
    results.sort((a, b) => {
      const aStart = a.startedAt ?? a.startTime ?? 0;
      const bStart = b.startedAt ?? b.startTime ?? 0;
      return bStart - aStart;
    });

    // 分页
    if (queryParams.offset) {
      results = results.slice(queryParams.offset);
    }
    if (queryParams.limit) {
      results = results.slice(0, queryParams.limit);
    }

    return results;
  }

  /**
   * 获取节点的执行记录
   */
  getByNode(nodeId: string, limit?: number): ExecutionRecord[] {
    return this.query({ nodeId, limit: limit ?? 100 });
  }

  /**
   * 获取工作流的执行记录
   */
  getByWorkflow(workflowId: string, limit?: number): ExecutionRecord[] {
    return this.query({ workflowId, limit: limit ?? 100 });
  }

  /**
   * 获取最新执行记录
   */
  getLatest(limit: number = 100): ExecutionRecord[] {
    return this.query({ limit });
  }

  /**
   * 获取正在执行的记录
   */
  getRunning(): ExecutionRecord[] {
    return this.query({ status: 'RUNNING' });
  }

  /**
   * 获取失败的记录
   */
  getFailed(limit: number = 100): ExecutionRecord[] {
    return this.query({ status: 'FAILED', limit });
  }

  // ==========================================================================
  // 统计
  // ==========================================================================

  /**
   * 获取统计信息
   */
  getStats(workflowId?: string): ExecutionStats {
    const records = workflowId
      ? this.getByWorkflow(workflowId)
      : Array.from(this.records.values());

    let successCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let totalTokens = 0;

    records.forEach(r => {
      switch (r.status) {
        case 'SUCCESS': successCount++; break;
        case 'FAILED':
        case 'TIMEOUT':
        case 'CANCELLED': failedCount++; break;
        case 'RUNNING': runningCount++; break;
      }

      if (r.durationMs) {
        totalDuration += r.durationMs;
        durationCount++;
      }

      if (r.tokenUsage) {
        totalTokens += r.tokenUsage.totalTokens;
      }
    });

    return {
      totalRecords: records.length,
      successCount,
      failedCount,
      runningCount,
      avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      totalTokens,
    };
  }

  /**
   * 获取节点的执行统计
   */
  getNodeStats(nodeId: string): ExecutionStats {
    const records = this.getByNode(nodeId);
    if (records.length === 0) {
      return {
        totalRecords: 0,
        successCount: 0,
        failedCount: 0,
        runningCount: 0,
        avgDurationMs: 0,
        totalTokens: 0,
      };
    }

    let successCount = 0;
    let failedCount = 0;
    let runningCount = 0;
    let totalDuration = 0;
    let durationCount = 0;
    let totalTokens = 0;

    records.forEach(r => {
      switch (r.status) {
        case 'SUCCESS': successCount++; break;
        case 'FAILED':
        case 'TIMEOUT':
        case 'CANCELLED': failedCount++; break;
        case 'RUNNING': runningCount++; break;
      }

      if (r.durationMs) {
        totalDuration += r.durationMs;
        durationCount++;
      }

      if (r.tokenUsage) {
        totalTokens += r.tokenUsage.totalTokens;
      }
    });

    return {
      totalRecords: records.length,
      successCount,
      failedCount,
      runningCount,
      avgDurationMs: durationCount > 0 ? Math.round(totalDuration / durationCount) : 0,
      totalTokens,
    };
  }

  // ==========================================================================
  // 清理
  // ==========================================================================

  /**
   * 清理过期记录
   */
  cleanupExpired(): number {
    const now = Date.now();
    const cutoff = now - this.config.retentionMs;
    let removed = 0;

    this.records.forEach((record, id) => {
      const start = record.startedAt ?? record.startTime ?? 0;
      if (start < cutoff && isExecutionTerminal(record.status)) {
        this.delete(id);
        removed++;
      }
    });

    if (removed > 0) {
      this.log(`Cleaned up ${removed} expired records`);
    }

    return removed;
  }

  /**
   * 清理超出限制的记录
   */
  cleanupOverflow(): number {
    if (this.records.size <= this.config.maxRecords) {
      return 0;
    }

    // 按时间排序，移除最旧的
    const sorted = Array.from(this.records.values())
      .filter(r => isExecutionTerminal(r.status))
      .sort((a, b) => {
        const aStart = a.startedAt ?? a.startTime ?? 0;
        const bStart = b.startedAt ?? b.startTime ?? 0;
        return aStart - bStart;
      });

    const toRemove = this.records.size - this.config.maxRecords;
    let removed = 0;

    for (let i = 0; i < Math.min(toRemove, sorted.length); i++) {
      if (this.delete(sorted[i].id)) {
        removed++;
      }
    }

    if (removed > 0) {
      this.log(`Cleaned up ${removed} overflow records`);
    }

    return removed;
  }

  /**
   * 清空所有记录
   */
  clear(): void {
    this.records.clear();
    this.recordsByWorkflow.clear();
    this.recordsByNode.clear();
    this.log('Cleared all records');
  }

  /**
   * 销毁存储
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.clear();
  }

  // ==========================================================================
  // 导出
  // ==========================================================================

  /**
   * 导出所有记录
   */
  export(): ExecutionRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * 导入记录
   */
  import(records: ExecutionRecord[]): number {
    let imported = 0;
    records.forEach(record => {
      if (!this.records.has(record.id)) {
        this.addRecord(record);
        imported++;
      }
    });
    this.log(`Imported ${imported} records`);
    return imported;
  }

  // ==========================================================================
  // 内部方法
  // ==========================================================================

  private addRecord(record: ExecutionRecord): void {
    this.records.set(record.id, record);

    // 更新工作流索引
    if (!this.recordsByWorkflow.has(record.workflowId)) {
      this.recordsByWorkflow.set(record.workflowId, new Set());
    }
    this.recordsByWorkflow.get(record.workflowId)!.add(record.id);

    // 更新节点索引
    if (!this.recordsByNode.has(record.nodeId)) {
      this.recordsByNode.set(record.nodeId, new Set());
    }
    this.recordsByNode.get(record.nodeId)!.add(record.id);

    // 检查是否需要清理
    this.cleanupOverflow();
  }

  private startAutoCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, this.config.cleanupInterval);
  }

  private log(message: string): void {
    if (this.config.enableLog) {
      console.log(`[ExecutionStore] ${message}`);
    }
  }
}

// ============================================================================
// 全局实例
// ============================================================================

let globalStore: ExecutionStore | null = null;

/**
 * 获取全局 ExecutionStore 实例
 */
export function getExecutionStore(config?: ExecutionStoreConfig): ExecutionStore {
  if (!globalStore) {
    globalStore = new ExecutionStore(config);
  }
  return globalStore;
}

/**
 * 重置全局 ExecutionStore（用于测试）
 */
export function resetExecutionStore(): void {
  if (globalStore) {
    globalStore.destroy();
    globalStore = null;
  }
}
