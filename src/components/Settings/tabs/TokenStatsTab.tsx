/**
 * Token 统计面板
 *
 * 数据源：useTokenAnalyticsStore（代理层 SQLite 数据库，后端实时写入）。
 * 覆盖：所有经过代理的 API 请求（UI 会话 / 调度任务 / IM 机器人等）。
 *
 * 查询方式：直调后端 tauri::command，首次加载后缓存。
 */

import { useEffect, useState, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useTokenAnalyticsStore, type TimeRange } from '@/stores/tokenAnalyticsStore'
import { Loader2, RefreshCw, BarChart3, PieChart, TrendingUp, Database } from 'lucide-react'
import { clsx } from 'clsx'

// ============================================================================
// 数字格式化
// ============================================================================

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k'
  return String(n)
}

function fmtCost(n: number): string {
  if (n === 0) return '$0'
  if (n < 0.001) return `$${n.toFixed(6)}`
  if (n < 1) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

// ============================================================================
// 颜色方案
// ============================================================================

const CHART_COLORS = [
  'bg-primary', 'bg-amber-500', 'bg-purple-400', 'bg-green-500', 'bg-blue-500',
  'bg-pink-500', 'bg-teal-500', 'bg-orange-500', 'bg-cyan-500', 'bg-red-500',
]

function getColor(i: number) { return CHART_COLORS[i % CHART_COLORS.length] }

// ============================================================================
// 导航标签
// ============================================================================

function TabBtn({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} className={clsx('flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-md transition-colors', active ? 'bg-primary/10 text-primary font-medium' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover')}>
      {icon}{label}
    </button>
  )
}

// ============================================================================
// 主组件
// ============================================================================

export function TokenStatsTab() {
  const { t } = useTranslation('settings')
  const { loaded, loadData, refreshData, getSummary, getModelStats, getTopSessions, getDailyTrends } = useTokenAnalyticsStore()

  const [timeRange, setTimeRange] = useState<TimeRange>('30d')
  const [viewMode, setViewMode] = useState<'overview' | 'model' | 'time' | 'sessions'>('overview')
  const [timeSeries, setTimeSeries] = useState<{ labels: string[]; input: number[]; output: number[]; costUsd: number[]; sessions: number[] }>({ labels: [], input: [], output: [], costUsd: [], sessions: [] })
  const [trendsLoading, setTrendsLoading] = useState(false)

  useEffect(() => { loadData() }, [loadData])

  // 时间范围变化时异步加载趋势
  useEffect(() => {
    setTrendsLoading(true)
    getDailyTrends(timeRange).then(data => {
      setTimeSeries({
        labels: data.map(d => d.date),
        input: data.map(d => d.inputTokens),
        output: data.map(d => d.outputTokens),
        costUsd: data.map(d => d.totalCostUsd),
        sessions: data.map(d => d.requestCount),
      })
      setTrendsLoading(false)
    })
  }, [timeRange, getDailyTrends])

  const summary = getSummary()
  const modelStats = getModelStats()
  const topSessions = getTopSessions(10)

  const isEmpty = loaded && summary.totalRequests === 0

  // 引擎分布：从 modelStats 按模型前缀去重
  const engineDistribution = useMemo(() => {
    const map = new Map<string, { sessions: number; input: number; output: number; costUsd: number }>()
    for (const m of modelStats) {
      // 按模型前缀分组（如 claude-* → claude, deepseek-* → deepseek）
      const prefix = m.model.includes('-') ? m.model.split('-')[0] : m.model
      const existing = map.get(prefix)
      if (existing) {
        existing.sessions += m.requestCount
        existing.input += m.inputTokens
        existing.output += m.outputTokens
        existing.costUsd += m.totalCostUsd
      } else {
        map.set(prefix, { sessions: m.requestCount, input: m.inputTokens, output: m.outputTokens, costUsd: m.totalCostUsd })
      }
    }
    return Array.from(map.entries()).map(([engineId, s]) => ({ engineId, ...s })).sort((a, b) => b.input - a.input)
  }, [modelStats])

  return (
    <div className="space-y-4">
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-text-primary">{t('tokenStats.title', 'Token 用量统计')}</h4>
        <button onClick={refreshData} className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors" title={t('tokenStats.refresh', '刷新')}>
          <RefreshCw size={13} />
          <span>{t('tokenStats.refresh', '刷新')}</span>
        </button>
      </div>

      {/* 加载中 */}
      {!loaded && (
        <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-text-tertiary" /></div>
      )}

      {/* 空数据 */}
      {isEmpty && (
        <div className="flex flex-col items-center justify-center py-12 text-text-tertiary">
          <Database size={32} className="mb-2 opacity-40" />
          <p className="text-sm">{t('tokenStats.empty', '暂无 Token 统计数据')}</p>
          <p className="text-xs mt-1">{t('tokenStats.emptyHint', '发送消息后，代理会自动记录 API 用量')}</p>
        </div>
      )}

      {/* 数据展示 */}
      {loaded && !isEmpty && (
        <>
          {/* 概览卡片 */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
            {[
              { label: t('tokenStats.totalRequests', '请求数'), value: String(summary.totalRequests), color: 'text-primary' },
              { label: t('tokenStats.totalInput', '输入 Token'), value: fmt(summary.totalInputTokens), color: 'text-primary' },
              { label: t('tokenStats.totalOutput', '输出 Token'), value: fmt(summary.totalOutputTokens), color: 'text-amber-500' },
              { label: t('tokenStats.totalCache', '缓存'), value: fmt(summary.totalCacheReadTokens + summary.totalCacheCreationTokens), color: 'text-purple-400' },
              { label: t('tokenStats.totalCost', '总花费'), value: fmtCost(summary.totalCostUsd), color: 'text-green-500' },
            ].map(c => (
              <div key={c.label} className="rounded-lg border border-border-subtle bg-background-surface/40 p-3">
                <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{c.label}</div>
                <div className={clsx('text-base font-mono tabular-nums font-semibold', c.color)}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* 导航标签 */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-background-surface/60 border border-border-subtle w-fit">
            <TabBtn active={viewMode === 'overview'} onClick={() => setViewMode('overview')} icon={<BarChart3 size={13} />} label={t('tokenStats.overview', '概览')} />
            <TabBtn active={viewMode === 'model'} onClick={() => setViewMode('model')} icon={<PieChart size={13} />} label={t('tokenStats.model', '按模型')} />
            <TabBtn active={viewMode === 'time'} onClick={() => setViewMode('time')} icon={<TrendingUp size={13} />} label={t('tokenStats.time', '按时间')} />
            <TabBtn active={viewMode === 'sessions'} onClick={() => setViewMode('sessions')} icon={<Database size={13} />} label={t('tokenStats.topSessions', 'Top 请求')} />
          </div>

          {/* 概览视图 */}
          {viewMode === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg border border-border-subtle bg-background-surface/40 p-3">
                <h5 className="text-xs font-medium text-text-primary mb-3">{t('tokenStats.topModels', '模型用量 Top 5')}</h5>
                {modelStats.length === 0 ? (
                  <p className="text-xs text-text-tertiary">{t('tokenStats.noModelData', '暂无模型级数据')}</p>
                ) : (
                  <div className="space-y-2">
                    {modelStats.slice(0, 5).map((m, i) => {
                      const maxInput = Math.max(...modelStats.map(x => x.inputTokens))
                      return (
                        <div key={m.model}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-secondary truncate max-w-[140px]">{m.model}</span>
                            <span className="text-text-muted tabular-nums">{fmt(m.inputTokens)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                            <div className={clsx('h-full rounded-full', getColor(i))} style={{ width: `${(m.inputTokens / maxInput) * 100}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border-subtle bg-background-surface/40 p-3">
                <h5 className="text-xs font-medium text-text-primary mb-3">{t('tokenStats.engineDistribution', '引擎分布')}</h5>
                {engineDistribution.length === 0 ? (
                  <p className="text-xs text-text-tertiary">{t('tokenStats.noEngineData', '暂无引擎数据')}</p>
                ) : (
                  <div className="space-y-2.5">
                    {engineDistribution.map((e, i) => {
                      const pct = summary.totalRequests > 0 ? e.sessions / summary.totalRequests : 0
                      return (
                        <div key={e.engineId}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-secondary">{e.engineId}</span>
                            <span className="text-text-muted tabular-nums">{e.sessions} {t('tokenStats.requests', '请求')} · {fmt(e.input)}</span>
                          </div>
                          <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                            <div className={clsx('h-full rounded-full', getColor(i))} style={{ width: `${pct * 100}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 按模型视图 */}
          {viewMode === 'model' && (
            <div className="rounded-lg border border-border-subtle bg-background-surface/40 p-3 overflow-x-auto">
              {modelStats.length === 0 ? (
                <p className="text-xs text-text-tertiary text-center py-6">{t('tokenStats.noModelData', '暂无模型级数据')}</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-text-muted border-b border-border-subtle">
                      <th className="text-left py-2 pr-2 font-medium">{t('tokenStats.model', '模型')}</th>
                      <th className="text-right py-2 px-2 font-medium">{t('tokenStats.requests', '请求')}</th>
                      <th className="text-right py-2 px-2 font-medium">{t('tokenStats.input', '输入')}</th>
                      <th className="text-right py-2 px-2 font-medium">{t('tokenStats.output', '输出')}</th>
                      <th className="text-right py-2 px-2 font-medium">{t('tokenStats.cache', '缓存')}</th>
                      <th className="text-right py-2 pl-2 font-medium">{t('tokenStats.cost', '花费')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {modelStats.map((m, i) => {
                      const maxInput = Math.max(...modelStats.map(x => x.inputTokens))
                      const maxCost = Math.max(...modelStats.map(x => x.totalCostUsd))
                      return (
                        <tr key={m.model} className="border-b border-border-subtle/50 last:border-0">
                          <td className="py-2 pr-2">
                            <div className="flex items-center gap-2">
                              <span className={clsx('w-2 h-2 rounded-sm shrink-0', getColor(i))} />
                              <span className="text-text-primary truncate max-w-[160px]">{m.model}</span>
                            </div>
                            <div className="h-1 rounded-full bg-background-tertiary overflow-hidden mt-1">
                              <div className={clsx('h-full rounded-full', getColor(i))} style={{ width: `${(m.inputTokens / maxInput) * 100}%` }} />
                            </div>
                          </td>
                          <td className="text-right py-2 px-2 font-mono tabular-nums text-text-muted">{m.requestCount}</td>
                          <td className="text-right py-2 px-2 font-mono tabular-nums text-text-secondary">{fmt(m.inputTokens)}</td>
                          <td className="text-right py-2 px-2 font-mono tabular-nums text-text-muted">{fmt(m.outputTokens)}</td>
                          <td className="text-right py-2 px-2 font-mono tabular-nums text-text-muted">{fmt(m.cacheReadTokens + m.cacheCreationTokens)}</td>
                          <td className="text-right py-2 pl-2 font-mono tabular-nums">
                            <span className={m.totalCostUsd > 0.01 ? 'text-green-500' : 'text-text-muted'}>{fmtCost(m.totalCostUsd)}</span>
                            {maxCost > 0 && (
                              <div className="h-1 rounded-full bg-background-tertiary overflow-hidden mt-1">
                                <div className="h-full rounded-full bg-green-500/60" style={{ width: `${(m.totalCostUsd / maxCost) * 100}%` }} />
                              </div>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* 按时间视图 */}
          {viewMode === 'time' && (
            <div className="space-y-3">
              <div className="flex items-center gap-1">
                {[
                  { value: 'today' as const, label: t('tokenStats.today', '今天') },
                  { value: '7d' as const, label: t('tokenStats.week', '7天') },
                  { value: '30d' as const, label: t('tokenStats.month', '30天') },
                  { value: 'all' as const, label: t('tokenStats.all', '全部') },
                ].map(o => (
                  <button key={o.value} onClick={() => setTimeRange(o.value)}
                    className={clsx('px-2.5 py-1 text-xs rounded-md transition-colors', timeRange === o.value ? 'bg-primary/10 text-primary font-medium' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover')}>{o.label}</button>
                ))}
              </div>
              {trendsLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-text-tertiary" /></div>
              ) : timeSeries.labels.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-background-surface/40 p-6 text-center text-text-tertiary">
                  <p className="text-sm">{t('tokenStats.noTimeData', '该时间范围内无数据')}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-background-surface/40 p-3">
                  <div className="mb-4">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs font-medium text-text-primary">{t('tokenStats.input', '输入 Token')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-primary" /> {t('tokenStats.input', '输入')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-amber-500" /> {t('tokenStats.output', '输出')}</span>
                    </div>
                    <div className="flex items-end gap-1 h-32">
                      {timeSeries.labels.map((label, i) => {
                        const maxInput = Math.max(...timeSeries.input, 1)
                        return (
                          <div key={label} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end">
                            <div className="flex flex-col-reverse items-center w-full h-full gap-0.5">
                              <div className="w-full rounded-t-sm bg-amber-500 transition-all" style={{ height: `${Math.max((timeSeries.output[i] / maxInput) * 100, 0.5)}%` }} title={`${t('tokenStats.output', '输出')}: ${fmt(timeSeries.output[i])}`} />
                              <div className="w-full rounded-t-sm bg-primary transition-all" style={{ height: `${Math.max((timeSeries.input[i] / maxInput) * 100, 0.5)}%` }} title={`${t('tokenStats.input', '输入')}: ${fmt(timeSeries.input[i])}`} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                    <div className="flex gap-1 mt-1">{timeSeries.labels.map(l => <div key={l} className="flex-1 text-[9px] text-text-muted text-center truncate">{l}</div>)}</div>
                  </div>
                  <div className="pt-3 border-t border-border-subtle">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs font-medium text-text-primary">{t('tokenStats.cost', '花费')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-green-500" /> {t('tokenStats.cost', '花费')}</span>
                    </div>
                    <div className="flex items-end gap-1 h-20">
                      {timeSeries.labels.map((label, i) => {
                        const maxCost = Math.max(...timeSeries.costUsd, 1)
                        return (
                          <div key={label} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end">
                            <div className="flex flex-col-reverse items-center w-full h-full gap-0.5">
                              <div className="w-full rounded-t-sm bg-green-500 transition-all" style={{ height: `${Math.max((timeSeries.costUsd[i] / maxCost) * 100, 0.5)}%` }} />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Top 请求视图 */}
          {viewMode === 'sessions' && (
            <div className="rounded-lg border border-border-subtle bg-background-surface/40 overflow-hidden">
              {topSessions.length === 0 ? (
                <p className="text-xs text-text-tertiary text-center py-6">{t('tokenStats.noSessions', '暂无请求数据')}</p>
              ) : (
                <div className="max-h-[400px] overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-text-muted border-b border-border-subtle bg-background-surface/80 sticky top-0">
                        <th className="text-left py-2 px-3 font-medium">#</th>
                        <th className="text-left py-2 px-2 font-medium">{t('tokenStats.model', '模型')}</th>
                        <th className="text-right py-2 px-2 font-medium">{t('tokenStats.input', '输入')}</th>
                        <th className="text-right py-2 px-2 font-medium">{t('tokenStats.output', '输出')}</th>
                        <th className="text-right py-2 px-2 font-medium">{t('tokenStats.cost', '花费')}</th>
                        <th className="text-right py-2 pl-2 font-medium">{t('tokenStats.time', '时间')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topSessions.map((s, i) => (
                        <tr key={s.id} className="border-b border-border-subtle/30 last:border-0 hover:bg-background-hover/50 transition-colors">
                          <td className="py-2 px-3 text-text-muted tabular-nums">{i + 1}</td>
                          <td className="py-2 px-2 max-w-[180px] truncate text-text-primary" title={s.model}>{s.model}</td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-text-secondary">{fmt(s.inputTokens)}</td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-text-muted">{fmt(s.outputTokens)}</td>
                          <td className="py-2 px-2 text-right font-mono tabular-nums text-green-500">{fmtCost(s.cacheCreationTokens > 0 || s.cacheReadTokens > 0 ? s.cacheReadTokens + s.cacheCreationTokens : 0)}</td>
                          <td className="py-2 pl-2 text-right text-text-muted">{new Date(s.createdAt * 1000).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}