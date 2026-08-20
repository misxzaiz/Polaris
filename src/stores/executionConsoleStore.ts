/**
 * AI 执行控制台 Store
 *
 * 纯只读观测层的聚合中心：
 * - 集成（QQ/飞书）AI 执行状态：聚合 integration:message / integration:ai:delta /
 *   integration:ai:complete / integration:ai:error 四个后端事件
 * - 统一执行历史时间线：集成执行完成后写入；scheduler 完成状态由面板层
 *   从 schedulerStore 派生展示，不在此处复制
 *
 * chat / scheduler 的实时状态不在本 store 复制，UI 直接订阅源 store
 * （sessionStoreManager / schedulerStore），避免状态漂移。
 */

import { create } from 'zustand'
import { listen } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import type { Platform, IntegrationMessage } from '@/types'
import { getMessageText } from '@/types/integration'
import {
  type IntegrationRun,
  type ExecutionHistoryEntry,
  HISTORY_MAX_ENTRIES,
  toPreview,
} from '@/types/executionConsole'

const log = createLogger('ExecutionConsoleStore')

/** integration:ai:delta 事件载荷 */
interface IntegrationAiDeltaPayload {
  conversationId: string
  text: string
  isDelta?: boolean
}

/** integration:ai:complete 事件载荷 */
interface IntegrationAiCompletePayload {
  conversationId: string
  sessionId?: string
  text?: string
}

/** integration:ai:error 事件载荷 */
interface IntegrationAiErrorPayload {
  conversationId: string
  error?: string
}

interface ExecutionConsoleState {
  /** 集成 AI 执行（conversationId -> run），含运行中与最近结束的 */
  integrationRuns: Map<string, IntegrationRun>
  /** 统一执行历史（新→旧，cap HISTORY_MAX_ENTRIES） */
  history: ExecutionHistoryEntry[]
  /** 监听器是否已安装 */
  initialized: boolean
  /** 监听器清理函数 */
  _unlistenFns: Array<() => void>

  /** 安装全局事件监听（App 级调用一次，面板未打开也累计） */
  initialize: () => Promise<void>
  /** 清理监听器（测试/卸载用） */
  cleanup: () => void
  /** 写入一条历史（自动裁剪到上限） */
  addHistoryEntry: (entry: ExecutionHistoryEntry) => void
  /** 清空历史 */
  clearHistory: () => void

  // 内部事件处理（导出以便单测直接驱动）
  _onIntegrationMessage: (msg: IntegrationMessage) => void
  _onIntegrationAiDelta: (payload: IntegrationAiDeltaPayload) => void
  _onIntegrationAiComplete: (payload: IntegrationAiCompletePayload) => void
  _onIntegrationAiError: (payload: IntegrationAiErrorPayload) => void
}

