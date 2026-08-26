/**
 * Token 用量统计 Store
 *
 * 数据源：代理层 SQLite 数据库（proxy handler 在转发 API 响应时实时写入）。
 * 覆盖所有经过代理的请求路径，包括 UI 会话、调度任务、IM 机器人等。
 *
 * 查询方式：直调后端 tauri::command，无需前端事件流参与。
 * 性能：首次加载后缓存，后续直读。
 */

import { create } from 'zustand'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('TokenAnalyticsStore')

// ============================================================================
// 类型定义（与后端 serde 对齐）
// ============================================================================

export interface UsageSummary {
  totalRequests: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreationTokens: number
  totalCostUsd: number
}

export interface ModelUsageStats {
  model: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
}

export interface DailyUsageStats {
  date: string
  requestCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
}

export interface UsageLogEntry {
  id: number
  model: string
  requestModel: string | null
  engineId: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  latencyMs: number
  statusCode: number
  isStreaming: boolean
  createdAt: number
  totalCostUsd: number
}

export type TimeRange = 'today' | '1d' | '7d' | '14d' | '30d' | 'all'

// ============================================================================
// 辅助：时间范围 → Unix 时间戳
// ============================================================================

function timeRangeToDates(range: TimeRange): { startDate?: number; endDate?: number } {
  if (range === 'all') return {}
  const now = Math.floor(Date.now() / 1000)
  const day = 86400
  const map: Record<string, number> = { 'today': 0, '1d': day, '7d': 7 * day, '14d': 14 * day, '30d': 30 * day }
  const lookback = map[range]
  if (lookback === 0) {
    // today: 当天 0 点
    const d = new Date()
    const startOfDay = Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000)
    return { startDate: startOfDay, endDate: now }
  }
  return { startDate: now - lookback, endDate: now }
}

// ============================================================================
// 筛选参数
// ============================================================================

export interface TokenFilterParams {
  engineId?: string
  model?: string
  /** 显式时间范围（Unix 秒时间戳），优先级高于 timeRange */
  startDate?: number
  endDate?: number
  /** 预设时间范围（当 startDate/endDate 未设置时生效） */
  timeRange?: TimeRange
}

// ============================================================================
// Store
// ============================================================================

interface TokenAnalyticsState {
  cachedSummary: UsageSummary | null
  cachedModelStats: ModelUsageStats[] | null
  cachedTopSessions: UsageLogEntry[] | null
  loaded: boolean
  /** 当前筛选参数 */
  filterParams: TokenFilterParams

  loadData: (filters?: TokenFilterParams) => Promise<void>
  refreshData: (filters?: TokenFilterParams) => Promise<void>

  getSummary: () => UsageSummary
  getModelStats: () => ModelUsageStats[]
  getTopSessions: (limit?: number, offset?: number) => Promise<UsageLogEntry[]>
  getDailyTrends: (range: TimeRange, engineId?: string, model?: string, startDate?: number, endDate?: number) => Promise<DailyUsageStats[]>
}

/** 将筛选参数转为后端 invoke 参数 */
function filterToInvokeArgs(filters: TokenFilterParams) {
  const fallback = filters.timeRange ? timeRangeToDates(filters.timeRange) : {}
  return {
    startDate: filters.startDate ?? fallback.startDate,
    endDate: filters.endDate ?? fallback.endDate,
    engineId: filters.engineId || undefined,
    model: filters.model || undefined,
  }
}

export const useTokenAnalyticsStore = create<TokenAnalyticsState>((set, get) => ({
  cachedSummary: null,
  cachedModelStats: null,
  cachedTopSessions: null,
  loaded: false,
  filterParams: { timeRange: '30d' },

  loadData: async (filters?: TokenFilterParams) => {
    const f = filters ?? get().filterParams
    if (filters) set({ filterParams: filters })
    const args = filterToInvokeArgs(f)
    try {
      const [summary, modelStats] = await Promise.all([
        invoke<UsageSummary>('get_usage_summary', args),
        invoke<ModelUsageStats[]>('get_usage_model_stats', { startDate: args.startDate, endDate: args.endDate, engineId: args.engineId }),
      ])
      set({
        cachedSummary: summary,
        cachedModelStats: modelStats,
        cachedTopSessions: null, // 分页数据单独加载
        loaded: true,
      })
      log.info('Token 统计数据已加载', { totalRequests: summary.totalRequests, filters: f })
    } catch (e) {
      log.warn('Token 统计加载失败: ' + String(e))
      set({ loaded: true })
    }
  },

  refreshData: async (filters?: TokenFilterParams) => {
    set({ cachedSummary: null, cachedModelStats: null, cachedTopSessions: null, loaded: false })
    return get().loadData(filters)
  },

  getSummary: () => {
    return get().cachedSummary ?? {
      totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalCostUsd: 0,
    }
  },

  getModelStats: () => get().cachedModelStats ?? [],

  getTopSessions: async (limit = 20, offset = 0) => {
    const f = get().filterParams
    const args = filterToInvokeArgs(f)
    try {
      return await invoke<UsageLogEntry[]>('get_usage_recent_logs', { limit, offset, ...args })
    } catch {
      return []
    }
  },

  getDailyTrends: async (range: TimeRange, engineId?: string, model?: string, startDate?: number, endDate?: number) => {
    const dates = (startDate !== undefined && endDate !== undefined)
      ? { startDate, endDate }
      : timeRangeToDates(range)
    try {
      return await invoke<DailyUsageStats[]>('get_usage_daily_trends', { ...dates, engineId, model })
    } catch {
      return []
    }
  },
}))