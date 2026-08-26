/**
 * Token 统计面板
 *
 * 数据源：useTokenAnalyticsStore（代理层 SQLite 数据库，后端实时写入）。
 * 覆盖：所有经过代理的 API 请求（UI 会话 / 调度任务 / IM 机器人等）。
 *
 * 全局筛选栏：引擎 / 模型 / 时间范围 → 影响所有 Tab 数据。
 */

import { useEffect, useState, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useTokenAnalyticsStore, type TimeRange, type UsageLogEntry, type TokenFilterParams } from '@/stores/tokenAnalyticsStore'
import { Loader2, RefreshCw, BarChart3, PieChart, TrendingUp, Database, ChevronLeft, ChevronRight } from 'lucide-react'
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
// 日期时间工具（datetime-local 字符串 ↔ Unix 秒）
// ============================================================================

/** 本地时间 → datetime-local 字符串（YYYY-MM-DDTHH:mm:ss） */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** 某天 00:00:00（datetime-local 格式） */
function dayStartInput(d: Date): string {
  return toLocalInput(d).slice(0, 11) + '00:00:00'
}

/** 某天 23:59:59（datetime-local 格式） */
function dayEndInput(d: Date): string {
  return toLocalInput(d).slice(0, 11) + '23:59:59'
}

/** n 天前的 Date（当天 00:00 起算） */
function daysAgoDate(n: number): Date {
  const d = new Date()
  d.setDate(d.getDate() - n)
  d.setHours(0, 0, 0, 0)
  return d
}

/** datetime-local 字符串 → Unix 秒（本地时间解析；自动补全缺省部分，空串返回 undefined） */
function inputToUnix(v: string): number | undefined {
  if (!v) return undefined
  let s = v
  if (s.length === 10) s += 'T00:00:00'      // 纯日期 → 当天 0 点
  else if (s.length === 16) s += ':00'       // YYYY-MM-DDTHH:mm → 补秒
  const t = new Date(s).getTime()
  return isNaN(t) ? undefined : Math.floor(t / 1000)
}

