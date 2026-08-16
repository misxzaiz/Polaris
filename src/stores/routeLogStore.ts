/**
 * 供应商路由日志 Store
 *
 * 管理供应商分组路由决策日志（Profile 选择 / failover 切换 / 失败原因）。
 * 数据来源：后端 `provider_route_logs` 命令 + 轮询增量拉取。
 *
 * 面板打开时全量拉取 + 定时轮询续拉（since = maxSeq）。
 * 后端 ProviderRouter 环形缓冲容量 200 条，溢出丢最旧。
 */

import { create } from 'zustand';
import { invoke } from '@/services/transport';
import { createLogger } from '@/utils/logger';

const log = createLogger('RouteLogStore');

/** 路由策略 */
export type RouteStrategy = 'failover' | 'roundrobin' | 'weighted';

/** 路由日志事件类型 */
export type RouteLogKind =
  | 'initialSelect'
  | 'failoverSwitch'
  | 'applyFailed'
  | 'spawnFailed'
  | 'bound'
  | 'allUnavailable';

/** 路由日志条目（与后端 RouteLogEntry 对齐） */
export interface RouteLogEntry {
  seq: number;
  kind: RouteLogKind;
  groupId: string;
  groupName: string;
  strategy: RouteStrategy;
  profileId?: string | null;
  profileName?: string | null;
  sessionId?: string | null;
  engine?: string | null;
  attempt: number;
  error?: string | null;
  tried: string[];
  tsMs: number;
}

interface RouteLogState {
  /** 全部已拉取的日志（seq 升序） */
  logs: RouteLogEntry[];
  /** 当前已拉取到的最大 seq（增量续拉用） */
  maxSeq: number;
  /** 是否正在拉取 */
  loading: boolean;
  /** 轮询定时器 */
  pollTimer: number | null;
  /** 是否自动刷新（面板打开时开启） */
  autoRefresh: boolean;

  /** 全量拉取 */
  fetchAll: () => Promise<void>;
  /** 增量拉取（since = maxSeq） */
  fetchIncremental: () => Promise<void>;
  /** 清空后端日志缓冲 + 本地 */
  clear: () => Promise<void>;
  /** 开启自动刷新（面板打开时调用） */
  startAutoRefresh: () => void;
  /** 停止自动刷新（面板关闭时调用） */
  stopAutoRefresh: () => void;
}

const POLL_INTERVAL_MS = 3000;

export const useRouteLogStore = create<RouteLogState>((set, get) => ({
  logs: [],
  maxSeq: 0,
  loading: false,
  pollTimer: null,
  autoRefresh: false,

  fetchAll: async () => {
    set({ loading: true });
    try {
      const logs = await invoke<RouteLogEntry[]>('provider_route_logs', { since: null });
      const maxSeq = logs.length > 0 ? Math.max(...logs.map((l) => l.seq)) : 0;
      set({ logs, maxSeq, loading: false });
    } catch (e) {
      log.warn('拉取路由日志失败', { error: String(e) });
      set({ loading: false });
    }
  },

  fetchIncremental: async () => {
    const since = get().maxSeq;
    if (get().loading) return;
    set({ loading: true });
    try {
      const inc = await invoke<RouteLogEntry[]>('provider_route_logs', { since });
      if (inc.length > 0) {
        // 合并并去重（按 seq），保留升序
        const existing = get().logs;
        const seen = new Set(existing.map((l) => l.seq));
        const fresh = inc.filter((l) => !seen.has(l.seq));
        if (fresh.length > 0) {
          const merged = [...existing, ...fresh].sort((a, b) => a.seq - b.seq);
          // 限制本地条数（与后端缓冲对齐，防无限增长）
          const trimmed = merged.length > 500 ? merged.slice(merged.length - 500) : merged;
          const newMax = Math.max(...inc.map((l) => l.seq));
          set({ logs: trimmed, maxSeq: Math.max(since, newMax) });
        }
      }
      set({ loading: false });
    } catch (e) {
      log.warn('增量拉取路由日志失败', { error: String(e) });
      set({ loading: false });
    }
  },

  clear: async () => {
    try {
      await invoke('provider_route_logs_clear');
      set({ logs: [], maxSeq: 0 });
    } catch (e) {
      log.warn('清空路由日志失败', { error: String(e) });
    }
  },

  startAutoRefresh: () => {
    if (get().pollTimer !== null) return;
    // 立即拉一次全量
    get().fetchAll();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      get().fetchIncremental();
    }, POLL_INTERVAL_MS);
    set({ pollTimer: timer, autoRefresh: true });
  },

  stopAutoRefresh: () => {
    const timer = get().pollTimer;
    if (timer !== null) {
      window.clearInterval(timer);
    }
    set({ pollTimer: null, autoRefresh: false });
  },
}));
