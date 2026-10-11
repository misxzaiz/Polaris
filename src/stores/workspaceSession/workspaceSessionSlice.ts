/**
 * Workspace 会话桶管理器（S2 · 对齐 ZCode zcodeSessionStoreWorkspaceSlice）
 *
 * 设计（spec §3.1 / §6 风险控制）：
 * - 这是 sessionStoreManager 之上的**薄投影层**，不接管会话 store 的内部状态。
 *   桶只记录「该 workspace 下有哪些会话 + 桶内活跃指针」，会话 store 实例
 *   仍由 sessionStoreManager 统一创建/销毁（复用旧逻辑，避免回归）。
 * - 旧全局 `activeSessionId` 语义保留为「默认桶的活跃会话」，向后兼容。
 * - 多窗口/多端：`switchSession(workspaceKey, sessionId)` 写对应桶的 activeSessionId，
 *   不再有全局单一活跃会话互踩。
 * - 事件路由未知桶：`ensureBucket(workspaceKey)` 懒加载，不再丢事件（spec §4 迁移要点 3）。
 *
 * 本模块为**阶段 1（桶化）**：只引入桶结构 + 活跃指针分桶，不迁移状态来源。
 * 阶段 2（逐步迁移状态来源到后端投影）在 S3 接通后进行。
 */

import { create } from 'zustand'
import type { SessionMetadata } from '../conversationStore/types'
import type { WorkspaceSessionBucket } from './types'
import { FREE_WORKSPACE_KEY } from './types'
import { resolveWorkspaceKeyFromPath } from './workspaceKey'
import { createLogger } from '@/utils/logger'

const log = createLogger('WorkspaceSessionSlice')

// ============================================================================
// 桶管理 Store 类型
// ============================================================================

export interface WorkspaceSessionSliceState {
  /** workspace → 桶 */
  buckets: Map<string, WorkspaceSessionBucket>
  /** 当前激活的 workspaceKey（决定 useActiveSession 默认读哪个桶） */
  activeWorkspaceKey: string
}

export interface WorkspaceSessionSliceActions {
  /** 确保 workspace 桶存在（懒加载；未知桶事件路由时调用，不再丢事件） */
  ensureBucket: (workspaceKey: string) => WorkspaceSessionBucket
  /** 获取桶（不存在返回 null，不创建） */
  getBucket: (workspaceKey: string) => WorkspaceSessionBucket | null
  /** 获取或创建桶（ensureBucket 的语义别名，供外部显式表达意图） */
  getOrCreateBucket: (workspaceKey: string) => WorkspaceSessionBucket
  /** 注册会话到桶（createSession 后调用，建立桶归属） */
  registerSession: (
    workspaceKey: string,
    sessionId: string,
    metadata: SessionMetadata,
  ) => void
  /** 从桶移除会话（deleteSession 时同步清理桶归属） */
  unregisterSession: (workspaceKey: string, sessionId: string) => void
  /** 更新桶内会话元数据 */
  updateSessionMetadata: (
    workspaceKey: string,
    sessionId: string,
    updates: Partial<SessionMetadata>,
  ) => void
  /** 切换桶内活跃会话（多窗口不互踩） */
  switchSessionInBucket: (workspaceKey: string, sessionId: string | null) => void
  /** 设置当前激活 workspace（workspace 切换时调用） */
  setActiveWorkspace: (workspaceKey: string) => void
  /** 获取所有桶的活跃会话（多窗口多端视图） */
  getAllActive: () => Array<{ workspaceKey: string; activeSessionId: string | null }>
  /** 获取某桶的活跃会话 */
  getActiveSessionId: (workspaceKey: string) => string | null
  /** 重置（测试用） */
  reset: () => void
}

export type WorkspaceSessionSliceStore = WorkspaceSessionSliceState &
  WorkspaceSessionSliceActions

// ============================================================================
// 实现
// ============================================================================

function createEmptyBucket(workspaceKey: string): WorkspaceSessionBucket {
  return {
    workspaceKey,
    sessions: new Map(),
    activeSessionId: null,
    sessionMetadata: new Map(),
    backgroundSessionIds: [],
    completedNotifications: [],
  }
}

