/**
 * Workflow Persistence
 * 工作流持久化
 *
 * 功能:
 * - 工作流快照管理
 * - 自动保存
 * - 恢复和回滚
 * - 导入导出
 * - 多存储后端支持
 */

import type { Workflow, WorkflowNode } from '../types';
import {
  PersistenceSnapshot,
  PersistenceConfig,
  PersistenceState,
  PersistenceEvent,
  PersistenceListener,
  SnapshotType,
  IStorage,
  DEFAULT_PERSISTENCE_CONFIG,
  createSnapshot,
  calculateChecksum,
  verifySnapshot,
  ExportFormat,
  type SnapshotMetadata,
} from './types';

/**
 * 内存存储实现
 */
export class MemoryStorage implements IStorage {
  private readonly store: Map<string, unknown> = new Map();

  async save(key: string, data: unknown): Promise<void> {
    this.store.set(key, data);
  }

  async load<T>(key: string): Promise<T | null> {
    return (this.store.get(key) as T) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const keys = Array.from(this.store.keys());
    if (!prefix) return keys;
    return keys.filter((k) => k.startsWith(prefix));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }
}

/**
 * WorkflowPersistence 工作流持久化管理器
 */
export class WorkflowPersistence {
  private readonly config: PersistenceConfig;
  private readonly storage: IStorage;
  private readonly snapshots: Map<string, PersistenceSnapshot[]> = new Map();
  private readonly states: Map<string, PersistenceState> = new Map();
  private readonly listeners: Set<PersistenceListener> = new Set();
  private autoSaveTimer?: ReturnType<typeof setInterval>;
  private readonly workflows: Map<string, { workflow: Workflow; nodes: Map<string, WorkflowNode> }> = new Map();

  constructor(config?: Partial<PersistenceConfig>, storage?: IStorage) {
    this.config = { ...DEFAULT_PERSISTENCE_CONFIG, ...config };
    this.storage = storage ?? new MemoryStorage();

    if (this.config.autoSaveIntervalMs > 0) {
      this.startAutoSave();
    }
  }

  // ==================== 工作流管理 ====================

  /**
   * 注册工作流
   */
  registerWorkflow(workflow: Workflow, nodes: WorkflowNode[]): void {
    const nodeMap = new Map<string, WorkflowNode>();
    for (const node of nodes) {
      nodeMap.set(node.id, node);
    }

    this.workflows.set(workflow.id, { workflow, nodes: nodeMap });
    this.states.set(workflow.id, {
      workflowId: workflow.id,
      hasUnsavedChanges: false,
      snapshotCount: 0,
      totalSize: 0,
    });
  }

  /**
   * 更新工作流
   */
  updateWorkflow(workflow: Workflow): void {
    const existing = this.workflows.get(workflow.id);
    if (existing) {
      existing.workflow = workflow;
      this.markUnsaved(workflow.id);
    }
  }

  /**
   * 更新节点
   */
  updateNode(workflowId: string, node: WorkflowNode): void {
    const existing = this.workflows.get(workflowId);
    if (existing) {
      existing.nodes.set(node.id, node);
      this.markUnsaved(workflowId);
    }
  }

  /**
   * 获取工作流
   */
  getWorkflow(workflowId: string): Workflow | undefined {
    return this.workflows.get(workflowId)?.workflow;
  }

  /**
   * 获取节点
   */
  getNode(workflowId: string, nodeId: string): WorkflowNode | undefined {
    return this.workflows.get(workflowId)?.nodes.get(nodeId);
  }

  /**
   * 获取所有节点
   */
  getNodes(workflowId: string): WorkflowNode[] {
    const nodeMap = this.workflows.get(workflowId)?.nodes;
    return nodeMap ? Array.from(nodeMap.values()) : [];
  }

  /**
   * 移除工作流
   */
  removeWorkflow(workflowId: string): void {
    this.workflows.delete(workflowId);
    this.snapshots.delete(workflowId);
    this.states.delete(workflowId);
  }

  // ==================== 快照管理 ====================

