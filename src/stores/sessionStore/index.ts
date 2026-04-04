/**
 * SessionStore - 多会话状态管理
 *
 * 核心职责：
 * 1. 管理多个独立会话的状态
 * 2. 处理会话切换和隔离
 * 3. 管理会话与工作区的关系
 */

import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type {
  ChatSession,
  CreateSessionOptions,
  SessionStatus,
  WorkspaceSwitchMode,
  IslandExpandMode,
  SessionMessageState
} from '@/types/session'

// ============================================================================
// 类型定义
// ============================================================================

export interface SessionState {
  /** 所有会话 */
  sessions: Map<string, ChatSession>
  /** 当前活跃会话 ID */
  activeSessionId: string | null
  /** 最近使用的会话 ID（用于悬浮岛列表） */
  recentSessionIds: string[]
  /** 悬浮岛是否展开 */
  isIslandExpanded: boolean
  /** 悬浮岛展开模式 */
  islandExpandMode: IslandExpandMode
  /** 会话消息状态（按 sessionId 隔离） */
  sessionMessages: Map<string, SessionMessageState>
}

export interface SessionActions {
  // 会话操作
  createSession: (options: CreateSessionOptions) => string
  switchSession: (id: string) => void
  closeSession: (id: string) => void
  deleteSession: (id: string) => void
  renameSession: (id: string, title: string) => void
  updateSessionStatus: (id: string, status: SessionStatus) => void
  incrementMessageCount: (id: string) => void

  // 工作区操作
  switchSessionWorkspace: (sessionId: string, workspaceId: string, mode: WorkspaceSwitchMode) => void
  addContextWorkspace: (sessionId: string, workspaceId: string) => void
  removeContextWorkspace: (sessionId: string, workspaceId: string) => void

  // 悬浮岛操作
  toggleIsland: () => void
  setIslandExpandMode: (mode: IslandExpandMode) => void
  collapseIsland: () => void

  // 查询方法
  getActiveSession: () => ChatSession | null
  getRecentSessions: (limit: number) => ChatSession[]
  getSessionMessages: (sessionId: string) => SessionMessageState | undefined
  setSessionMessages: (sessionId: string, state: SessionMessageState) => void
}

export type SessionStore = SessionState & SessionActions

// ============================================================================
// 辅助函数
// ============================================================================

/** 生成会话 ID */
const generateSessionId = (): string => {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
}