export const workspaceSessionSlice = create<WorkspaceSessionSliceStore>((set, get) => ({
  buckets: new Map([[FREE_WORKSPACE_KEY, createEmptyBucket(FREE_WORKSPACE_KEY)]]),
  activeWorkspaceKey: FREE_WORKSPACE_KEY,

  ensureBucket: (workspaceKey: string) => {
    const existing = get().buckets.get(workspaceKey)
    if (existing) return existing
    const bucket = createEmptyBucket(workspaceKey)
    set((state) => {
      const newBuckets = new Map(state.buckets)
      newBuckets.set(workspaceKey, bucket)
      return { buckets: newBuckets }
    })
    log.info('ensureBucket 创建桶', { workspaceKey })
    return bucket
  },

  getBucket: (workspaceKey: string) => {
    return get().buckets.get(workspaceKey) ?? null
  },

  getOrCreateBucket: (workspaceKey: string) => {
    return get().ensureBucket(workspaceKey)
  },

  registerSession: (workspaceKey, sessionId, metadata) => {
    get().ensureBucket(workspaceKey)
    set((state) => {
      const newBuckets = new Map(state.buckets)
      const bucket = newBuckets.get(workspaceKey)!
      const newSessions = new Map(bucket.sessions)
      // sessions Map 只存 sessionId 标记归属；实际 store 实例仍在 sessionStoreManager.stores
      // 阶段 1 不双写 store 引用，只记归属（避免引用生命周期混乱）
      newSessions.set(sessionId, null as never) // 标记位：归属此桶（实际 store 从 manager 取）
      const newMetadata = new Map(bucket.sessionMetadata)
      newMetadata.set(sessionId, { ...metadata })
      newBuckets.set(workspaceKey, {
        ...bucket,
        sessions: newSessions,
        sessionMetadata: newMetadata,
      })
      return { buckets: newBuckets }
    })
  },

  unregisterSession: (workspaceKey, sessionId) => {
    set((state) => {
      const bucket = state.buckets.get(workspaceKey)
      if (!bucket) return state
      const newBuckets = new Map(state.buckets)
      const newSessions = new Map(bucket.sessions)
      newSessions.delete(sessionId)
      const newMetadata = new Map(bucket.sessionMetadata)
      newMetadata.delete(sessionId)
      const newBackground = bucket.backgroundSessionIds.filter((id) => id !== sessionId)
      const newNotifications = bucket.completedNotifications.filter((id) => id !== sessionId)
      const newActive = bucket.activeSessionId === sessionId ? null : bucket.activeSessionId
      newBuckets.set(workspaceKey, {
        ...bucket,
        sessions: newSessions,
        sessionMetadata: newMetadata,
        backgroundSessionIds: newBackground,
        completedNotifications: newNotifications,
        activeSessionId: newActive,
      })
      return { buckets: newBuckets }
    })
  },

  updateSessionMetadata: (workspaceKey, sessionId, updates) => {
    set((state) => {
      const bucket = state.buckets.get(workspaceKey)
      if (!bucket) return state
      const existing = bucket.sessionMetadata.get(sessionId)
      if (!existing) return state
      const newBuckets = new Map(state.buckets)
      const newMetadata = new Map(bucket.sessionMetadata)
      newMetadata.set(sessionId, {
        ...existing,
        ...updates,
        updatedAt: new Date().toISOString(),
      })
      newBuckets.set(workspaceKey, { ...bucket, sessionMetadata: newMetadata })
      return { buckets: newBuckets }
    })
  },

  switchSessionInBucket: (workspaceKey, sessionId) => {
    get().ensureBucket(workspaceKey)
    set((state) => {
      const bucket = state.buckets.get(workspaceKey)!
      if (sessionId !== null && !bucket.sessions.has(sessionId)) {
        log.warn('switchSessionInBucket: 会话不在桶内', { workspaceKey, sessionId })
        return state
      }
      const newBuckets = new Map(state.buckets)
      newBuckets.set(workspaceKey, { ...bucket, activeSessionId: sessionId })
      return { buckets: newBuckets, activeWorkspaceKey: workspaceKey }
    })
  },

  setActiveWorkspace: (workspaceKey: string) => {
    get().ensureBucket(workspaceKey)
    set({ activeWorkspaceKey: workspaceKey })
  },

  getAllActive: () => {
    const buckets = get().buckets
    const result: Array<{ workspaceKey: string; activeSessionId: string | null }> = []
    for (const [key, bucket] of buckets) {
      result.push({ workspaceKey: key, activeSessionId: bucket.activeSessionId })
    }
    return result
  },

  getActiveSessionId: (workspaceKey: string) => {
    return get().buckets.get(workspaceKey)?.activeSessionId ?? null
  },

  reset: () => {
    set({
      buckets: new Map([[FREE_WORKSPACE_KEY, createEmptyBucket(FREE_WORKSPACE_KEY)]]),
      activeWorkspaceKey: FREE_WORKSPACE_KEY,
    })
  },
}))

// ============================================================================
// 便捷工具
// ============================================================================

/**
 * 从 workspace path 解析 key 并确保桶存在。
 * 供 sessionStoreManager.createSession 注册时使用。
 */
export function ensureBucketForPath(path: string | null | undefined): string {
  const key = resolveWorkspaceKeyFromPath(path)
  workspaceSessionSlice.getState().ensureBucket(key)
  return key
}

/**
 * 获取当前激活 workspaceKey 的活跃会话 ID。
 * 供 useActiveSession 默认场景（无显式 workspaceKey）使用。
 */
export function getActiveSessionIdForActiveWorkspace(): string | null {
  const state = workspaceSessionSlice.getState()
  return state.getActiveSessionId(state.activeWorkspaceKey)
}
