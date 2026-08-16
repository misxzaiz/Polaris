/**
 * 供应商调用统计 Store
 *
 * 管理供应商分组路由的聚合统计和失败调用日志。
 * 数据源：后端 `provider_stats` / `provider_failed_calls` 命令（持久化计数器）。
 *
 * 与 routeLogStore 互补：routeLogStore 是 200 条实时事件流（自动轮询），
 * 本 store 是持久化全量计数（手动刷新）。
 */

import { create } from 'zustand';
import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('ProviderStatsStore');

// ============================================================================
// 类型定义（与后端对齐）
// ============================================================================

export interface KeyStats {
  keyIdx: number | null;
  selected: number;
  failed: number;
  lastActiveMs: number;
}

export interface ProfileStats {
  profileId: string;
  profileName: string;
  groupId: string;
  groupName: string;
  selected: number;
  failoverIn: number;
  failoverOut: number;
  spawnFailed: number;
  applyFailed: number;
  bound: number;
  keyBreakdown: Record<string, KeyStats>;
  lastActiveMs: number;
}

export interface GroupStats {
  groupId: string;
  groupName: string;
  strategy: string;
  totalRoutes: number;
  failoverCount: number;
  allUnavailable: number;
  officialFallback: number;
}

export interface ProviderStatsSnapshot {
  profiles: ProfileStats[];
  groups: GroupStats[];
  updatedAt: number;
  totalRoutes: number;
  totalFailures: number;
  totalFailovers: number;
}

export type FailedCallKind = 'spawnFailed' | 'applyFailed' | 'allUnavailable' | 'officialFallback';

export interface FailedCallLog {
  seq: number;
  tsMs: number;
  groupId: string;
  groupName: string;
  profileId: string | null;
  profileName: string | null;
  keyIdx: number | null;
  sessionId: string | null;
  engine: string | null;
  errorKind: FailedCallKind;
  errorMessage: string;
  tried: string[];
  failoverTo: string | null;
  attempt: number;
}

export interface FailedCallFilter {
  profileId?: string | null;
  errorKind?: FailedCallKind | null;
  groupId?: string | null;
  sinceMs?: number | null;
  untilMs?: number | null;
  keyword?: string | null;
  offset: number;
  limit: number;
}

// ============================================================================
// Store
// ============================================================================

interface ProviderStatsState {
  /** 统计快照 */
  snapshot: ProviderStatsSnapshot | null;
  /** 失败日志列表 */
  failedLogs: FailedCallLog[];
  /** 失败日志筛选 */
  failedFilter: FailedCallFilter;
  /** 失败日志总数 */
  failedTotal: number;
  /** 加载中 */
  loading: boolean;
  /** 错误消息 */
  error: string | null;

  /** 全量拉取统计 */
  fetchStats: () => Promise<void>;
  /** 拉取失败日志 */
  fetchFailedLogs: (filter?: Partial<FailedCallFilter>) => Promise<void>;
  /** 清空统计 */
  clearStats: () => Promise<void>;
  /** 清空失败日志 */
  clearFailedLogs: () => Promise<void>;
  /** 更新筛选参数 */
  setFailedFilter: (filter: Partial<FailedCallFilter>) => void;
}

export const useProviderStatsStore = create<ProviderStatsState>((set, get) => ({
  snapshot: null,
  failedLogs: [],
  failedFilter: { offset: 0, limit: 20 },
  failedTotal: 0,
  loading: false,
  error: null,

  fetchStats: async () => {
    set({ loading: true, error: null });
    try {
      const snapshot = await invoke<ProviderStatsSnapshot>('provider_stats');
      set({ snapshot, loading: false });
    } catch (e) {
      log.warn('拉取统计失败', { error: String(e) });
      set({ error: String(e), loading: false });
    }
  },

  fetchFailedLogs: async (filterOverrides?: Partial<FailedCallFilter>) => {
    const filter = { ...get().failedFilter, ...filterOverrides };
    set({ loading: true, error: null });
    try {
      const logs = await invoke<FailedCallLog[]>('provider_failed_calls', { filter });
      set({ failedLogs: logs, failedFilter: filter, loading: false });
    } catch (e) {
      log.warn('拉取失败日志失败', { error: String(e) });
      set({ error: String(e), loading: false });
    }
  },

  clearStats: async () => {
    try {
      await invoke('provider_stats_clear');
      set({ snapshot: null });
    } catch (e) {
      log.warn('清空统计失败', { error: String(e) });
    }
  },

  clearFailedLogs: async () => {
    try {
      await invoke('provider_failed_calls_clear');
      set({ failedLogs: [], failedTotal: 0 });
    } catch (e) {
      log.warn('清空失败日志失败', { error: String(e) });
    }
  },

  setFailedFilter: (filter: Partial<FailedCallFilter>) => {
    const merged = { ...get().failedFilter, ...filter };
    set({ failedFilter: merged });
  },
}));