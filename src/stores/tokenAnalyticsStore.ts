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
  totalCostUsd: number
}

export interface UsageLogEntry {
  id: number
  model: string
  requestModel: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  latencyMs: number
  statusCode: number
  isStreaming: boolean
  createdAt: number
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
// Store
// ============================================================================

interface TokenAnalyticsState {
  /** 缓存的有效会话列表（null = 未加载） */
  cachedSummary: UsageSummary | null
  cachedModelStats: ModelUsageStats[] | null
  cachedTopSessions: UsageLogEntry[] | null
  /** 是否已加载过 */
  loaded: boolean

  loadData: () => Promise<void>
  refreshData: () => Promise<void>

  getSummary: () => UsageSummary
  getModelStats: () => ModelUsageStats[]
  getTopSessions: (limit?: number) => UsageLogEntry[]
  getDailyTrends: (range: TimeRange) => Promise<DailyUsageStats[]>
}

export const useTokenAnalyticsStore = create<TokenAnalyticsState>((set, get) => ({
  cachedSummary: null,
  cachedModelStats: null,
  cachedTopSessions: null,
  loaded: false,

  loadData: async () => {
    try {
      const [summary, modelStats, topSessions] = await Promise.all([
        invoke<UsageSummary>('get_usage_summary', {}),
        invoke<ModelUsageStats[]>('get_usage_model_stats', {}),
        invoke<UsageLogEntry[]>('get_usage_recent_logs', { limit: 10 }),
      ])
      set({
        cachedSummary: summary,
        cachedModelStats: modelStats,
        cachedTopSessions: topSessions,
        loaded: true,
      })
      log.info('Token 统计数据已加载', { totalRequests: summary.totalRequests })
    } catch (e) {
      log.warn('Token 统计加载失败: ' + String(e))
      set({ loaded: true })
    }
  },

  refreshData: async () => {
    set({ cachedSummary: null, cachedModelStats: null, cachedTopSessions: null, loaded: false })
    return get().loadData()
  },

  getSummary: () => {
    return get().cachedSummary ?? {
      totalRequests: 0, totalInputTokens: 0, totalOutputTokens: 0,
      totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalCostUsd: 0,
    }
  },

  getModelStats: () => get().cachedModelStats ?? [],

  getTopSessions: (_limit = 10) => get().cachedTopSessions ?? [],

  getDailyTrends: async (range: TimeRange) => {
    const { startDate, endDate } = timeRangeToDates(range)
    try {
      return await invoke<DailyUsageStats[]>('get_usage_daily_trends', { startDate, endDate })
    } catch {
      return []
    }
  },
}))