/** 生成默认标题 */
const generateDefaultTitle = (): string => {
  return `新会话 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
}

/** 创建初始消息状态 */
const createInitialMessageState = (): SessionMessageState => ({
  messages: [],
  archivedMessages: [],
  conversationId: null,
})

// ============================================================================
// Store 实现
// ============================================================================

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      // ========== 初始状态 ==========
      sessions: new Map(),
      activeSessionId: null,
      recentSessionIds: [],
      isIslandExpanded: false,
      islandExpandMode: null,
      sessionMessages: new Map(),

      // ========== 会话操作 ==========

      createSession: (options: CreateSessionOptions) => {
        const id = generateSessionId()
        const now = new Date().toISOString()

        const session: ChatSession = {
          id,
          title: options.title || generateDefaultTitle(),
          type: options.type,
          status: 'idle',
          engineId: options.engineId || 'claude-code',
          workspaceId: options.type === 'project' ? (options.workspaceId || null) : null,
          temporaryWorkspaceId: null,
          contextWorkspaceIds: [],
          createdAt: now,
          updatedAt: now,
          lastMessageAt: null,
          messageCount: 0,
        }

        set((state) => {
          const newSessions = new Map(state.sessions)
          newSessions.set(id, session)

          const newSessionMessages = new Map(state.sessionMessages)
          newSessionMessages.set(id, createInitialMessageState())

          return {
            sessions: newSessions,
            sessionMessages: newSessionMessages,
            activeSessionId: id,
            recentSessionIds: [id, ...state.recentSessionIds.filter(rid => rid !== id)].slice(0, 10),
          }
        })

        return id
      },

      switchSession: (id: string) => {
        const { sessions } = get()
        if (!sessions.has(id)) return

        set((state) => ({
          activeSessionId: id,
          recentSessionIds: [id, ...state.recentSessionIds.filter(rid => rid !== id)].slice(0, 10),
          isIslandExpanded: false,
          islandExpandMode: null,
        }))
      },

      closeSession: (id: string) => {
        const { activeSessionId, sessions } = get()

        // 从最近使用列表中移除
        set((state) => ({
          recentSessionIds: state.recentSessionIds.filter(rid => rid !== id),
        }))

        // 如果关闭的是当前活跃会话，切换到其他会话
        if (activeSessionId === id) {
          const otherSessionIds = Array.from(sessions.keys()).filter(sid => sid !== id)
          set({
            activeSessionId: otherSessionIds[0] || null,
          })
        }
      },

      deleteSession: (id: string) => {
        set((state) => {
          const newSessions = new Map(state.sessions)
          newSessions.delete(id)

          const newSessionMessages = new Map(state.sessionMessages)
          newSessionMessages.delete(id)

          const newActiveId = state.activeSessionId === id
            ? state.recentSessionIds.find(rid => rid !== id && newSessions.has(rid)) || null
            : state.activeSessionId

          return {
            sessions: newSessions,
            sessionMessages: newSessionMessages,
            activeSessionId: newActiveId,
            recentSessionIds: state.recentSessionIds.filter(rid => rid !== id),
          }
        })
      },

      renameSession: (id: string, title: string) => {
        set((state) => {
          const session = state.sessions.get(id)
          if (!session) return state

          const newSessions = new Map(state.sessions)
          newSessions.set(id, { ...session, title, updatedAt: new Date().toISOString() })
          return { sessions: newSessions }
        })
      },

      updateSessionStatus: (id: string, status: SessionStatus) => {
        set((state) => {
          const session = state.sessions.get(id)
          if (!session) return state

          const newSessions = new Map(state.sessions)
          newSessions.set(id, { ...session, status, updatedAt: new Date().toISOString() })
          return { sessions: newSessions }
        })
      },

      incrementMessageCount: (id: string) => {
        set((state) => {
          const session = state.sessions.get(id)
          if (!session) return state

          const newSessions = new Map(state.sessions)
          newSessions.set(id, {
            ...session,
            messageCount: session.messageCount + 1,
            lastMessageAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })
          return { sessions: newSessions }
        })
      },

      // ========== 工作区操作 ==========

      switchSessionWorkspace: (sessionId: string, workspaceId: string, mode: WorkspaceSwitchMode) => {
        const { sessions } = get()
        const session = sessions.get(sessionId)
        if (!session) return

        set((state) => {
          const newSessions = new Map(state.sessions)

          if (mode === 'temporary') {
            // 临时切换：仅更新 temporaryWorkspaceId
            newSessions.set(sessionId, {
              ...session,
              temporaryWorkspaceId: workspaceId,
              updatedAt: new Date().toISOString(),
            })
          } else if (mode === 'context') {
            // 添加关联工作区
            const contextIds = session.contextWorkspaceIds.includes(workspaceId)
              ? session.contextWorkspaceIds
              : [...session.contextWorkspaceIds, workspaceId]
            newSessions.set(sessionId, {
              ...session,
              contextWorkspaceIds: contextIds,
              updatedAt: new Date().toISOString(),
            })
          }
          // mode === 'global' 时不修改会话，由外部处理全局工作区切换

          return { sessions: newSessions }
        })
      },

      addContextWorkspace: (sessionId: string, workspaceId: string) => {
        const { sessions } = get()
        const session = sessions.get(sessionId)
        if (!session || session.contextWorkspaceIds.includes(workspaceId)) return

        set((state) => {
          const newSessions = new Map(state.sessions)
          newSessions.set(sessionId, {
            ...session,
            contextWorkspaceIds: [...session.contextWorkspaceIds, workspaceId],
            updatedAt: new Date().toISOString(),
          })
          return { sessions: newSessions }
        })
      },

      removeContextWorkspace: (sessionId: string, workspaceId: string) => {
        const { sessions } = get()
        const session = sessions.get(sessionId)
        if (!session) return

        set((state) => {
          const newSessions = new Map(state.sessions)
          newSessions.set(sessionId, {
            ...session,
            contextWorkspaceIds: session.contextWorkspaceIds.filter(id => id !== workspaceId),
            updatedAt: new Date().toISOString(),
          })
          return { sessions: newSessions }
        })
      },

      // ========== 悬浮岛操作 ==========

      toggleIsland: () => {
        set((state) => ({
          isIslandExpanded: !state.isIslandExpanded,
          islandExpandMode: !state.isIslandExpanded ? 'sessions' : null,
        }))
      },

      setIslandExpandMode: (mode: IslandExpandMode) => {
        set({
          isIslandExpanded: mode !== null,
          islandExpandMode: mode,
        })
      },

      collapseIsland: () => {
        set({
          isIslandExpanded: false,
          islandExpandMode: null,
        })
      },

      // ========== 查询方法 ==========

      getActiveSession: () => {
        const { sessions, activeSessionId } = get()
        if (!activeSessionId) return null
        return sessions.get(activeSessionId) || null
      },

      getRecentSessions: (limit: number) => {
        const { sessions, recentSessionIds } = get()
        return recentSessionIds
          .slice(0, limit)
          .map(id => sessions.get(id))
          .filter((s): s is ChatSession => s !== undefined)
      },

      getSessionMessages: (sessionId: string) => {
        return get().sessionMessages.get(sessionId)
      },

      setSessionMessages: (sessionId: string, state: SessionMessageState) => {
        set((store) => {
          const newSessionMessages = new Map(store.sessionMessages)
          newSessionMessages.set(sessionId, state)
          return { sessionMessages: newSessionMessages }
        })
      },
    }),
    {
      name: 'polaris-sessions',
      storage: createJSONStorage(() => localStorage, {
        reviver: (key, value) => {
          if (key === 'sessions' && Array.isArray(value)) {
            return new Map(value)
          }
          if (key === 'sessionMessages' && Array.isArray(value)) {
            return new Map(value)
          }
          return value
        },
        replacer: (key, value) => {
          if (key === 'sessions' && value instanceof Map) {
            return Array.from(value.entries())
          }
          if (key === 'sessionMessages' && value instanceof Map) {
            return Array.from(value.entries())
          }
          return value
        },
      }),
      partialize: (state) => ({
        sessions: state.sessions,
        activeSessionId: state.activeSessionId,
        recentSessionIds: state.recentSessionIds,
        // sessionMessages 可选是否持久化，暂时不持久化
      }),
    }
  )
)

// ============================================================================
// 辅助函数导出
// ============================================================================

/**
 * 获取会话实际使用的工作区
 * 优先级：临时工作区 > 绑定工作区 > 全局工作区
 */
export function getSessionEffectiveWorkspace(
  session: ChatSession,
  globalWorkspaceId: string | null
): string | null {
  if (session.temporaryWorkspaceId) {
    return session.temporaryWorkspaceId
  }
  if (session.workspaceId) {
    return session.workspaceId
  }
  return globalWorkspaceId
}