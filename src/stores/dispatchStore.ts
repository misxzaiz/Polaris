/**
 * 派发任务前端状态层
 *
 * 为 DispatchTaskCard（来源会话内联卡片）和结果回流提供实时视图：
 * - tasks：dispatchId → 任务视图（状态/耗时/最新动作/结论摘要）
 * - pendingReports：sourceSessionId → 待注入报告队列。任务完成时入队，
 *   来源会话下次 sendMessage 时经一次性系统提示带出（takeReports 消费即清）。
 *   队列放在本 store 而非会话 store 字段，来源会话被 LRU 驱逐也不丢报告。
 *
 * 维护方：dispatchTaskService（事件 handler 内顺手更新）。
 */

import { create } from 'zustand'

export type DispatchTaskStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface DispatchTaskView {
  dispatchId: string
  /** 目标会话 ID（dispatch-{depth}-{id}） */
  sessionId: string
  sourceSessionId: string
  title: string
  status: DispatchTaskStatus
  engineId?: string
  model?: string
  /** 队员角色名（P2 预设派发时携带） */
  role?: string
  /** 执行工作目录（续派时复用） */
  workDir?: string
  startedAt: number
  endedAt?: number
  /** 单行最新动作摘要（仅 tool 边界更新） */
  latestActivity?: string
  /** 终态结论摘要 */
  summary?: string
  error?: string
  /** 结构化 verdict(resultSchema 派发完成后由后端解析回填,U1-2) */
  verdict?: Record<string, unknown>
  verdictStatus?: 'structured' | 'unstructured'
}

export interface DispatchReport {
  dispatchId: string
  title: string
  status: 'completed' | 'failed'
  summary?: string
}

interface DispatchState {
  tasks: Map<string, DispatchTaskView>
  pendingReports: Map<string, DispatchReport[]>

  upsertTask: (task: DispatchTaskView) => void
  updateTask: (dispatchId: string, patch: Partial<DispatchTaskView>) => void
  /** 任务进入终态：更新视图 + 报告入队 */
  finishTask: (
    dispatchId: string,
    status: 'completed' | 'failed',
    summary?: string,
    error?: string
  ) => void
  /** 取走并清空某来源会话的待注入报告 */
  takeReports: (sourceSessionId: string) => DispatchReport[]
  /** 移除单条待注入报告（如一键交办后避免重复注入） */
  removeReport: (sourceSessionId: string, dispatchId: string) => void
  /** 查询某来源会话是否有待注入报告（不消费） */
  hasReports: (sourceSessionId: string) => boolean
  getTask: (dispatchId: string) => DispatchTaskView | undefined
  getTaskBySessionId: (sessionId: string) => DispatchTaskView | undefined
}

export const useDispatchStore = create<DispatchState>((set, get) => ({
  tasks: new Map(),
  pendingReports: new Map(),

  upsertTask: (task) => {
    set((state) => {
      const tasks = new Map(state.tasks)
      tasks.set(task.dispatchId, task)
      return { tasks }
    })
  },

  updateTask: (dispatchId, patch) => {
    set((state) => {
      const existing = state.tasks.get(dispatchId)
      if (!existing) return state
      const tasks = new Map(state.tasks)
      tasks.set(dispatchId, { ...existing, ...patch })
      return { tasks }
    })
  },

  finishTask: (dispatchId, status, summary, error) => {
    const existing = get().tasks.get(dispatchId)
    set((state) => {
      const tasks = new Map(state.tasks)
      const current = state.tasks.get(dispatchId)
      if (current) {
        tasks.set(dispatchId, {
          ...current,
          status,
          summary: summary ?? current.summary,
          error,
          endedAt: Date.now(),
          latestActivity: undefined,
        })
      }

      // 报告入队（无视图记录也入队——重启恢复等场景仍能回流）
      const sourceSessionId = current?.sourceSessionId || existing?.sourceSessionId
      if (!sourceSessionId) return { tasks }
      const pendingReports = new Map(state.pendingReports)
      const queue = [...(pendingReports.get(sourceSessionId) || [])]
      queue.push({
        dispatchId,
        title: current?.title || dispatchId,
        status,
        summary,
      })
      pendingReports.set(sourceSessionId, queue)
      return { tasks, pendingReports }
    })
  },

  takeReports: (sourceSessionId) => {
    const reports = get().pendingReports.get(sourceSessionId) || []
    if (reports.length > 0) {
      set((state) => {
        const pendingReports = new Map(state.pendingReports)
        pendingReports.delete(sourceSessionId)
        return { pendingReports }
      })
    }
    return reports
  },

  removeReport: (sourceSessionId, dispatchId) => {
    set((state) => {
      const queue = state.pendingReports.get(sourceSessionId)
      if (!queue?.length) return state
      const filtered = queue.filter((r) => r.dispatchId !== dispatchId)
      if (filtered.length === queue.length) return state
      const pendingReports = new Map(state.pendingReports)
      if (filtered.length === 0) {
        pendingReports.delete(sourceSessionId)
      } else {
        pendingReports.set(sourceSessionId, filtered)
      }
      return { pendingReports }
    })
  },

  hasReports: (sourceSessionId) => {
    return (get().pendingReports.get(sourceSessionId)?.length ?? 0) > 0
  },

  getTask: (dispatchId) => get().tasks.get(dispatchId),

  getTaskBySessionId: (sessionId) => {
    for (const task of get().tasks.values()) {
      if (task.sessionId === sessionId) return task
    }
    return undefined
  },
}))

/** 供 React 组件按 dispatchId 订阅单个任务视图 */
export function useDispatchTask(dispatchId: string | null): DispatchTaskView | undefined {
  return useDispatchStore((state) => (dispatchId ? state.tasks.get(dispatchId) : undefined))
}