/** 历史条目 ID 生成 */
function historyId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const useExecutionConsoleStore = create<ExecutionConsoleState>((set, get) => ({
  integrationRuns: new Map(),
  history: [],
  initialized: false,
  _unlistenFns: [],

  initialize: async () => {
    if (get().initialized) return
    set({ initialized: true })

    try {
      const unlistenFns = await Promise.all([
        listen<IntegrationMessage>('integration:message', (msg) => {
          get()._onIntegrationMessage(msg)
        }),
        listen<IntegrationAiDeltaPayload>('integration:ai:delta', (payload) => {
          get()._onIntegrationAiDelta(payload)
        }),
        listen<IntegrationAiCompletePayload>('integration:ai:complete', (payload) => {
          get()._onIntegrationAiComplete(payload)
        }),
        listen<IntegrationAiErrorPayload>('integration:ai:error', (payload) => {
          get()._onIntegrationAiError(payload)
        }),
      ])
      set({ _unlistenFns: unlistenFns })
      log.info('集成执行监听器已安装')
    } catch (e) {
      set({ initialized: false })
      log.error('安装集成执行监听器失败', e instanceof Error ? e : new Error(String(e)))
    }
  },

  cleanup: () => {
    get()._unlistenFns.forEach((fn) => fn())
    set({ _unlistenFns: [], initialized: false })
  },

  addHistoryEntry: (entry) => {
    set((state) => ({
      history: [entry, ...state.history].slice(0, HISTORY_MAX_ENTRIES),
    }))
  },

  clearHistory: () => set({ history: [] }),

  // === 集成事件处理 ===

  // 收到外部消息：即将触发 AI，登记为 running
  _onIntegrationMessage: (msg) => {
    if (!msg?.conversationId) return
    const now = Date.now()
    set((state) => {
      const runs = new Map(state.integrationRuns)
      runs.set(msg.conversationId, {
        conversationId: msg.conversationId,
        platform: msg.platform as Platform,
        senderName: msg.senderName || msg.senderId || '',
        promptPreview: toPreview(getMessageText(msg.content)),
        lastOutputPreview: '',
        status: 'running',
        startedAt: now,
        lastActivityAt: now,
      })
      return { integrationRuns: runs }
    })
  },

  // AI 流式输出：更新预览与活动时间（只截断保存，无累积，控制开销）
  _onIntegrationAiDelta: (payload) => {
    if (!payload?.conversationId) return
    set((state) => {
      const existing = state.integrationRuns.get(payload.conversationId)
      if (!existing) return state
      const runs = new Map(state.integrationRuns)
      runs.set(payload.conversationId, {
        ...existing,
        status: 'running',
        lastOutputPreview: toPreview(payload.text || existing.lastOutputPreview),
        lastActivityAt: Date.now(),
      })
      return { integrationRuns: runs }
    })
  },

  // AI 处理完成：标记成功并写入历史
  _onIntegrationAiComplete: (payload) => {
    if (!payload?.conversationId) return
    const now = Date.now()
    const existing = get().integrationRuns.get(payload.conversationId)

    set((state) => {
      const runs = new Map(state.integrationRuns)
      const base = state.integrationRuns.get(payload.conversationId)
      if (base) {
        runs.set(payload.conversationId, {
          ...base,
          status: 'success',
          sessionId: payload.sessionId,
          lastOutputPreview: payload.text ? toPreview(payload.text) : base.lastOutputPreview,
          lastActivityAt: now,
          endedAt: now,
        })
      }
      return { integrationRuns: runs }
    })

    get().addHistoryEntry({
      id: historyId('integration'),
      origin: 'integration',
      platform: existing?.platform,
      title: existing?.senderName || payload.conversationId,
      summary: payload.text ? toPreview(payload.text) : existing?.promptPreview || '',
      status: 'success',
      startedAt: existing?.startedAt ?? now,
      endedAt: now,
    })
  },

  // AI 处理失败：标记失败并写入历史
  _onIntegrationAiError: (payload) => {
    if (!payload?.conversationId) return
    const now = Date.now()
    const existing = get().integrationRuns.get(payload.conversationId)

    set((state) => {
      const runs = new Map(state.integrationRuns)
      const base = state.integrationRuns.get(payload.conversationId)
      if (base) {
        runs.set(payload.conversationId, {
          ...base,
          status: 'failed',
          error: payload.error,
          lastActivityAt: now,
          endedAt: now,
        })
      }
      return { integrationRuns: runs }
    })

    get().addHistoryEntry({
      id: historyId('integration'),
      origin: 'integration',
      platform: existing?.platform,
      title: existing?.senderName || payload.conversationId,
      summary: existing?.promptPreview || '',
      status: 'failed',
      startedAt: existing?.startedAt ?? now,
      endedAt: now,
      error: payload.error,
    })
  },
}))

/** App 级初始化入口（useAppEvents 调用） */
export async function initExecutionConsoleListeners(): Promise<void> {
  await useExecutionConsoleStore.getState().initialize()
}

// === 选择器 ===

// 以 Map 引用为键缓存派生数组，保证 selector 返回稳定引用
// （否则 useSyncExternalStore 会因 snapshot 每次变化而无限重渲染，
// 同 sessionStoreManager.useSessionMetadataList 的处理方式）
let cachedRunsMap: Map<string, IntegrationRun> | null = null
let cachedActiveRuns: IntegrationRun[] | null = null

/** 运行中的集成执行列表（新→旧） */
export const selectActiveIntegrationRuns = (state: ExecutionConsoleState): IntegrationRun[] => {
  if (state.integrationRuns === cachedRunsMap && cachedActiveRuns !== null) {
    return cachedActiveRuns
  }
  cachedRunsMap = state.integrationRuns
  cachedActiveRuns = Array.from(state.integrationRuns.values())
    .filter((run) => run.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
  return cachedActiveRuns
}
