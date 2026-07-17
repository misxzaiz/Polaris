/**
 * 会话历史体验偏好（本地持久化）
 *
 * 控制历史面板与恢复路径的可配置项：
 * - listPageSize：历史列表每页条数
 * - restorePageSize：恢复会话时首屏加载的消息条数（更早消息向上滚动按需补读）
 * - recentCards：「继续工作」区展示的最近活跃会话卡片数
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface HistoryPrefsState {
  listPageSize: number
  restorePageSize: number
  recentCards: number
  setListPageSize: (n: number) => void
  setRestorePageSize: (n: number) => void
  setRecentCards: (n: number) => void
}

const clamp = (n: number, min: number, max: number): number =>
  Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : min

export const HISTORY_PREFS_LIMITS = {
  listPageSize: { min: 10, max: 100, default: 20 },
  restorePageSize: { min: 20, max: 500, default: 50 },
  recentCards: { min: 0, max: 10, default: 5 },
} as const

export const useHistoryPrefsStore = create<HistoryPrefsState>()(
  persist(
    (set) => ({
      listPageSize: HISTORY_PREFS_LIMITS.listPageSize.default,
      restorePageSize: HISTORY_PREFS_LIMITS.restorePageSize.default,
      recentCards: HISTORY_PREFS_LIMITS.recentCards.default,
      setListPageSize: (n) =>
        set({
          listPageSize: clamp(
            n,
            HISTORY_PREFS_LIMITS.listPageSize.min,
            HISTORY_PREFS_LIMITS.listPageSize.max,
          ),
        }),
      setRestorePageSize: (n) =>
        set({
          restorePageSize: clamp(
            n,
            HISTORY_PREFS_LIMITS.restorePageSize.min,
            HISTORY_PREFS_LIMITS.restorePageSize.max,
          ),
        }),
      setRecentCards: (n) =>
        set({
          recentCards: clamp(
            n,
            HISTORY_PREFS_LIMITS.recentCards.min,
            HISTORY_PREFS_LIMITS.recentCards.max,
          ),
        }),
    }),
    { name: 'polaris-history-prefs' },
  ),
)
