/**
 * Token 用量统计 Store
 *
 * 数据源：DialogStorage 中每个会话的 DialogMeta.tokenUsage（由后端 saveDialog 轮末写入 JSONL）。
 * 读取方式：首次调用 getData() 时从 JSONL 加载并缓存，后续直读缓存。
 * 数据覆盖：常规 UI 会话（经 eventHandler → saveDialog）和调度任务（subscribe: true 后同样经 saveDialog）都会落盘。
 *
 * 性能：首次加载走一次 listConversations（读 meta 首行），之后纯内存。无 persist，无冗余 pushSession。
 */

import { create } from 'zustand'
import { dialogStorageService } from '@/services/dialogStorage'
import type { TokenUsageSummary } from '@/services/dialogStorage'
import { createLogger } from '@/utils/logger'

const log = createLogger('TokenAnalyticsStore')

// ============================================================================
// 类型定义
// ============================================================================

export interface SessionTokenUsage {
  sessionId: string
  title: string
  engineId: string
  createdAt: string
  updatedAt: string
  tokenUsage: TokenUsageSummary
}

export interface TotalStats {
  totalSessions: number
  totalInput: number
  totalOutput: number
  totalCacheCreation: number
  totalCacheRead: number
  totalCostUsd: number
}

export interface ModelStats {
  model: string
  sessions: number
  input: number
  output: number
  cacheCreation: number
  cacheRead: number
  costUsd: number
}

export interface EngineStats {
  engineId: string
  sessions: number
  input: number
  output: number
  costUsd: number
}

export type TimeRange = 'day' | 'week' | 'month' | 'all'

// ============================================================================
// Store
// ============================================================================

interface TokenAnalyticsState {
  /** 缓存的有效会话列表（null = 未加载） */
  sessions: SessionTokenUsage[] | null
  /** 是否已加载过 */
  loaded: boolean

  /** 从 JSONL 加载/刷新数据，返回缓存后的会话列表 */
  loadData: () => Promise<SessionTokenUsage[]>
  /** 强制刷新缓存 */
  refreshData: () => Promise<SessionTokenUsage[]>
  /** 清除缓存 */
  clearCache: () => void

  // 查询函数（纯函数，依赖 sessions 快照）
  getTotalStats: () => TotalStats
  getByModel: () => ModelStats[]
  getByTimeRange: (range: TimeRange) => { labels: string[]; input: number[]; output: number[]; costUsd: number[]; sessions: number[] }
  getTopSessions: (limit?: number) => SessionTokenUsage[]
  getEngineDistribution: () => EngineStats[]
}

