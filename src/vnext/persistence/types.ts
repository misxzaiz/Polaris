/**
 * Workflow Persistence Types
 * 工作流持久化
 */

import type { Workflow, WorkflowNode } from '../types';

/**
 * 持久化存储类型
 */
export enum StorageType {
  /** 内存存储 */
  MEMORY = 'memory',
  /** 文件系统存储 */
  FILE = 'file',
  /** IndexedDB 存储 */
  INDEXED_DB = 'indexeddb',
  /** 自定义存储 */
  CUSTOM = 'custom',
}

/**
 * 持久化快照
 */
export interface PersistenceSnapshot {
  /** 快照 ID */
  id: string;
  /** 工作流 ID */
  workflowId: string;
  /** 快照时间 */
  timestamp: number;
  /** 快照类型 */
  type: SnapshotType;
  /** 工作流数据 */
  workflow: Workflow;
  /** 节点数据 */
  nodes: WorkflowNode[];
  /** 元数据 */
  metadata?: SnapshotMetadata;
  /** 校验和 */
  checksum?: string;
}

/**
 * 快照类型
 */
export enum SnapshotType {
  /** 手动创建 */
  MANUAL = 'manual',
  /** 自动保存点 */
  AUTO = 'auto',
  /** 执行前 */
  BEFORE_EXECUTION = 'before_execution',
  /** 执行后 */
  AFTER_EXECUTION = 'after_execution',
  /** 错误恢复点 */
  ERROR_RECOVERY = 'error_recovery',
  /** 里程碑 */
  MILESTONE = 'milestone',
}

/**
 * 快照元数据
 */
export interface SnapshotMetadata {
  /** 描述 */
  description?: string;
  /** 触发者 */
  triggeredBy?: string;
  /** 标签 */
  tags?: string[];
  /** 当前轮次 */
  round?: number;
  /** 当前节点 ID */
  currentNodeId?: string;
  /** 额外数据 */
  extra?: Record<string, unknown>;
}

/**
 * 持久化配置
 */
export interface PersistenceConfig {
  /** 存储类型 */
  storageType: StorageType;
  /** 自动保存间隔 (毫秒), 0 表示禁用 */
  autoSaveIntervalMs: number;
  /** 最大快照数量 */
  maxSnapshots: number;
  /** 快照保留时间 (毫秒) */
  snapshotRetentionMs: number;
  /** 是否保存执行历史 */
  saveExecutionHistory: boolean;
  /** 文件存储路径 (仅 FILE 类型) */
  filePath?: string;
  /** 是否启用压缩 */
  enableCompression: boolean;
  /** 是否验证校验和 */
  verifyChecksum: boolean;
}

/**
 * 持久化状态
 */
export interface PersistenceState {
  /** 工作流 ID */
  workflowId: string;
  /** 最后保存时间 */
  lastSavedAt?: number;
  /** 最后加载时间 */
  lastLoadedAt?: number;
  /** 是否有未保存的更改 */
  hasUnsavedChanges: boolean;
  /** 快照数量 */
  snapshotCount: number;
  /** 总大小 (字节) */
  totalSize: number;
  /** 错误信息 */
  lastError?: string;
}

/**
 * 持久化事件
 */
export interface PersistenceEvent {
  /** 事件类型 */
  type: 'saved' | 'loaded' | 'snapshot_created' | 'snapshot_restored' | 'error' | 'cleanup';
  /** 工作流 ID */
  workflowId: string;
  /** 时间戳 */
  timestamp: number;
  /** 相关数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
}

/**
 * 持久化监听器
 */
export type PersistenceListener = (event: PersistenceEvent) => void;

/**
 * 存储接口
 */
export interface IStorage {
  /** 保存数据 */
  save(key: string, data: unknown): Promise<void>;
  /** 加载数据 */
  load<T>(key: string): Promise<T | null>;
  /** 删除数据 */
  delete(key: string): Promise<void>;
  /** 检查是否存在 */
  exists(key: string): Promise<boolean>;
  /** 列出所有键 */
  listKeys(prefix?: string): Promise<string[]>;
  /** 清空所有数据 */
  clear(): Promise<void>;
}

/**
 * 导出格式
 */
export interface ExportFormat {
  /** 版本 */
  version: string;
  /** 导出时间 */
  exportedAt: number;
  /** 工作流列表 */
  workflows: Array<{
    workflow: Workflow;
    nodes: WorkflowNode[];
    snapshots: PersistenceSnapshot[];
  }>;
  /** 导出选项 */
  options?: {
    includeSnapshots?: boolean;
    includeExecutionHistory?: boolean;
    compress?: boolean;
  };
}

/**
 * 默认持久化配置
 */
export const DEFAULT_PERSISTENCE_CONFIG: PersistenceConfig = {
  storageType: StorageType.MEMORY,
  autoSaveIntervalMs: 60000, // 1 minute
  maxSnapshots: 50,
  snapshotRetentionMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  saveExecutionHistory: true,
  enableCompression: false,
  verifyChecksum: true,
};

/**
 * 创建快照
 */
export function createSnapshot(
  workflow: Workflow,
  nodes: WorkflowNode[],
  type: SnapshotType,
  metadata?: SnapshotMetadata
): PersistenceSnapshot {
  const timestamp = Date.now();
  return {
    id: `snapshot-${workflow.id}-${timestamp}-${Math.random().toString(36).substr(2, 9)}`,
    workflowId: workflow.id,
    timestamp,
    type,
    workflow: JSON.parse(JSON.stringify(workflow)),
    nodes: JSON.parse(JSON.stringify(nodes)),
    metadata,
  };
}

/**
 * 计算校验和
 */
export function calculateChecksum(data: unknown): string {
  const str = JSON.stringify(data);
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * 验证快照
 */
export function verifySnapshot(snapshot: PersistenceSnapshot): boolean {
  if (!snapshot.checksum) return true;

  const dataToVerify = {
    workflow: snapshot.workflow,
    nodes: snapshot.nodes,
    metadata: snapshot.metadata,
  };

  return calculateChecksum(dataToVerify) === snapshot.checksum;
}