  /**
   * 创建快照
   */
  createSnapshot(
    workflowId: string,
    type: SnapshotType,
    metadata?: SnapshotMetadata
  ): PersistenceSnapshot | undefined {
    const data = this.workflows.get(workflowId);
    if (!data) return undefined;

    const nodes = Array.from(data.nodes.values());
    const snapshot = createSnapshot(data.workflow, nodes, type, metadata);

    // 计算校验和
    if (this.config.verifyChecksum) {
      snapshot.checksum = calculateChecksum({
        workflow: snapshot.workflow,
        nodes: snapshot.nodes,
        metadata: snapshot.metadata,
      });
    }

    // 存储快照
    let workflowSnapshots = this.snapshots.get(workflowId);
    if (!workflowSnapshots) {
      workflowSnapshots = [];
      this.snapshots.set(workflowId, workflowSnapshots);
    }

    workflowSnapshots.push(snapshot);

    // 限制快照数量
    this.enforceMaxSnapshots(workflowId);

    // 更新状态
    const state = this.states.get(workflowId);
    if (state) {
      state.snapshotCount = workflowSnapshots.length;
      state.totalSize += JSON.stringify(snapshot).length;
    }

    this.emitEvent({
      type: 'snapshot_created',
      workflowId,
      timestamp: Date.now(),
      data: snapshot,
    });

    return snapshot;
  }

  /**
   * 获取快照
   */
  getSnapshot(workflowId: string, snapshotId: string): PersistenceSnapshot | undefined {
    const snapshots = this.snapshots.get(workflowId);
    return snapshots?.find((s) => s.id === snapshotId);
  }

  /**
   * 获取所有快照
   */
  getSnapshots(workflowId: string, type?: SnapshotType): PersistenceSnapshot[] {
    const snapshots = this.snapshots.get(workflowId) ?? [];
    if (!type) return [...snapshots];
    return snapshots.filter((s) => s.type === type);
  }

  /**
   * 恢复快照
   */
  restoreSnapshot(workflowId: string, snapshotId: string): boolean {
    const snapshot = this.getSnapshot(workflowId, snapshotId);
    if (!snapshot) return false;

    // 验证快照
    if (this.config.verifyChecksum && !verifySnapshot(snapshot)) {
      this.emitEvent({
        type: 'error',
        workflowId,
        timestamp: Date.now(),
        error: 'Snapshot checksum verification failed',
      });
      return false;
    }

    // 恢复数据
    const nodeMap = new Map<string, WorkflowNode>();
    for (const node of snapshot.nodes) {
      nodeMap.set(node.id, node);
    }

    this.workflows.set(workflowId, {
      workflow: snapshot.workflow,
      nodes: nodeMap,
    });

    this.markUnsaved(workflowId);

    this.emitEvent({
      type: 'snapshot_restored',
      workflowId,
      timestamp: Date.now(),
      data: snapshot,
    });

    return true;
  }

  /**
   * 删除快照
   */
  deleteSnapshot(workflowId: string, snapshotId: string): boolean {
    const snapshots = this.snapshots.get(workflowId);
    if (!snapshots) return false;

    const index = snapshots.findIndex((s) => s.id === snapshotId);
    if (index === -1) return false;

    const removed = snapshots.splice(index, 1)[0];

    // 更新状态
    const state = this.states.get(workflowId);
    if (state) {
      state.snapshotCount = snapshots.length;
      state.totalSize -= JSON.stringify(removed).length;
    }

    return true;
  }

  /**
   * 获取最新快照
   */
  getLatestSnapshot(workflowId: string): PersistenceSnapshot | undefined {
    const snapshots = this.snapshots.get(workflowId);
    if (!snapshots || snapshots.length === 0) return undefined;
    return snapshots[snapshots.length - 1];
  }

  // ==================== 保存和加载 ====================