export const useTokenAnalyticsStore = create<TokenAnalyticsState>((set, get) => ({
  sessions: null,
  loaded: false,

  loadData: async () => {
    const state = get()
    if (state.sessions) return state.sessions // 缓存有效

    try {
      const result = await dialogStorageService.listConversations({ pageSize: 9999, sortOrder: 'desc' })
      const sessions: SessionTokenUsage[] = []

      for (const meta of result.items) {
        const usage = meta.tokenUsage as TokenUsageSummary | undefined
        if (!usage) continue
        if (usage.input === 0 && usage.output === 0) continue
        sessions.push({
          sessionId: meta.externalId,
          title: meta.title || '(无标题)',
          engineId: meta.engineId,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt,
          tokenUsage: usage,
        })
      }

      set({ sessions, loaded: true })
      log.info('Token 统计数据已加载', { sessionCount: sessions.length })
      return sessions
    } catch (e) {
      log.warn('Token 统计加载失败（降级为空数据）' + String(e))
      set({ sessions: [], loaded: true })
      return []
    }
  },

  refreshData: async () => {
    set({ sessions: null })
    return get().loadData()
  },

  clearCache: () => set({ sessions: null, loaded: false }),

  getTotalStats: () => {
    const { sessions } = get()
    if (!sessions) return { totalSessions: 0, totalInput: 0, totalOutput: 0, totalCacheCreation: 0, totalCacheRead: 0, totalCostUsd: 0 }
    return sessions.reduce(
      (acc, s) => {
        acc.totalSessions++
        acc.totalInput += s.tokenUsage.input
        acc.totalOutput += s.tokenUsage.output
        acc.totalCacheCreation += s.tokenUsage.cacheCreation
        acc.totalCacheRead += s.tokenUsage.cacheRead
        acc.totalCostUsd += s.tokenUsage.costUsd
        return acc
      },
      { totalSessions: 0, totalInput: 0, totalOutput: 0, totalCacheCreation: 0, totalCacheRead: 0, totalCostUsd: 0 },
    )
  },

  getByModel: () => {
    const { sessions } = get()
    if (!sessions) return []
    const modelMap = new Map<string, ModelStats>()
    for (const session of sessions) {
      const bd = session.tokenUsage.modelBreakdown
      if (!bd || Object.keys(bd).length === 0) {
        const key = 'unknown'
        const existing = modelMap.get(key)
        if (existing) {
          existing.sessions++; existing.input += session.tokenUsage.input; existing.output += session.tokenUsage.output
          existing.cacheCreation += session.tokenUsage.cacheCreation; existing.cacheRead += session.tokenUsage.cacheRead; existing.costUsd += session.tokenUsage.costUsd
        } else {
          modelMap.set(key, { model: key, sessions: 1, input: session.tokenUsage.input, output: session.tokenUsage.output, cacheCreation: session.tokenUsage.cacheCreation, cacheRead: session.tokenUsage.cacheRead, costUsd: session.tokenUsage.costUsd })
        }
        continue
      }
      for (const [model, usage] of Object.entries(bd)) {
        const m = usage as NonNullable<TokenUsageSummary['modelBreakdown']>[string]
        const existing = modelMap.get(model)
        if (existing) {
          existing.sessions++; existing.input += m.input; existing.output += m.output
          existing.cacheCreation += m.cacheCreation; existing.cacheRead += m.cacheRead; existing.costUsd += m.costUsd
        } else {
          modelMap.set(model, { model, sessions: 1, input: m.input, output: m.output, cacheCreation: m.cacheCreation, cacheRead: m.cacheRead, costUsd: m.costUsd })
        }
      }
    }
    return Array.from(modelMap.values()).sort((a, b) => b.costUsd - a.costUsd)
  },

  getByTimeRange: (range: TimeRange) => {
    const { sessions } = get()
    if (!sessions) return { labels: [], input: [], output: [], costUsd: [], sessions: [] }
    const buckets = new Map<string, { input: number; output: number; costUsd: number; sessions: number }>()
    for (const session of sessions) {
      const date = new Date(session.updatedAt)
      let label: string
      switch (range) {
        case 'day': label = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; break
        case 'week': label = getISOWeekLabel(date); break
        case 'month': label = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; break
        default: label = '全部'
      }
      const existing = buckets.get(label)
      if (existing) {
        existing.input += session.tokenUsage.input; existing.output += session.tokenUsage.output
        existing.costUsd += session.tokenUsage.costUsd; existing.sessions++
      } else {
        buckets.set(label, { input: session.tokenUsage.input, output: session.tokenUsage.output, costUsd: session.tokenUsage.costUsd, sessions: 1 })
      }
    }
    const sortedLabels = Array.from(buckets.keys()).sort((a, b) => {
      if (range === 'all') return 0
      return a.localeCompare(b)
    })
    return {
      labels: sortedLabels,
      input: sortedLabels.map((l) => buckets.get(l)!.input),
      output: sortedLabels.map((l) => buckets.get(l)!.output),
      costUsd: sortedLabels.map((l) => buckets.get(l)!.costUsd),
      sessions: sortedLabels.map((l) => buckets.get(l)!.sessions),
    }
  },

  getTopSessions: (limit = 10) => {
    const { sessions } = get()
    if (!sessions) return []
    return [...sessions].sort((a, b) => b.tokenUsage.input - a.tokenUsage.input).slice(0, limit)
  },

  getEngineDistribution: () => {
    const { sessions } = get()
    if (!sessions) return []
    const engineMap = new Map<string, EngineStats>()
    for (const session of sessions) {
      const key = session.engineId || 'unknown'
      const existing = engineMap.get(key)
      if (existing) {
        existing.sessions++; existing.input += session.tokenUsage.input; existing.output += session.tokenUsage.output; existing.costUsd += session.tokenUsage.costUsd
      } else {
        engineMap.set(key, { engineId: key, sessions: 1, input: session.tokenUsage.input, output: session.tokenUsage.output, costUsd: session.tokenUsage.costUsd })
      }
    }
    return Array.from(engineMap.values()).sort((a, b) => b.input - a.input)
  },
}))

// ============================================================================
// 辅助函数
// ============================================================================

function getISOWeekLabel(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`
}