/**
 * Scheduler vNext - Execution Record Store
 *
 * 执行记录存储系统，管理执行历史
 */

// ============================================================================
// 类型定义（与 types/index.ts 保持一致）
// ============================================================================

/**
 * 执行状态
 */
export type ExecutionStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCESS'
  | 'FAILED'
  | 'TIMEOUT'
  | 'CANCELLED';

/**
 * Token 使用量
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * 工具调用记录
 */
export interface ToolCallRecord {
  tool: string;
  input: string;
  timestamp: number;
  success: boolean;
  resultSnippet?: string;
  error?: string;
}

/**
 * 执行记录
 */
export interface ExecutionRecord {
  id: string;
  nodeId: string;
  workflowId: string;
  round: number;
  status: ExecutionStatus;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  sessionId?: string;
  engineId?: string;
  summaryPath?: string;
  outputSummary?: string;
  error?: string;
  tokenCount?: number;
  toolCallCount?: number;
  tokenUsage?: TokenUsage;
  toolCalls: ToolCallRecord[];
  score?: number;
}

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

function calculateDuration(record: ExecutionRecord): number {
  if (!record.endTime || !record.startTime) return 0;
  return record.endTime - record.startTime;
}

function isExecutionTerminal(status: ExecutionStatus): boolean {
  return status !== 'PENDING' && status !== 'RUNNING';
}

// ============================================================================
// 存储配置
// ============================================================================

/**
 * 执行记录存储配置
 */
export interface ExecutionStoreConfig {
  /** 最大记录数量 */
  maxRecords?: number;

  /** 记录保留时间（毫秒） */
  retentionMs?: number;

  /** 是否自动清理 */
  autoCleanup?: boolean;

  /** 清理间隔（毫秒） */
  cleanupInterval?: number;

  /** 是否启用日志 */
  enableLog?: boolean;
}

/**
 * 执行记录统计
 */
export interface ExecutionStats {
  /** 总记录数 */
  totalRecords: number;

  /** 成功数 */
  successCount: number;

  /** 失败数 */
  failedCount: number;

  /** 运行中数 */
  runningCount: number;

  /** 平均执行时间 */
  avgDurationMs: number;

  /** 总 Token 消耗 */
  totalTokens: number;
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
  create(params: {
    nodeId: string;
    workflowId: string;
    round: number;
    sessionId?: string;
    engineId?: string;
  }): ExecutionRecord {
    const id = generateExecutionId();
    const record: ExecutionRecord = {
      id,
      nodeId: params.nodeId,
      workflowId: params.workflowId,
      round: params.round,
      status: 'PENDING',
      startTime: Date.now(),
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
    if (record.endTime && record.startTime) {
      record.durationMs = calculateDuration(record);
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
    return this.update(id, {
      status: 'RUNNING',
      startTime: Date.now(),
    });
  }

  /**
   * 标记执行成功
   */
  completeExecution(
    id: string,
    result: {
      outputSummary?: string;
      summaryPath?: string;
      tokenUsage?: TokenUsage;
      score?: number;
    } = {}
  ): ExecutionRecord | undefined {
    const endTime = Date.now();
    return this.update(id, {
      status: 'SUCCESS',
      endTime,
      ...result,
    });
  }

  /**
   * 标记执行失败
   */
  failExecution(id: string, error: string): ExecutionRecord | undefined {
    return this.update(id, {
      status: 'FAILED',
      endTime: Date.now(),
      error,
    });
  }

  /**
   * 标记执行超时
   */
  timeoutExecution(id: string): ExecutionRecord | undefined {
    return this.update(id, {
      status: 'TIMEOUT',
      endTime: Date.now(),
      error: 'Execution timed out',
    });
  }

  /**
   * 标记执行取消
   */
  cancelExecution(id: string, reason?: string): ExecutionRecord | undefined {
    return this.update(id, {
      status: 'CANCELLED',
      endTime: Date.now(),
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
    toolCall: Omit<ToolCallRecord, 'timestamp'>
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
  query(query: ExecutionQuery): ExecutionRecord[] {
    let results = Array.from(this.records.values());

    // 按工作流过滤
    if (query.workflowId) {
      const ids = this.recordsByWorkflow.get(query.workflowId);
      if (ids) {
        results = results.filter(r => ids.has(r.id));
      } else {
        results = [];
      }
    }

    // 按节点过滤
    if (query.nodeId) {
      const ids = this.recordsByNode.get(query.nodeId);
      if (ids) {
        results = results.filter(r => ids.has(r.id));
      } else {
        results = [];
      }
    }

    // 按状态过滤
    if (query.status) {
      results = results.filter(r => r.status === query.status);
    }

    // 按时间过滤
    if (query.fromTime) {
      results = results.filter(r => r.startTime >= query.fromTime!);
    }
    if (query.toTime) {
      results = results.filter(r => r.startTime <= query.toTime!);
    }

    // 按时间排序（最新优先）
    results.sort((a, b) => b.startTime - a.startTime);

    // 分页
    if (query.offset) {
      results = results.slice(query.offset);
    }
    if (query.limit) {
      results = results.slice(0, query.limit);
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
      if (record.startTime < cutoff && isExecutionTerminal(record.status)) {
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
      .sort((a, b) => a.startTime - b.startTime);

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
