/**
 * 供应商路由日志面板
 *
 * 展示每次会话首请求的 Profile 选择 / failover 切换 / 失败原因链路。
 * 数据源：useRouteLogStore（后端 ProviderRouter 环形缓冲，容量 200 条）。
 *
 * 面板打开时自动开启轮询（3s 增量拉取），关闭时停止。
 * 日志按时间倒序（最新在上），按 session_id 分组可折叠。
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouteLogStore, type RouteLogEntry, type RouteLogKind } from '@/stores/routeLogStore';
import { RefreshCw, Trash2, Pause, Play, Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';

// ============================================================================
// 事件类型展示
// ============================================================================

const KIND_META: Record<RouteLogKind, { label: string; color: string }> = {
  initialSelect: { label: '首轮选择', color: 'text-blue-400' },
  failoverSwitch: { label: 'Failover 切换', color: 'text-amber-400' },
  applyFailed: { label: 'Profile 应用失败', color: 'text-orange-400' },
  spawnFailed: { label: 'Spawn 失败', color: 'text-red-400' },
  bound: { label: '绑定成功', color: 'text-green-400' },
  allUnavailable: { label: '全部不可用', color: 'text-red-500' },
};

const STRATEGY_LABEL: Record<string, string> = {
  failover: 'Failover',
  roundrobin: 'RoundRobin',
  weighted: 'Weighted',
};

function fmtTime(tsMs: number): string {
  if (!tsMs) return '-';
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ============================================================================
// 单条日志行
// ============================================================================

function LogRow({ entry }: { entry: RouteLogEntry }) {
  const meta = KIND_META[entry.kind] ?? { label: entry.kind, color: 'text-text-muted' };
  return (
    <div className="px-3 py-2 border-b border-border-subtle hover:bg-surface/50 text-xs font-mono">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text-tertiary tabular-nums">{fmtTime(entry.tsMs)}</span>
        <span className={clsx('font-medium', meta.color)}>{meta.label}</span>
        <span className="text-text-tertiary">#{entry.seq}</span>
        <span className="px-1.5 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary text-[10px]">
          {STRATEGY_LABEL[entry.strategy] ?? entry.strategy}
        </span>
        <span className="text-text-muted">分组: {entry.groupName}</span>
        {entry.profileId && (
          <span className="text-text-secondary">
            Profile: <span className="text-text-primary">{entry.profileName ?? entry.profileId}</span>
          </span>
        )}
        {entry.attempt > 0 && (
          <span className="text-amber-400/80">第 {entry.attempt + 1} 轮</span>
        )}
      </div>
      {entry.engine && (
        <div className="mt-1 text-text-tertiary">
          引擎: <span className="text-text-secondary">{entry.engine}</span>
          {entry.sessionId && (
            <> · 会话: <span className="text-text-tertiary truncate inline-block max-w-[200px] align-bottom">{entry.sessionId.slice(0, 8)}</span></>
          )}
        </div>
      )}
      {entry.error && (
        <div className="mt-1 text-red-400/90 break-all">
          ⚠ {entry.error}
        </div>
      )}
      {entry.tried.length > 1 && (
        <div className="mt-1 text-text-tertiary">
          已尝试: {entry.tried.join(' → ')}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 按 session 分组
// ============================================================================

interface SessionGroup {
  sessionId: string;
  entries: RouteLogEntry[];
  firstTs: number;
}

function groupBySession(logs: RouteLogEntry[]): SessionGroup[] {
  const map = new Map<string, RouteLogEntry[]>();
  for (const l of logs) {
    const key = l.sessionId ?? '(无会话)';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(l);
  }
  // 每组内按 seq 升序（时间顺序），组间按首条时间倒序（最新会话在上）
  return Array.from(map.entries())
    .map(([sessionId, entries]) => ({
      sessionId,
      entries: entries.sort((a, b) => a.seq - b.seq),
      firstTs: entries[0]?.tsMs ?? 0,
    }))
    .sort((a, b) => b.firstTs - a.firstTs);
}

function SessionGroupView({ group }: { group: SessionGroup }) {
  const [expanded, setExpanded] = useState(true);
  const last = group.entries[group.entries.length - 1];
  const summary = last ? KIND_META[last.kind]?.label ?? '' : '';
  const hasError = group.entries.some((e) => e.error);
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-surface hover:bg-surface/70 text-xs"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="text-text-tertiary tabular-nums">{fmtTime(group.firstTs)}</span>
        <span className="text-text-muted">会话 {group.sessionId.slice(0, 8)}</span>
        <span className="text-text-tertiary">· {group.entries.length} 条</span>
        <span className={clsx('ml-auto', hasError ? 'text-red-400' : 'text-green-400')}>{summary}</span>
      </button>
      {expanded && (
        <div>
          {group.entries.map((e) => (
            <LogRow key={e.seq} entry={e} />
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 主面板
// ============================================================================

export function RouteLogTab() {
  const { t } = useTranslation('settings');
  const { logs, loading, autoRefresh, fetchAll, clear, startAutoRefresh, stopAutoRefresh } = useRouteLogStore();

  // 面板挂载时开启自动刷新，卸载时停止
  useEffect(() => {
    startAutoRefresh();
    return () => stopAutoRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const grouped = useMemo(() => groupBySession(logs), [logs]);

  return (
    <div className="space-y-3">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 p-3 rounded-lg bg-surface border border-border-subtle">
        <Activity size={16} className="text-primary" />
        <span className="text-sm font-medium text-text-primary">
          {t('routeLog.title', '供应商路由日志')}
        </span>
        <span className="text-xs text-text-tertiary">
          {t('routeLog.count', '共 {{n}} 条', { n: logs.length })}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            className="p-1.5 rounded hover:bg-surface/70 text-text-muted"
            onClick={() => (autoRefresh ? stopAutoRefresh() : startAutoRefresh())}
            title={autoRefresh ? '暂停' : '自动刷新'}
          >
            {autoRefresh ? <Pause size={14} /> : <Play size={14} />}
          </button>
          <button
            className="p-1.5 rounded hover:bg-surface/70 text-text-muted disabled:opacity-40"
            onClick={fetchAll}
            disabled={loading}
            title="刷新"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button
            className="p-1.5 rounded hover:bg-surface/70 text-red-400/80"
            onClick={clear}
            title="清空"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* 日志列表 */}
      <div className="space-y-2 max-h-[60vh] overflow-y-auto">
        {grouped.length === 0 ? (
          <div className="p-8 text-center text-sm text-text-tertiary">
            {t('routeLog.empty', '暂无路由日志。发送消息触发供应商分组路由后，此处将显示 Profile 选择与 failover 切换记录。')}
          </div>
        ) : (
          grouped.map((g) => (
            <SessionGroupView key={g.sessionId} group={g} />
          ))
        )}
      </div>

      {/* 说明 */}
      <div className="p-3 rounded-lg bg-warning-faint/30 border border-warning/15 text-xs text-text-muted">
        <p className="mb-1 text-warning/90">{t('routeLog.notes', '说明')}</p>
        <ul className="space-y-0.5 list-disc list-inside">
          <li>仅记录启用供应商分组路由时的决策链路（单 Profile 旧路径不记录）。</li>
          <li>环形缓冲保留最近 200 条，溢出自动丢弃最旧记录。</li>
          <li>自动刷新每 3 秒增量拉取一次。</li>
        </ul>
      </div>
    </div>
  );
}
