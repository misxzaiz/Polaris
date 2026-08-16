/**
 * 供应商调用统计面板
 *
 * 展示供应商分组路由的聚合统计和失败调用日志。
 * 数据源：useProviderStatsStore（后端持久化计数器 + JSONL 失败日志）。
 *
 * 五个视图 Tab：
 * - 概览：统计卡片 + 供应商柱状图 + 分组策略分布 + 问题供应商
 * - 按供应商：表格（Profile/选中/失败/成功率/Key分布）
 * - 按分组：卡片式，成员+Key细分+策略标记+均匀度
 * - 按时间：每日趋势堆叠柱状图
 * - 失败日志：持久化失败记录，支持筛选/搜索/展开详情
 */

import { useEffect, useState } from 'react';
import { useProviderStatsStore, type ProfileStats, type FailedCallKind } from '@/stores/providerStatsStore';
import { clsx } from 'clsx';
import {
  RefreshCw, Trash2, PieChart, BarChart3, TrendingUp, Activity,
  ChevronDown, ChevronRight, XCircle, Database,
  Loader2, Search, ChevronLeft, ChevronRight as ChevronRightIcon,
} from 'lucide-react';

// ============================================================================
// 常量
// ============================================================================

const CHART_COLORS = [
  '#5b6ef5', '#f59e0b', '#a78bfa', '#14b8a6', '#ec4899',
  '#06b6d4', '#22c55e', '#f97316', '#ef4444', '#8b5cf6',
];

function getColor(i: number) { return CHART_COLORS[i % CHART_COLORS.length]; }

const FAILED_KIND_META: Record<FailedCallKind, { label: string; color: string; icon: 'red' | 'amber' }> = {
  spawnFailed: { label: 'Spawn 失败', color: 'text-red-400', icon: 'red' },
  applyFailed: { label: 'Apply 失败', color: 'text-orange-400', icon: 'amber' },
  allUnavailable: { label: '全部不可用', color: 'text-amber-400', icon: 'amber' },
  officialFallback: { label: '官方回退', color: 'text-amber-400', icon: 'amber' },
};