/** 从模型名推断引擎标识（兜底） */
function inferEngine(model: string): string {
  const prefix = model.includes('-') ? model.split('-')[0] : model
  const engineMap: Record<string, string> = {
    claude: 'claude', gpt: 'codex', o1: 'codex',
    deepseek: 'simple', glm: 'simple', qwen: 'simple', yi: 'simple',
  }
  return engineMap[prefix] || prefix
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
// 引擎选项
// ============================================================================

const ENGINE_OPTIONS = [
  { value: '', label: '全部引擎' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'simple-ai', label: 'Simple AI' },
  { value: 'pi', label: 'Pi' },
  { value: 'omp', label: 'OMP' },
]

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
// 筛选栏
// ============================================================================

function FilterBar({ engineId, model, startDate, endDate, modelOptions, onEngineChange, onModelChange, onDateChange, onRefresh }: {
  engineId: string; model: string; startDate: string; endDate: string
  modelOptions: string[]
  onEngineChange: (v: string) => void; onModelChange: (v: string) => void
  onDateChange: (start: string, end: string) => void
  onRefresh: () => void
}) {
  const now = new Date()
  const presets = [
    { label: '今天', start: dayStartInput(now), end: dayEndInput(now) },
    { label: '近7天', start: dayStartInput(daysAgoDate(6)), end: dayEndInput(now) },
    { label: '近30天', start: dayStartInput(daysAgoDate(29)), end: dayEndInput(now) },
  ]
  const isActivePreset = (s: string, e: string) => startDate === s && endDate === e
  return (
    <div className="flex flex-wrap items-center gap-2 p-2.5 rounded-lg bg-background-surface border border-border-subtle">
      {/* 引擎 */}
      <select value={engineId} onChange={e => onEngineChange(e.target.value)}
        className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary">
        {ENGINE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {/* 模型 */}
      <select value={model} onChange={e => onModelChange(e.target.value)}
        className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary max-w-[160px]">
        <option value="">全部模型</option>
        {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
      </select>
      {/* 快捷预设 */}
      <div className="flex items-center gap-0.5">
        {presets.map(p => (
          <button key={p.label} onClick={() => onDateChange(p.start, p.end)}
            className={clsx('px-2 py-1 text-xs rounded-md transition-colors', isActivePreset(p.start, p.end) ? 'bg-primary/10 text-primary font-medium' : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover')}>
            {p.label}
          </button>
        ))}
      </div>
      {/* 分隔 */}
      <span className="w-px h-4 bg-border-subtle" />
      {/* 日期时间范围（支持时分秒） */}
      <input type="datetime-local" step="1" value={startDate} onChange={e => onDateChange(e.target.value, endDate)}
        title="起始时间（支持时分秒）"
        className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary w-[180px]" />
      <span className="text-text-muted text-xs">~</span>
      <input type="datetime-local" step="1" value={endDate} onChange={e => onDateChange(startDate, e.target.value)}
        title="结束时间（支持时分秒）"
        className="text-xs px-2 py-1 rounded-md border border-border-subtle bg-background-surface text-text-primary outline-none focus:border-primary w-[180px]" />
      {/* 刷新 */}
      <button onClick={onRefresh}
        className="flex items-center gap-1 px-2 py-1 text-xs rounded-md text-text-tertiary hover:text-text-primary hover:bg-background-hover transition-colors" title="刷新">
        <RefreshCw size={13} />
      </button>
    </div>
  )
}

// ============================================================================
// 主组件
// ============================================================================

export function TokenStatsTab() {
  const { t } = useTranslation('settings')
  const { loaded, loadData, refreshData, getSummary, getModelStats, filterParams } = useTokenAnalyticsStore()

  // 筛选状态
  const [engineFilter, setEngineFilter] = useState('')
  const [modelFilter, setModelFilter] = useState('')
  // 日期时间范围（YYYY-MM-DDTHH:mm:ss 格式，空串 = 不限），默认今天
  const [startDate, setStartDate] = useState(() => dayStartInput(new Date()))
  const [endDate, setEndDate] = useState(() => dayEndInput(new Date()))

  // 视图切换
  const [viewMode, setViewMode] = useState<'overview' | 'model' | 'time' | 'sessions'>('overview')

  // 时间趋势
  const [timeSeries, setTimeSeries] = useState<{ labels: string[]; input: number[]; output: number[]; cache: number[]; costUsd: number[]; sessions: number[] }>({ labels: [], input: [], output: [], cache: [], costUsd: [], sessions: [] })
  const [trendsLoading, setTrendsLoading] = useState(false)

  // 分页
  const PAGE_SIZE = 20
  const [page, setPage] = useState(0)
  const [topSessions, setTopSessions] = useState<UsageLogEntry[]>([])
  const [topSessionsLoading, setTopSessionsLoading] = useState(false)

  const { getTopSessions, getDailyTrends } = useTokenAnalyticsStore()

  // 构建筛选参数
  const buildFilters = useCallback((eng: string, mdl: string, sd: string, ed: string): TokenFilterParams => {
    const f: TokenFilterParams = { engineId: eng || undefined, model: mdl || undefined }
    const start = sd ? inputToUnix(sd) : undefined
    const end = ed ? inputToUnix(ed) : undefined
    if (start !== undefined && end !== undefined) {
      f.startDate = start
      f.endDate = end
    }
    return f
  }, [])

  // 筛选变化时重新加载
  const applyFilters = useCallback(async (eng: string, mdl: string, sd: string, ed: string) => {
    const filters = buildFilters(eng, mdl, sd, ed)
    await loadData(filters)
    setPage(0)
    setTopSessions([])
  }, [loadData, buildFilters])

  // 首次加载（默认今天）
  useEffect(() => {
    applyFilters(engineFilter, modelFilter, startDate, endDate)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const onEngineChange = (v: string) => { setEngineFilter(v); applyFilters(v, modelFilter, startDate, endDate) }
  const onModelChange = (v: string) => { setModelFilter(v); applyFilters(engineFilter, v, startDate, endDate) }
  const onDateChange = (sd: string, ed: string) => { setStartDate(sd); setEndDate(ed); applyFilters(engineFilter, modelFilter, sd, ed) }
  const onRefresh = () => refreshData(buildFilters(engineFilter, modelFilter, startDate, endDate))

  // 时间趋势（跟随全局筛选）
  useEffect(() => {
    setTrendsLoading(true)
    const sd = startDate ? inputToUnix(startDate) : undefined
    const ed = endDate ? inputToUnix(endDate) : undefined
    getDailyTrends('30d', engineFilter || undefined, modelFilter || undefined, sd, ed).then(data => {
      setTimeSeries({
        labels: data.map(d => d.date),
        input: data.map(d => d.inputTokens),
        output: data.map(d => d.outputTokens),
        cache: data.map(d => d.cacheReadTokens + d.cacheCreationTokens),
        costUsd: data.map(d => d.totalCostUsd),
        sessions: data.map(d => d.requestCount),
      })
      setTrendsLoading(false)
    })
  }, [startDate, endDate, engineFilter, modelFilter, getDailyTrends])

  // 分页加载 Top 请求
  useEffect(() => {
    if (viewMode !== 'sessions') return
    setTopSessionsLoading(true)
    getTopSessions(PAGE_SIZE, page * PAGE_SIZE).then(data => {
      setTopSessions(data)
      setTopSessionsLoading(false)
    })
  }, [viewMode, page, filterParams, getTopSessions]) // eslint-disable-line react-hooks/exhaustive-deps

  const summary = getSummary()
  const modelStats = getModelStats()
  const modelOptions = useMemo(() => modelStats.map(m => m.model), [modelStats])

  const isEmpty = loaded && summary.totalRequests === 0

  // 引擎分布
  const engineDistribution = useMemo(() => {
    const map = new Map<string, { sessions: number; input: number; output: number; cache: number }>()
    for (const s of topSessions) {
      const eid = s.engineId || 'unknown'
      const cache = s.cacheReadTokens + s.cacheCreationTokens
      const existing = map.get(eid)
      if (existing) {
        existing.sessions += 1
        existing.input += s.inputTokens
        existing.output += s.outputTokens
        existing.cache += cache
      } else {
        map.set(eid, { sessions: 1, input: s.inputTokens, output: s.outputTokens, cache })
      }
    }
    return Array.from(map.entries()).map(([engineId, s]) => ({ engineId, ...s })).sort((a, b) => b.input - a.input)
  }, [topSessions])

  const hasPrev = page > 0
  const hasNext = topSessions.length >= PAGE_SIZE

  return (
    <div className="space-y-4">
      {/* 筛选栏 */}
      <FilterBar engineId={engineFilter} model={modelFilter} startDate={startDate} endDate={endDate} modelOptions={modelOptions}
        onEngineChange={onEngineChange} onModelChange={onModelChange} onDateChange={onDateChange} onRefresh={onRefresh} />

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
              <div key={c.label} className="rounded-lg border border-border-subtle bg-background-surface p-3">
                <div className="text-[10px] uppercase tracking-wide text-text-muted mb-1">{c.label}</div>
                <div className={clsx('text-base font-mono tabular-nums font-semibold', c.color)}>{c.value}</div>
              </div>
            ))}
          </div>

          {/* 导航标签 */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg bg-background-surface border border-border-subtle w-fit">
            <TabBtn active={viewMode === 'overview'} onClick={() => setViewMode('overview')} icon={<BarChart3 size={13} />} label={t('tokenStats.overview', '概览')} />
            <TabBtn active={viewMode === 'model'} onClick={() => setViewMode('model')} icon={<PieChart size={13} />} label={t('tokenStats.model', '按模型')} />
            <TabBtn active={viewMode === 'time'} onClick={() => setViewMode('time')} icon={<TrendingUp size={13} />} label={t('tokenStats.time', '按时间')} />
            <TabBtn active={viewMode === 'sessions'} onClick={() => setViewMode('sessions')} icon={<Database size={13} />} label={t('tokenStats.topSessions', 'Top 请求')} />
          </div>

          {/* 概览视图 */}
          {viewMode === 'overview' && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
                <h5 className="text-xs font-medium text-text-primary mb-3">{t('tokenStats.topModels', '模型用量 Top 5')}</h5>
                {modelStats.length === 0 ? (
                  <p className="text-xs text-text-tertiary">{t('tokenStats.noModelData', '暂无模型级数据')}</p>
                ) : (
                  <div className="space-y-2">
                    {modelStats.slice(0, 5).map((m, i) => {
                      const maxInput = Math.max(...modelStats.map(x => x.inputTokens))
                      const maxCache = Math.max(...modelStats.map(x => x.cacheReadTokens + x.cacheCreationTokens), 1)
                      const cacheTokens = m.cacheReadTokens + m.cacheCreationTokens
                      return (
                        <div key={m.model}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-secondary truncate max-w-[140px]">{m.model}</span>
                            <span className="text-text-muted tabular-nums">
                              {fmt(m.inputTokens)}
                              {cacheTokens > 0 && <span className="text-purple-400 ml-1.5" title={t('tokenStats.cache', '缓存')}>·{fmt(cacheTokens)}</span>}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                            <div className={clsx('h-full rounded-full', getColor(i))} style={{ width: `${(m.inputTokens / maxInput) * 100}%` }} />
                          </div>
                          {cacheTokens > 0 && (
                            <div className="h-1 rounded-full bg-background-tertiary overflow-hidden mt-0.5">
                              <div className="h-full rounded-full bg-purple-400" style={{ width: `${(cacheTokens / maxCache) * 100}%` }} />
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
              <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
                <h5 className="text-xs font-medium text-text-primary mb-3">{t('tokenStats.engineDistribution', '引擎分布')}</h5>
                {engineDistribution.length === 0 ? (
                  <p className="text-xs text-text-tertiary">{t('tokenStats.noEngineData', '暂无引擎数据')}</p>
                ) : (
                  <div className="space-y-2.5">
                    {engineDistribution.map((e, i) => {
                      const total = engineDistribution.reduce((s, x) => s + x.sessions, 0)
                      const pct = total > 0 ? e.sessions / total : 0
                      const maxCache = Math.max(...engineDistribution.map(x => x.cache), 1)
                      return (
                        <div key={e.engineId}>
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="text-text-secondary">{e.engineId}</span>
                            <span className="text-text-muted tabular-nums">
                              {e.sessions} {t('tokenStats.requests', '请求')} · {fmt(e.input)}
                              {e.cache > 0 && <span className="text-purple-400 ml-1" title={t('tokenStats.cache', '缓存')}>·{fmt(e.cache)}</span>}
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-background-tertiary overflow-hidden">
                            <div className={clsx('h-full rounded-full', getColor(i))} style={{ width: `${pct * 100}%` }} />
                          </div>
                          {e.cache > 0 && (
                            <div className="h-1 rounded-full bg-background-tertiary overflow-hidden mt-0.5">
                              <div className="h-full rounded-full bg-purple-400" style={{ width: `${(e.cache / maxCache) * 100}%` }} />
                            </div>
                          )}
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
            <div className="rounded-lg border border-border-subtle bg-background-surface p-3 overflow-x-auto">
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
              {trendsLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-text-tertiary" /></div>
              ) : timeSeries.labels.length === 0 ? (
                <div className="rounded-lg border border-border-subtle bg-background-surface p-6 text-center text-text-tertiary">
                  <p className="text-sm">{t('tokenStats.noTimeData', '该时间范围内无数据')}</p>
                </div>
              ) : (
                <div className="rounded-lg border border-border-subtle bg-background-surface p-3">
                  <div className="mb-4">
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-xs font-medium text-text-primary">{t('tokenStats.input', '输入 Token')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-primary" /> {t('tokenStats.input', '输入')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-amber-500" /> {t('tokenStats.output', '输出')}</span>
                      <span className="flex items-center gap-1.5 text-[10px] text-text-muted"><span className="w-2 h-2 rounded-sm bg-purple-400" /> {t('tokenStats.cache', '缓存')}</span>
                    </div>
                    <div className="flex items-end gap-1 h-32">
                      {timeSeries.labels.map((label, i) => {
                        const maxTotal = Math.max(...timeSeries.input.map((v, j) => v + timeSeries.output[j] + timeSeries.cache[j]), 1)
                        return (
                          <div key={label} className="flex-1 flex flex-col items-center gap-0.5 h-full justify-end">
                            <div className="flex flex-col-reverse items-center w-full h-full gap-0.5">
                              <div className="w-full rounded-t-sm bg-amber-500 transition-all" style={{ height: `${Math.max((timeSeries.output[i] / maxTotal) * 100, 0.5)}%` }} title={`${t('tokenStats.output', '输出')}: ${fmt(timeSeries.output[i])}`} />
                              <div className="w-full rounded-t-sm bg-primary transition-all" style={{ height: `${Math.max((timeSeries.input[i] / maxTotal) * 100, 0.5)}%` }} title={`${t('tokenStats.input', '输入')}: ${fmt(timeSeries.input[i])}`} />
                              <div className="w-full rounded-t-sm bg-purple-400 transition-all" style={{ height: `${Math.max((timeSeries.cache[i] / maxTotal) * 100, 0.5)}%` }} title={`${t('tokenStats.cache', '缓存')}: ${fmt(timeSeries.cache[i])}`} />
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
            <div className="rounded-lg border border-border-subtle bg-background-surface overflow-hidden">
              {topSessionsLoading ? (
                <div className="flex items-center justify-center py-8"><Loader2 size={18} className="animate-spin text-text-tertiary" /></div>
              ) : topSessions.length === 0 ? (
                <p className="text-xs text-text-tertiary text-center py-6">{t('tokenStats.noSessions', '暂无请求数据')}</p>
              ) : (
                <>
                  <div className="max-h-[400px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-text-muted border-b border-border-subtle bg-background-surface sticky top-0">
                          <th className="text-left py-2 px-3 font-medium">#</th>
                          <th className="text-left py-2 px-2 font-medium">{t('tokenStats.engine', '引擎')}</th>
                          <th className="text-left py-2 px-2 font-medium">{t('tokenStats.model', '模型')}</th>
                          <th className="text-right py-2 px-2 font-medium">{t('tokenStats.input', '输入')}</th>
                          <th className="text-right py-2 px-2 font-medium">{t('tokenStats.output', '输出')}</th>
                          <th className="text-right py-2 px-2 font-medium">{t('tokenStats.cache', '缓存')}</th>
                          <th className="text-right py-2 px-2 font-medium">{t('tokenStats.cost', '花费')}</th>
                          <th className="text-right py-2 pl-2 font-medium">{t('tokenStats.time', '时间')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topSessions.map((s, i) => (
                          <tr key={s.id} className="border-b border-border-subtle/30 last:border-0 hover:bg-background-hover/50 transition-colors">
                            <td className="py-2 px-3 text-text-muted tabular-nums">{page * PAGE_SIZE + i + 1}</td>
                            <td className="py-2 px-2 text-text-muted">{s.engineId || inferEngine(s.model)}</td>
                            <td className="py-2 px-2 max-w-[160px] truncate text-text-primary" title={s.model}>{s.model}</td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-text-secondary">{fmt(s.inputTokens)}</td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-text-muted">{fmt(s.outputTokens)}</td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-purple-400">{fmt(s.cacheReadTokens + s.cacheCreationTokens)}</td>
                            <td className="py-2 px-2 text-right font-mono tabular-nums text-green-500">$0</td>
                            <td className="py-2 pl-2 text-right text-text-muted text-nowrap">{new Date(s.createdAt * 1000).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {/* 分页 */}
                  <div className="flex items-center justify-between px-3 py-2 border-t border-border-subtle bg-background-surface">
                    <span className="text-[10px] text-text-muted">{t('tokenStats.pageInfo', '第 {page} 页', { page: page + 1 })}</span>
                    <div className="flex items-center gap-1">
                      <button disabled={!hasPrev} onClick={() => setPage(p => p - 1)}
                        className={clsx('flex items-center gap-0.5 px-2 py-1 text-xs rounded-md transition-colors', hasPrev ? 'text-text-primary hover:bg-background-hover' : 'text-text-muted opacity-40 cursor-not-allowed')}>
                        <ChevronLeft size={13} /> {t('tokenStats.prev', '上一页')}
                      </button>
                      <button disabled={!hasNext} onClick={() => setPage(p => p + 1)}
                        className={clsx('flex items-center gap-0.5 px-2 py-1 text-xs rounded-md transition-colors', hasNext ? 'text-text-primary hover:bg-background-hover' : 'text-text-muted opacity-40 cursor-not-allowed')}>
                        {t('tokenStats.next', '下一页')} <ChevronRight size={13} />
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}