  /**
   * 保存工作流
   */
  async save(workflowId: string): Promise<boolean> {
    const data = this.workflows.get(workflowId);
    if (!data) return false;

    try {
      const saveData = {
        workflow: data.workflow,
        nodes: Array.from(data.nodes.values()),
        savedAt: Date.now(),
      };

      await this.storage.save(`workflow:${workflowId}`, saveData);

      const state = this.states.get(workflowId);
      if (state) {
        state.lastSavedAt = Date.now();
        state.hasUnsavedChanges = false;
      }

      this.emitEvent({
        type: 'saved',
        workflowId,
        timestamp: Date.now(),
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const state = this.states.get(workflowId);
      if (state) {
        state.lastError = errorMessage;
      }

      this.emitEvent({
        type: 'error',
        workflowId,
        timestamp: Date.now(),
        error: errorMessage,
      });

      return false;
    }
  }

  /**
   * 加载工作流
   */
  async load(workflowId: string): Promise<{ workflow: Workflow; nodes: WorkflowNode[] } | null> {
    try {
      const data = await this.storage.load<{
        workflow: Workflow;
        nodes: WorkflowNode[];
        savedAt: number;
      }>(`workflow:${workflowId}`);

      if (!data) return null;

      // 注册到内存
      this.registerWorkflow(data.workflow, data.nodes);

      const state = this.states.get(workflowId);
      if (state) {
        state.lastLoadedAt = Date.now();
        state.hasUnsavedChanges = false;
      }

      this.emitEvent({
        type: 'loaded',
        workflowId,
        timestamp: Date.now(),
        data: { savedAt: data.savedAt },
      });

      return {
        workflow: data.workflow,
        nodes: data.nodes,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.emitEvent({
        type: 'error',
        workflowId,
        timestamp: Date.now(),
        error: errorMessage,
      });

      return null;
    }
  }

  /**
   * 保存所有
   */
  async saveAll(): Promise<{ success: number; failed: number }> {
    let success = 0;
    let failed = 0;

    for (const workflowId of this.workflows.keys()) {
      const result = await this.save(workflowId);
      if (result) {
        success++;
      } else {
        failed++;
      }
    }

    return { success, failed };
  }

  /**
   * 检查是否有未保存的更改
   */
  hasUnsavedChanges(workflowId: string): boolean {
    return this.states.get(workflowId)?.hasUnsavedChanges ?? false;
  }

  // ==================== 导入导出 ====================

  /**
   * 导出工作流
   */
  async exportWorkflows(workflowIds: string[]): Promise<ExportFormat> {
    const workflows: ExportFormat['workflows'] = [];

    for (const workflowId of workflowIds) {
      const data = this.workflows.get(workflowId);
      if (!data) continue;

      workflows.push({
        workflow: data.workflow,
        nodes: Array.from(data.nodes.values()),
        snapshots: this.snapshots.get(workflowId) ?? [],
      });
    }

    return {
      version: '1.0.0',
      exportedAt: Date.now(),
      workflows,
    };
  }

  /**
   * 导入工作流
   */
  async importWorkflows(exportData: ExportFormat): Promise<{ imported: number; errors: string[] }> {
    const errors: string[] = [];
    let imported = 0;

    for (const item of exportData.workflows) {
      try {
        // 验证数据
        if (!item.workflow.id || !item.workflow.name) {
          errors.push(`Invalid workflow data: missing id or name`);
          continue;
        }

        // 注册工作流
        this.registerWorkflow(item.workflow, item.nodes);

        // 恢复快照
        if (item.snapshots && item.snapshots.length > 0) {
          this.snapshots.set(item.workflow.id, item.snapshots);
        }

        // 立即保存
        await this.save(item.workflow.id);

        imported++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        errors.push(`Failed to import workflow ${item.workflow?.id ?? 'unknown'}: ${errorMessage}`);
      }
    }

    return { imported, errors };
  }

  /**
   * 导出为 JSON 字符串
   */
  async exportToJson(workflowIds: string[]): Promise<string> {
    const exportData = await this.exportWorkflows(workflowIds);
    return JSON.stringify(exportData, null, 2);
  }

  /**
   * 从 JSON 字符串导入
   */
  async importFromJson(json: string): Promise<{ imported: number; errors: string[] }> {
    try {
      const exportData = JSON.parse(json) as ExportFormat;
      return this.importWorkflows(exportData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return { imported: 0, errors: [`Failed to parse JSON: ${errorMessage}`] };
    }
  }

  // ==================== 状态查询 ====================

  /**
   * 获取持久化状态
   */
  getState(workflowId: string): PersistenceState | undefined {
    return this.states.get(workflowId);
  }

  /**
   * 获取所有工作流 ID
   */
  getWorkflowIds(): string[] {
    return Array.from(this.workflows.keys());
  }

  // ==================== 清理和管理 ====================

  /**
   * 清理过期快照
   */
  cleanupExpiredSnapshots(): number {
    const cutoff = Date.now() - this.config.snapshotRetentionMs;
    let totalRemoved = 0;

    for (const [workflowId, snapshots] of this.snapshots.entries()) {
      const _before = snapshots.length;

      // 保留至少一个快照
      const toKeep: PersistenceSnapshot[] = [];
      const toRemove: PersistenceSnapshot[] = [];

      for (const snapshot of snapshots) {
        if (snapshot.timestamp >= cutoff || toKeep.length === 0) {
          toKeep.push(snapshot);
        } else {
          toRemove.push(snapshot);
        }
      }

      // 更新快照列表
      this.snapshots.set(workflowId, toKeep);
      totalRemoved += toRemove.length;

      // 更新状态
      const state = this.states.get(workflowId);
      if (state) {
        state.snapshotCount = toKeep.length;
        for (const removed of toRemove) {
          state.totalSize -= JSON.stringify(removed).length;
        }
      }
    }

    if (totalRemoved > 0) {
      this.emitEvent({
        type: 'cleanup',
        workflowId: 'all',
        timestamp: Date.now(),
        data: { removedSnapshots: totalRemoved },
      });
    }

    return totalRemoved;
  }

  /**
   * 强制保存所有并停止
   */
  async flush(): Promise<void> {
    await this.saveAll();
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = undefined;
    }
    this.workflows.clear();
    this.snapshots.clear();
    this.states.clear();
    this.listeners.clear();
  }

  // ==================== 事件监听 ====================

  /**
   * 添加监听器
   */
  addListener(listener: PersistenceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 移除监听器
   */
  removeListener(listener: PersistenceListener): void {
    this.listeners.delete(listener);
  }

  // ==================== 私有方法 ====================

  private markUnsaved(workflowId: string): void {
    const state = this.states.get(workflowId);
    if (state) {
      state.hasUnsavedChanges = true;
    }
  }

  private enforceMaxSnapshots(workflowId: string): void {
    const snapshots = this.snapshots.get(workflowId);
    if (!snapshots || snapshots.length <= this.config.maxSnapshots) return;

    // 按时间排序，保留最新的
    snapshots.sort((a, b) => b.timestamp - a.timestamp);

    // 保留关键快照（手动创建、错误恢复点）
    const critical = snapshots.filter(
      (s) => s.type === SnapshotType.MANUAL || s.type === SnapshotType.ERROR_RECOVERY
    );

    const regular = snapshots.filter(
      (s) => s.type !== SnapshotType.MANUAL && s.type !== SnapshotType.ERROR_RECOVERY
    );

    // 保留最新的快照，直到达到限制
    const toKeep = [...critical];
    for (const snapshot of regular) {
      if (toKeep.length >= this.config.maxSnapshots) break;
      toKeep.push(snapshot);
    }

    this.snapshots.set(workflowId, toKeep);

    // 更新状态
    const state = this.states.get(workflowId);
    if (state) {
      state.snapshotCount = toKeep.length;
    }
  }

  private emitEvent(event: PersistenceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('WorkflowPersistence listener error:', error);
      }
    }
  }

  private startAutoSave(): void {
    this.autoSaveTimer = setInterval(() => {
      for (const [workflowId, state] of this.states.entries()) {
        if (state.hasUnsavedChanges) {
          this.save(workflowId).catch((error) => {
            console.error(`Auto-save failed for workflow ${workflowId}:`, error);
          });
        }
      }
    }, this.config.autoSaveIntervalMs);
  }
}

// 全局实例
let globalPersistence: WorkflowPersistence | undefined;

/**
 * 获取全局 WorkflowPersistence 实例
 */
export function getWorkflowPersistence(
  config?: Partial<PersistenceConfig>,
  storage?: IStorage
): WorkflowPersistence {
  if (!globalPersistence) {
    globalPersistence = new WorkflowPersistence(config, storage);
  }
  return globalPersistence;
}

/**
 * 重置全局实例
 */
export function resetWorkflowPersistence(): void {
  if (globalPersistence) {
    globalPersistence.destroy();
    globalPersistence = undefined;
  }
}

export * from './types';