function fmtTs(tsMs: number): string {
  if (!tsMs) return '-';
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

function fmtRelative(tsMs: number): string {
  if (!tsMs) return '-';
  const diff = Date.now() - tsMs;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

function successRate(ps: ProfileStats): number {
  const total = ps.selected + ps.failoverIn;
  if (total === 0) return 0;
  return ps.bound / total;
}

function healthColor(rate: number): string {
  if (rate >= 0.9) return 'text-green-400';
  if (rate >= 0.5) return 'text-amber-400';
  return 'text-red-400';
}

function healthDot(rate: number): string {
  if (rate >= 0.9) return 'bg-green-500';
  if (rate >= 0.5) return 'bg-amber-500';
  return 'bg-red-500';
}

// ============================================================================
// Tab 导航按钮
// ============================================================================

function TabBtn({ active, onClick, icon, label, badge }: {
  active: boolean; onClick: () => void; icon: React.ReactNode; label: string; badge?: number;
}) {
  return (
    <button onClick={onClick} className={clsx(
      'flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors',
      active ? 'bg-primary/10 text-primary font-medium' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
    )}>
      {icon}{label}
      {badge !== undefined && badge > 0 && (
        <span className="text-[10px] bg-red-500 text-white px-1.5 py-0.5 rounded-full leading-none">{badge}</span>
      )}
    </button>
  );
}

// ============================================================================
// 主面板
// ============================================================================

export function ProviderStatsTab() {
  const {
    snapshot, failedLogs, failedFilter, loading, error,
    fetchStats, fetchFailedLogs, clearStats, setFailedFilter,
  } = useProviderStatsStore();

  const [viewMode, setViewMode] = useState<'overview' | 'provider' | 'group' | 'time' | 'failed'>('overview');
  const [expandedFailId, setExpandedFailId] = useState<number | null>(null);

  // 首次加载
  useEffect(() => {
    fetchStats();
    fetchFailedLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isEmpty = snapshot && snapshot.totalRoutes === 0;

  // 失败日志筛选
  const failedKinds: FailedCallKind[] = ['spawnFailed', 'applyFailed', 'allUnavailable', 'officialFallback'];
  const keywordSearch = (kw: string) => {
    setFailedFilter({ keyword: kw || null, offset: 0 });
    fetchFailedLogs({ keyword: kw || null, offset: 0 });
  };
  const setErrorKind = (kind: string) => {
    const ek = kind && kind !== 'all' ? kind as FailedCallKind : null;
    setFailedFilter({ errorKind: ek, offset: 0 });
    fetchFailedLogs({ errorKind: ek, offset: 0 });
  };
  const goPage = (dir: number) => {
    const newOffset = Math.max(0, failedFilter.offset + dir * failedFilter.limit);
    setFailedFilter({ offset: newOffset });
    fetchFailedLogs({ offset: newOffset });
  };

  return (
    <div className="space-y-4">
      {/* 工具栏 */}
      <div className="flex items-center gap-2 p-3 rounded-lg bg-surface border border-border-subtle">
        <PieChart size={16} className="text-primary" />
        <span className="text-sm font-medium text-text-primary">供应商调用统计</span>
        <span className="text-xs text-text-tertiary">
          {snapshot ? `共 ${snapshot.totalRoutes} 次路由` : '加载中...'}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <button className="p-1.5 rounded hover:bg-surface/70 text-text-muted" onClick={() => { fetchStats(); fetchFailedLogs(); }} title="刷新">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
          </button>
          <button className="p-1.5 rounded hover:bg-surface/70 text-red-400/80" onClick={clearStats} title="清空计数">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {/* Tab 导航 */}
      <div className="flex items-center gap-1 p-0.5 rounded-lg bg-background-surface border border-border-subtle w-fit">
        <TabBtn active={viewMode === 'overview'} onClick={() => setViewMode('overview')} icon={<PieChart size={13} />} label="概览" />
        <TabBtn active={viewMode === 'provider'} onClick={() => setViewMode('provider')} icon={<BarChart3 size={13} />} label="按供应商" />
        <TabBtn active={viewMode === 'group'} onClick={() => setViewMode('group')} icon={<Activity size={13} />} label="按分组" />
        <TabBtn active={viewMode === 'time'} onClick={() => setViewMode('time')} icon={<TrendingUp size={13} />} label="按时间" />
        <TabBtn active={viewMode === 'failed'} onClick={() => setViewMode('failed')} icon={<XCircle size={13} />} label="失败日志" badge={snapshot?.totalFailures} />
      </div>

      {/* 加载中 */}
      {!snapshot && loading && (
        <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-text-tertiary" /></div>
      )}

      {/* 错误 */}
      {error && (
        <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">{error}</div>
      )}

      {/* 空数据 */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
          <Database size={32} className="mb-2 opacity-40" />
          <p className="text-sm">暂无供应商调用统计数据</p>
          <p className="text-xs mt-1">使用供应商分组路由发送消息后，此处将自动累积统计</p>
        </div>
      )}

      {/* ====== 概览视图 ====== */}
      {snapshot && !isEmpty && viewMode === 'overview' && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {[
              { label: '路由总次数', value: fmtNum(snapshot.totalRoutes), color: 'text-primary' },
              { label: '绑定成功', value: fmtNum(snapshot.profiles.reduce((s, p) => s + p.bound, 0)), color: 'text-green-400' },
              { label: '失败次数', value: fmtNum(snapshot.totalFailures), color: 'text-red-400' },
              { label: 'Failover 切换', value: fmtNum(snapshot.totalFailovers), color: 'text-amber-400' },
              { label: 'Profile 数', value: fmtNum(snapshot.profiles.length), color: 'text-purple-400' },
            ].map(c => (
              <div key={c.label} className="rounded-lg border border-border-subtle bg-background-surface p-3">
                <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{c.label}</div>
                <div className={clsx('text-base font-mono tabular-nums font-semibold', c.color)}>{c.value}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {/* 供应商分布 */}
            <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
              <h5 className="text-xs font-medium text-text-primary mb-3">按供应商调用分布（Top 5）</h5>
              {snapshot.profiles.length === 0 ? (
                <p className="text-xs text-text-tertiary">暂无数据</p>
              ) : (
                snapshot.profiles.slice(0, 5).map((p, i) => {
                  const total = Math.max(...snapshot.profiles.map(x => x.selected + x.failoverIn), 1);
                  const count = p.selected + p.failoverIn;
                  return (
                    <div key={p.profileId} className="mb-2">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="flex items-center gap-1.5 text-text-secondary">
                          <span className="w-2 h-2 rounded-sm" style={{ background: getColor(i) }} />
                          {p.profileName}
                        </span>
                        <span className="text-text-muted tabular-nums">{fmtNum(count)} 次</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${(count / total) * 100}%`, background: getColor(i) }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* 分组策略分布 */}
            <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
              <h5 className="text-xs font-medium text-text-primary mb-3">分组策略分布</h5>
              {snapshot.groups.length === 0 ? (
                <p className="text-xs text-text-tertiary">暂无数据</p>
              ) : (
                snapshot.groups.map((g, i) => {
                  const total = Math.max(...snapshot.groups.map(x => x.totalRoutes), 1);
                  return (
                    <div key={g.groupId} className="mb-2">
                      <div className="flex items-center justify-between text-xs mb-1">
                        <span className="flex items-center gap-1.5 text-text-secondary">
                          <span className="w-2 h-2 rounded-sm" style={{ background: getColor(i) }} />
                          {g.groupName}
                          <span className="text-[10px] px-1 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary">{g.strategy}</span>
                        </span>
                        <span className="text-text-muted tabular-nums">{fmtNum(g.totalRoutes)} 次</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                        <div className="h-full rounded-full transition-all" style={{ width: `${(g.totalRoutes / total) * 100}%`, background: getColor(i) }} />
                      </div>
                    </div>
                  );
                })
              )}
              {snapshot.groups.some(g => g.officialFallback > 0 || g.allUnavailable > 0) && (
                <div className="mt-2 pt-2 border-t border-border-subtle flex justify-between text-xs text-text-tertiary">
                  <span>⚠ 官方回退: {snapshot.groups.reduce((s, g) => s + g.officialFallback, 0)} 次</span>
                  <span>全部不可用: {snapshot.groups.reduce((s, g) => s + g.allUnavailable, 0)} 次</span>
                </div>
              )}
            </div>
          </div>

          {/* 问题供应商 */}
          {snapshot.profiles.filter(p => successRate(p) < 0.9).length > 0 && (
            <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
              <h5 className="text-xs font-medium text-text-primary mb-3 flex items-center gap-1.5">
                <span className="text-red-400">●</span> 问题供应商
              </h5>
              {snapshot.profiles.filter(p => successRate(p) < 0.9).map(p => (
                <div key={p.profileId} className="flex items-center gap-2 text-xs py-1 border-b border-border-subtle/50 last:border-0">
                  <span className={clsx('w-1.5 h-1.5 rounded-full', healthDot(successRate(p)))} />
                  <span className="text-text-primary">{p.profileName}</span>
                  <span className="text-text-tertiary">— {p.selected + p.failoverIn} 次尝试，{p.spawnFailed + p.applyFailed} 次失败</span>
                  <span className={clsx('font-mono ml-auto', healthColor(successRate(p)))}>
                    {(successRate(p) * 100).toFixed(0)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ====== 按供应商视图 ====== */}
      {snapshot && !isEmpty && viewMode === 'provider' && (
        <div className="rounded-lg border border-border-subtle bg-background-surface overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-text-muted border-b border-border-subtle">
                <th className="text-left py-2 px-3 font-medium">Profile</th>
                <th className="text-left py-2 px-2 font-medium">分组</th>
                <th className="text-right py-2 px-2 font-medium">选中</th>
                <th className="text-right py-2 px-2 font-medium">Failover 入</th>
                <th className="text-right py-2 px-2 font-medium">Failover 出</th>
                <th className="text-right py-2 px-2 font-medium">失败</th>
                <th className="text-right py-2 px-2 font-medium">成功率</th>
                <th className="text-center py-2 px-2 font-medium">Key 分布</th>
                <th className="text-right py-2 pl-2 font-medium">最后活跃</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.profiles.map(p => (
                <tr key={p.profileId} className="border-b border-border-subtle/30 last:border-0 hover:bg-background-hover/50">
                  <td className="py-2 px-3">
                    <span className="flex items-center gap-1.5">
                      <span className={clsx('w-1.5 h-1.5 rounded-full', healthDot(successRate(p)))} />
                      <span className="text-text-primary">{p.profileName}</span>
                    </span>
                  </td>
                  <td className="py-2 px-2 text-text-tertiary">{p.groupName}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums text-text-secondary">{p.selected}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums text-text-muted">{p.failoverIn}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums text-text-muted">{p.failoverOut}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums text-red-400">{p.spawnFailed + p.applyFailed}</td>
                  <td className="py-2 px-2 text-right font-mono tabular-nums">
                    <span className={healthColor(successRate(p))}>{(successRate(p) * 100).toFixed(0)}%</span>
                  </td>
                  <td className="py-2 px-2 text-center">
                    {Object.keys(p.keyBreakdown).length > 0 ? (
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        RR {Object.keys(p.keyBreakdown).length} Key
                      </span>
                    ) : (
                      <span className="text-[10px] text-text-muted">单 Key</span>
                    )}
                  </td>
                  <td className="py-2 pl-2 text-right text-text-tertiary">{fmtRelative(p.lastActiveMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ====== 按分组视图 ====== */}
      {snapshot && !isEmpty && viewMode === 'group' && (
        <div className="space-y-2">
          {snapshot.groups.map(g => (
            <div key={g.groupId} className="rounded-lg border border-border-subtle bg-background-surface overflow-hidden">
              <div className="flex items-center gap-2 px-3 py-2 bg-surface border-b border-border-subtle">
                <Activity size={14} className="text-primary" />
                <span className="text-sm font-medium text-text-primary">{g.groupName}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">{g.strategy}</span>
                <span className="text-xs text-text-tertiary ml-auto">
                  {g.failoverCount} 次 failover · 最大重试 3 轮
                </span>
              </div>
              <div className="p-3">
                {snapshot.profiles.filter(p => p.groupId === g.groupId).map(p => {
                  const keys = Object.entries(p.keyBreakdown);
                  return (
                    <div key={p.profileId} className="flex items-center gap-2 py-1.5">
                      <span className="w-24 text-xs flex items-center gap-1.5">
                        <span className={clsx('w-1.5 h-1.5 rounded-full', healthDot(successRate(p)))} />
                        {p.profileName}
                      </span>
                      <div className="flex-1 flex gap-1">
                        {keys.length > 0 ? keys.map(([kIdx, ks]) => (
                          <div
                            key={kIdx}
                            className="h-3 rounded-sm flex items-center justify-center text-[9px] text-white font-mono"
                            style={{ flex: ks.selected || 1, background: getColor(Number(kIdx) || 0) }}
                            title={`Key-${kIdx}: ${ks.selected} 次`}
                          >
                            {ks.selected > 3 ? `Key-${kIdx} ${ks.selected}` : ''}
                          </div>
                        )) : (
                          <span className="text-[10px] text-text-muted">单 Key</span>
                        )}
                      </div>
                      <span className={clsx('text-xs font-mono w-16 text-right', healthColor(successRate(p)))}>
                        {p.selected + p.failoverIn} 次
                      </span>
                    </div>
                  );
                })}
                {(g.failoverCount > 0 || g.allUnavailable > 0) && (
                  <div className="mt-2 pt-2 border-t border-border-subtle text-xs text-text-tertiary flex gap-3">
                    <span>Failover: {g.failoverCount} 次</span>
                    {g.allUnavailable > 0 && <span className="text-red-400">全部不可用: {g.allUnavailable} 次</span>}
                    {g.officialFallback > 0 && <span className="text-amber-400">官方回退: {g.officialFallback} 次</span>}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ====== 按时间视图 ====== */}
      {snapshot && !isEmpty && viewMode === 'time' && (
        <div className="rounded-lg border border-border-subtle bg-background-surface p-6 text-center text-sm text-text-tertiary">
          <TrendingUp size={24} className="mx-auto mb-2 opacity-40" />
          <p>时间趋势图需要后端提供每日历史数据</p>
          <p className="text-xs mt-1">当前计数器为基础累积值，暂不包含时间维度</p>
        </div>
      )}

      {/* ====== 失败日志视图 ====== */}
      {viewMode === 'failed' && (
        <>
          {/* 筛选栏 */}
          <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-background-surface border border-border-subtle">
            <select
              className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary"
              onChange={e => setErrorKind(e.target.value)}
              value={failedFilter.errorKind || 'all'}
            >
              <option value="all">全部类型</option>
              {failedKinds.map(k => (
                <option key={k} value={k}>{FAILED_KIND_META[k].label}</option>
              ))}
            </select>
            <div className="flex items-center gap-1 text-xs text-text-muted">
              <Search size={12} />
              <input
                type="text"
                className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary w-36"
                placeholder="搜索错误关键词..."
                onKeyDown={e => e.key === 'Enter' && keywordSearch((e.target as HTMLInputElement).value)}
              />
            </div>
            <span className="text-xs text-text-tertiary ml-auto">
              显示 {failedLogs.length} 条
            </span>
          </div>

          {/* 列表 */}
          <div className="space-y-1.5 max-h-[55vh] overflow-y-auto">
            {failedLogs.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-text-tertiary">
                <Database size={24} className="mb-2 opacity-40" />
                <p className="text-sm">没有失败记录</p>
                <p className="text-xs mt-1">所有供应商分组路由均正常运行，或筛选条件下无匹配记录</p>
              </div>
            ) : failedLogs.map(log => {
              const meta = FAILED_KIND_META[log.errorKind] ?? { label: log.errorKind, color: 'text-text-muted', icon: 'amber' as const };
              const isExpanded = expandedFailId === log.seq;
              return (
                <div key={log.seq} className="rounded-lg border border-border-subtle bg-background-surface overflow-hidden cursor-pointer hover:border-text-muted/50 transition-colors"
                  onClick={() => setExpandedFailId(isExpanded ? null : log.seq)}
                >
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className={clsx('w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0', meta.icon === 'red' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400')}>
                      {meta.icon === 'red' ? '✕' : '!'}
                    </span>
                    <span className={clsx('text-xs font-medium w-20 shrink-0', meta.color)}>{meta.label}</span>
                    <span className="text-[11px] font-mono text-text-tertiary w-16 shrink-0">{fmtTs(log.tsMs)}</span>
                    <span className="text-xs text-text-secondary flex items-center gap-1 flex-1 min-w-0">
                      {log.profileName && <span className="truncate">{log.profileName}</span>}
                      {log.keyIdx !== null && log.keyIdx !== undefined && (
                        <span className="text-[10px] px-1 rounded bg-cyan-500/10 text-cyan-400 shrink-0">Key-{log.keyIdx}</span>
                      )}
                    </span>
                    <span className="text-xs text-text-tertiary truncate flex-1">{log.errorMessage}</span>
                    {isExpanded ? <ChevronDown size={14} className="text-text-muted shrink-0" /> : <ChevronRight size={14} className="text-text-muted shrink-0" />}
                  </div>
                  {isExpanded && (
                    <div className="border-t border-border-subtle bg-background-elevated px-3 py-2.5">
                      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">完整错误消息</div>
                      <div className="bg-red-950/50 border border-red-900/30 rounded-md p-2 font-mono text-[11px] text-red-200 mb-2.5 whitespace-pre-wrap break-all">
                        {log.errorMessage || '(无错误详情)'}
                      </div>
                      <div className="text-[10px] text-text-muted uppercase tracking-wider mb-1">尝试链路</div>
                      <div className="space-y-1">
                        {log.tried.map((pid, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-xs">
                            <span className="w-4 h-4 rounded-full bg-red-500/20 text-red-400 flex items-center justify-center text-[9px] font-bold">✕</span>
                            <span className="text-text-secondary">{pid}</span>
                            <span className="text-text-muted text-[10px]">→ 失败</span>
                          </div>
                        ))}
                        <div className="flex items-center gap-1.5 text-xs">
                          <span className="w-4 h-4 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center text-[9px] font-bold">→</span>
                          <span className="text-amber-400">{
                            log.errorKind === 'allUnavailable' || log.errorKind === 'officialFallback'
                              ? '回退到官方端点'
                              : '已自动 failover'
                          }</span>
                        </div>
                      </div>
                      <div className="mt-2 text-[11px] text-text-tertiary">
                        会话: {log.sessionId?.slice(0, 8) ?? '-'} · 引擎: {log.engine ?? '-'} · 总尝试: {log.attempt + 1} 轮
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 分页 */}
          {failedLogs.length > 0 && (
            <div className="flex items-center justify-center gap-2 pt-2">
              <button
                className="px-2 py-1 text-xs rounded-md border border-border-subtle bg-background-surface text-text-secondary disabled:opacity-30 disabled:cursor-default"
                disabled={failedFilter.offset === 0}
                onClick={() => goPage(-1)}
              >
                <ChevronLeft size={13} /> 上一页
              </button>
              <span className="text-xs text-text-tertiary">
                第 {Math.floor(failedFilter.offset / failedFilter.limit) + 1} 页
              </span>
              <button
                className="px-2 py-1 text-xs rounded-md border border-border-subtle bg-background-surface text-text-secondary disabled:opacity-30 disabled:cursor-default"
                disabled={failedLogs.length < failedFilter.limit}
                onClick={() => goPage(1)}
              >
                下一页 <ChevronRightIcon size={13} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}