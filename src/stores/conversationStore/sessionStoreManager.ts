/**
 * SessionStoreManager 实现
 *
 * 管理多个会话 Store 实例，支持：
 * - 会话创建、删除、切换
 * - 事件路由（按 sessionId）
 * - 后台运行管理
 */

import { createStore, useStore } from 'zustand'
import type { AIEvent } from '../../ai-runtime'
import type {
  ConversationStore,
  ConversationStoreInstance,
  SessionManagerState,
  SessionManagerActions,
  SessionMetadata,
  CreateSessionOptions,
  StoreDeps,
} from './types'
import { createConversationStore } from './createConversationStore'
import { getEventRouter } from '../../services/eventRouter'
import { useConfigStore } from '../configStore'
import { getEventBus } from '../../ai-runtime'
import { useWorkspaceStore } from '../workspaceStore'
import { useViewStore } from '../index'

// ============================================================================
// LRU 驱逐配置
// ============================================================================

/** 非活跃会话最大保留数量 */
const MAX_IDLE_STORES = 5

/**
 * 驱逐非活跃会话
 *
 * 保护规则：
 * - activeSessionId 不可驱逐
 * - backgroundSessionIds 中的不可驱逐
 * - status === 'running' 不可驱逐
 *
 * 驱逐流程：
 * 1. 过滤非保护会话
 * 2. 按 lastAccessedAt 排序
 * 3. 超出 MAX_IDLE_STORES 的最旧会话执行 dispose() + 移除
 */
function evictIdleSessions(
  stores: Map<string, ConversationStoreInstance>,
  sessionMetadata: Map<string, SessionMetadata>,
  activeSessionId: string | null,
  backgroundSessionIds: string[]
): { stores: Map<string, ConversationStoreInstance>; sessionMetadata: Map<string, SessionMetadata> } | null {
  // 收集保护中的 sessionId
  const protectedIds = new Set<string>()
  if (activeSessionId) protectedIds.add(activeSessionId)
  backgroundSessionIds.forEach(id => protectedIds.add(id))

  // 额外保护正在运行的会话
  sessionMetadata.forEach((meta, id) => {
    if (meta.status === 'running') protectedIds.add(id)
  })

  // 筛选可驱逐的会话
  const evictable: Array<{ id: string; lastAccessedAt: number }> = []
  stores.forEach((_, id) => {
    if (!protectedIds.has(id)) {
      const meta = sessionMetadata.get(id)
      if (meta) {
        evictable.push({ id, lastAccessedAt: meta.lastAccessedAt })
      }
    }
  })

  // 未超出上限，无需驱逐
  if (evictable.length <= MAX_IDLE_STORES) return null

  // 按 lastAccessedAt 升序，驱逐最旧的
  evictable.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt)
  const toEvict = evictable.slice(0, evictable.length - MAX_IDLE_STORES)

  const newStores = new Map(stores)
  const newMetadata = new Map(sessionMetadata)

  for (const { id } of toEvict) {
    const store = newStores.get(id)
    if (store) {
      store.getState().dispose()
      newStores.delete(id)
      newMetadata.delete(id)
      console.log('[SessionStoreManager] LRU 驱逐会话:', id)
    }
  }

  return { stores: newStores, sessionMetadata: newMetadata }
}

/**
 * 更新会话的 lastAccessedAt 时间戳
 */
function touchSession(
  sessionMetadata: Map<string, SessionMetadata>,
  sessionId: string
): Map<string, SessionMetadata> | null {
  const meta = sessionMetadata.get(sessionId)
  if (!meta) return null
  const now = Date.now()
  // 避免频繁创建新 Map（1 秒内不重复 touch）
  if (now - meta.lastAccessedAt < 1000) return null
  const newMetadata = new Map(sessionMetadata)
  newMetadata.set(sessionId, { ...meta, lastAccessedAt: now })
  return newMetadata
}

// ============================================================================
// Manager Store Type
// ============================================================================

type SessionManagerStore = SessionManagerState & SessionManagerActions

// ============================================================================
// Manager Store 创建
// ============================================================================

/**
 * 创建 SessionStoreManager store
 */
function createSessionManagerStore() {
  return createStore<SessionManagerStore>((set, get) => ({
    // ===== 状态 =====
    stores: new Map<string, ConversationStoreInstance>(),
    activeSessionId: null,
    sessionMetadata: new Map<string, SessionMetadata>(),
    backgroundSessionIds: [],
    completedNotifications: [],
    isInitialized: false,

    // ===== 会话生命周期 =====

    createSession: (options: CreateSessionOptions) => {
      // 使用指定的 ID 或生成新的 UUID
      const sessionId = options.id || crypto.randomUUID()
      const timestamp = new Date().toISOString()

      console.log('[SessionStoreManager] createSession 调用:', {
        sessionId,
        optionsWorkspaceId: options.workspaceId,
        optionsType: options.type,
        optionsTitle: options.title,
      })

      // 检查会话是否已存在
      if (get().stores.has(sessionId)) {
        console.log('[SessionStoreManager] 会话已存在:', sessionId)
        return sessionId
      }

      // 创建元数据
      const metadata: SessionMetadata = {
        id: sessionId,
        title: options.title || `新对话 ${get().stores.size + 1}`,
        type: options.type,
        workspaceId: options.workspaceId || null,
        contextWorkspaceIds: options.contextWorkspaceIds || [],
        workspaceLocked: options.workspaceLocked ?? (!!options.workspaceId),
        status: 'idle',
        silentMode: options.silentMode || false, // 设置静默模式
        lastAccessedAt: Date.now(),
        createdAt: timestamp,
        updatedAt: timestamp,
        forkFromId: options.forkFromId,
      }

      console.log('[SessionStoreManager] 创建会话元数据:', {
        sessionId,
        metadataWorkspaceId: metadata.workspaceId,
        metadataType: metadata.type,
      })

      // 构建依赖注入
      const contextId = `session-${sessionId}`
      const deps: StoreDeps = {
        getConfig: () => {
          const state = useConfigStore.getState()
          return state.config as { defaultEngine?: string } | null
        },
        getWorkspace: () => {
          // 获取【当前会话】的工作区
          // 优先级：metadata.workspaceId（支持用户后续更新）> 初始 options.workspaceId > 全局工作区
          // 注意：这里使用创建时绑定的 sessionId，而不是 activeSessionId
          // 确保每个会话使用自己的工作区，不受会话切换影响
          const workspaceState = useWorkspaceStore.getState()

          // 优先从 metadata 获取（支持用户通过 WorkspaceMenu 等更新工作区）
          const managerState = get()
          const metadata = managerState.sessionMetadata.get(sessionId)

          // 确定要使用的 workspaceId：优先 metadata，其次初始值
          // 这避免了竞态问题：metadata 不存在时用初始值，存在时用更新后的值
          const targetWorkspaceId = metadata?.workspaceId || options.workspaceId

          if (targetWorkspaceId) {
            const workspace = workspaceState.workspaces.find(w => w.id === targetWorkspaceId)
            if (workspace) {
              return workspace
            }
          }

          // 回退到全局工作区
          return workspaceState.getCurrentWorkspace()
        },
        getContextWorkspaceIds: () => {
          // 获取当前会话的关联工作区 ID 列表
          const managerState = get()
          const metadata = managerState.sessionMetadata.get(sessionId)
          return metadata?.contextWorkspaceIds || []
        },
        getAllWorkspaces: () => {
          return useWorkspaceStore.getState().workspaces
        },
        getEventRouter: () => getEventRouter(),
        contextId,
      }

      // 创建独立的 ConversationStore（注入依赖）
      const conversationStore = createConversationStore(sessionId, deps)

      set((state) => {
        const newStores = new Map(state.stores)
        newStores.set(sessionId, conversationStore)

        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, metadata)

        return {
          stores: newStores,
          sessionMetadata: newMetadata,
          // 静默会话不自动激活
          activeSessionId: options.silentMode ? state.activeSessionId : sessionId,
        }
      })

      console.log('[SessionStoreManager] 创建会话:', sessionId)

      // LRU 驱逐：非保护会话超过上限时清理最旧的
      const currentState = get()
      const evicted = evictIdleSessions(
        currentState.stores,
        currentState.sessionMetadata,
        currentState.activeSessionId,
        currentState.backgroundSessionIds
      )
      if (evicted) {
        set({ stores: evicted.stores, sessionMetadata: evicted.sessionMetadata })
      }

      // 非静默模式且开启多窗口模式时，自动加入多窗口视图
      if (!options.silentMode && useViewStore.getState().multiSessionMode) {
        useViewStore.getState().addToMultiView(sessionId)
      }

      return sessionId
    },

    createSessionFromHistory: (messages, conversationId, metadata) => {
      // 创建新会话
      const sessionId = get().createSession({
        type: metadata?.workspaceId ? 'project' : 'free',
        workspaceId: metadata?.workspaceId,
        title: metadata?.title || `历史会话 ${get().stores.size + 1}`,
        forkFromId: metadata?.forkFromId,
      })

      // 获取新创建的 Store 并设置历史消息
      const store = get().stores.get(sessionId)
      if (store) {
        store.getState().setMessagesFromHistory(messages, conversationId)

        console.log('[SessionStoreManager] 从历史创建会话:', sessionId, {
          messageCount: messages.length,
          conversationId,
          forkFromId: metadata?.forkFromId,
        })
      }

      return sessionId
    },

    deleteSession: (sessionId: string) => {
      const state = get()
      const store = state.stores.get(sessionId)

      if (!store) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 清理资源
      store.getState().dispose()

      set((state) => {
        const newStores = new Map(state.stores)
        newStores.delete(sessionId)

        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.delete(sessionId)

        const newBackgroundSessionIds = state.backgroundSessionIds.filter(
          (id) => id !== sessionId
        )
        const newCompletedNotifications = state.completedNotifications.filter(
          (id) => id !== sessionId
        )

        // 如果删除的是当前活跃会话，需要切换
        let newActiveSessionId = state.activeSessionId
        if (state.activeSessionId === sessionId) {
          // 尝试切换到最近一个会话
          const remainingIds = Array.from(newStores.keys())
          newActiveSessionId = remainingIds.length > 0 ? remainingIds[remainingIds.length - 1] : null
        }

        return {
          stores: newStores,
          sessionMetadata: newMetadata,
          backgroundSessionIds: newBackgroundSessionIds,
          completedNotifications: newCompletedNotifications,
          activeSessionId: newActiveSessionId,
        }
      })

      // 同步从多窗口视图移除
      useViewStore.getState().removeFromMultiView(sessionId)

      console.log('[SessionStoreManager] 删除会话:', sessionId)
    },

    switchSession: (sessionId: string) => {
      const state = get()
      const store = state.stores.get(sessionId)

      if (!store) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 当前活跃会话如果正在 streaming，移入后台
      const currentStore = state.activeSessionId
        ? state.stores.get(state.activeSessionId)
        : null

      if (currentStore && currentStore.getState().isStreaming) {
        get().addToBackground(state.activeSessionId!)
      }

      // 切换到新会话
      // touch lastAccessedAt
      const touched = touchSession(state.sessionMetadata, sessionId)
      set({
        activeSessionId: sessionId,
        ...(touched ? { sessionMetadata: touched } : {}),
      })

      // 如果新会话在后台运行列表中，移出（用户主动切换回来了）
      get().removeFromBackground(sessionId)

      // 多窗口模式协调：确保目标会话在网格中，并请求滚动
      const viewState = useViewStore.getState()
      if (viewState.multiSessionMode) {
        viewState.addToMultiView(sessionId)
        viewState.requestScrollToSession(sessionId)
      }

      console.log('[SessionStoreManager] 切换会话:', sessionId)
    },

    updateSessionTitle: (sessionId: string, title: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 更新元数据标题
      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          title,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      console.log('[SessionStoreManager] 更新会话标题:', sessionId, title)
    },

    makeSessionVisible: (sessionId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 如果已经是可见会话，直接切换
      if (!metadata.silentMode) {
        get().switchSession(sessionId)
        return
      }

      // 更新元数据，移除静默模式标志
      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          silentMode: false,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      // 切换到该会话
      get().switchSession(sessionId)

      console.log('[SessionStoreManager] 会话已转为可见:', sessionId)
    },

    // ===== Store 访问 =====

    getStore: (sessionId: string) => {
      return get().stores.get(sessionId)?.getState()
    },

    getActiveStore: () => {
      const sessionId = get().activeSessionId
      if (!sessionId) return undefined
      return get().stores.get(sessionId)?.getState()
    },

    getActiveSessionId: () => {
      return get().activeSessionId
    },

    // ===== 事件分发 =====

    dispatchEvent: (event: AIEvent & { sessionId?: string; _routeSessionId?: string }) => {
      // 使用 _routeSessionId（前端 sessionId）进行路由，如果没有则使用 sessionId
      // 如果都没有，使用当前活跃会话 ID
      const routeSessionId = event._routeSessionId || event.sessionId || get().activeSessionId
      if (!routeSessionId) {
        console.warn('[SessionStoreManager] 无法确定路由目标，缺少 sessionId 和 activeSessionId')
        return
      }
      let store = get().stores.get(routeSessionId)

      // 如果会话不存在，自动创建
      if (!store) {
        // 检测是否为 scheduler 任务（静默模式）
        const isSchedulerTask = routeSessionId.startsWith('scheduler-')
        
        console.log('[SessionStoreManager] 事件路由时自动创建会话:', routeSessionId, 
                    isSchedulerTask ? '(静默模式)' : '')
        
        get().createSession({
          id: routeSessionId,
          type: 'free',
          title: isSchedulerTask ? '定时任务' : '新对话',
          silentMode: isSchedulerTask, // scheduler 任务使用静默模式
        })
        store = get().stores.get(routeSessionId)

        if (!store) {
          console.error('[SessionStoreManager] 自动创建会话失败:', routeSessionId)
          return
        }
      }

      // 调用新架构的事件处理器
      // 注意：事件总是路由到 routeSessionId 对应的会话，而不是当前活跃会话
      // 这是多会话并行的核心：每个会话独立处理自己的事件
      store.getState().handleAIEvent(event)

      // touch lastAccessedAt（LRU 追踪）
      const touchedMeta = touchSession(get().sessionMetadata, routeSessionId)
      if (touchedMeta) {
        set({ sessionMetadata: touchedMeta })
      }

      // 补发到 EventBus，确保 DeveloperPanel 等订阅者能收到事件
      try {
        getEventBus().emit(event)
      } catch (e) {
        console.warn('[SessionStoreManager] EventBus emit 失败:', e)
      }

      // 更新元数据状态（仅在 status 实际变化时创建新 Map，避免高频事件下无谓重建）
      const metadata = get().sessionMetadata.get(routeSessionId)
      if (metadata) {
        let newStatus: SessionMetadata['status'] = metadata.status

        if (event.type === 'session_start') {
          newStatus = 'running'
        } else if (event.type === 'session_end') {
          newStatus = 'idle'

          // 如果是后台运行的会话，添加通知
          if (get().backgroundSessionIds.includes(routeSessionId)) {
            get().addToNotifications(routeSessionId)
            get().removeFromBackground(routeSessionId)

            // 触发 Toast 通知
            const sessionMetadata = get().sessionMetadata.get(routeSessionId)
            if (sessionMetadata) {
              // 动态导入 toastStore 避免循环依赖
              import('@/stores/toastStore').then(({ useToastStore }) => {
                useToastStore.getState().sessionComplete(
                  sessionMetadata.title,
                  routeSessionId,
                  () => get().switchSession(routeSessionId)
                )
              })
            }
          }
        } else if (event.type === 'error') {
          newStatus = 'error'
        }

        if (newStatus !== metadata.status) {
          set((state) => {
            const newMetadata = new Map(state.sessionMetadata)
            newMetadata.set(routeSessionId, { ...metadata, status: newStatus, updatedAt: new Date().toISOString() })
            return { sessionMetadata: newMetadata }
          })
        }
      }
    },

    // ===== 后台运行管理 =====

    addToBackground: (sessionId: string) => {
      set((state) => {
        if (state.backgroundSessionIds.includes(sessionId)) {
          return state
        }
        return {
          backgroundSessionIds: [...state.backgroundSessionIds, sessionId],
        }
      })

      // 更新元数据状态
      const metadata = get().sessionMetadata.get(sessionId)
      if (metadata) {
        set((state) => {
          const newMetadata = new Map(state.sessionMetadata)
          newMetadata.set(sessionId, { ...metadata, status: 'background-running' })
          return { sessionMetadata: newMetadata }
        })
      }

      console.log('[SessionStoreManager] 会话进入后台:', sessionId)
    },

    removeFromBackground: (sessionId: string) => {
      set((state) => ({
        backgroundSessionIds: state.backgroundSessionIds.filter((id) => id !== sessionId),
      }))
    },

    addToNotifications: (sessionId: string) => {
      set((state) => {
        if (state.completedNotifications.includes(sessionId)) {
          return state
        }
        return {
          completedNotifications: [...state.completedNotifications, sessionId],
        }
      })
    },

    removeFromNotifications: (sessionId: string) => {
      set((state) => ({
        completedNotifications: state.completedNotifications.filter((id) => id !== sessionId),
      }))
    },

    // ===== 批量操作 =====

    getStreamingSessions: () => {
      const stores = get().stores
      const streamingIds: string[] = []

      stores.forEach((store, sessionId) => {
        if (store.getState().isStreaming) {
          streamingIds.push(sessionId)
        }
      })

      return streamingIds
    },

    interruptSession: async (sessionId: string) => {
      const store = get().stores.get(sessionId)
      if (!store) {
        console.warn('[SessionStoreManager] interruptSession: 会话不存在:', sessionId)
        return
      }

      const state = store.getState()
      console.log('[SessionStoreManager] interruptSession:', {
        frontendSessionId: sessionId,
        backendConversationId: state.conversationId,
        isStreaming: state.isStreaming
      })

      try {
        await state.interrupt()
      } catch (e) {
        console.error('[SessionStoreManager] 打断会话失败:', sessionId, e)
      }
    },

    interruptAllBackground: async () => {
      const backgroundIds = get().backgroundSessionIds
      for (const sessionId of backgroundIds) {
        await get().interruptSession(sessionId)
      }
    },

    // ===== 工作区管理 =====

    updateSessionWorkspace: (sessionId: string, workspaceId: string | null) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      console.log('[SessionStoreManager] updateSessionWorkspace 调用:', {
        sessionId,
        newWorkspaceId: workspaceId,
        oldWorkspaceId: metadata.workspaceId,
      })

      // 获取工作区名称
      let workspaceName: string | undefined
      if (workspaceId) {
        const workspace = useWorkspaceStore.getState().workspaces.find(w => w.id === workspaceId)
        workspaceName = workspace?.name
        console.log('[SessionStoreManager] 找到工作区:', {
          workspaceId,
          workspaceName,
          workspacePath: workspace?.path,
        })
      }

      // 更新 SessionMetadata
      const updatedMetadata: SessionMetadata = {
        ...metadata,
        workspaceId,
        workspaceName,
        type: workspaceId ? 'project' : 'free',
        updatedAt: new Date().toISOString(),
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, updatedMetadata)
        return { sessionMetadata: newMetadata }
      })

      // 更新 ConversationStore
      const store = get().stores.get(sessionId)
      if (store) {
        store.setState({ workspaceId })
      }

      console.log('[SessionStoreManager] 更新会话工作区完成:', sessionId, workspaceId)
    },

    addContextWorkspace: (sessionId: string, workspaceId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 防止重复添加
      if (metadata.contextWorkspaceIds.includes(workspaceId)) {
        return
      }

      // 更新 SessionMetadata
      const updatedMetadata: SessionMetadata = {
        ...metadata,
        contextWorkspaceIds: [...metadata.contextWorkspaceIds, workspaceId],
        updatedAt: new Date().toISOString(),
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, updatedMetadata)
        return { sessionMetadata: newMetadata }
      })

      console.log('[SessionStoreManager] 添加关联工作区:', sessionId, workspaceId)
    },

    removeContextWorkspace: (sessionId: string, workspaceId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        console.warn('[SessionStoreManager] 会话不存在:', sessionId)
        return
      }

      // 更新 SessionMetadata
      const updatedMetadata: SessionMetadata = {
        ...metadata,
        contextWorkspaceIds: metadata.contextWorkspaceIds.filter(id => id !== workspaceId),
        updatedAt: new Date().toISOString(),
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, updatedMetadata)
        return { sessionMetadata: newMetadata }
      })

      console.log('[SessionStoreManager] 移除关联工作区:', sessionId, workspaceId)
    },

    // ===== 初始化 =====

    initialize: async () => {
      const state = get()

      // 如果没有会话，创建默认会话
      if (state.stores.size === 0) {
        get().createSession({
          type: 'free',
          title: '新对话',
        })
        console.log('[SessionStoreManager] 已创建默认会话')
      }

      set({ isInitialized: true })
      console.log('[SessionStoreManager] 初始化完成')
    },
  }))
}

// ============================================================================
// 全局单例
// ============================================================================

/**
 * 全局 SessionStoreManager store 实例
 */
export const sessionStoreManager = createSessionManagerStore()

/**
 * 缓存的 actions 对象，确保引用稳定
 */
const cachedActions = {
  get createSession() { return sessionStoreManager.getState().createSession },
  get deleteSession() { return sessionStoreManager.getState().deleteSession },
  get switchSession() { return sessionStoreManager.getState().switchSession },
  get updateSessionTitle() { return sessionStoreManager.getState().updateSessionTitle },
  get makeSessionVisible() { return sessionStoreManager.getState().makeSessionVisible },
  get addToBackground() { return sessionStoreManager.getState().addToBackground },
  get removeFromBackground() { return sessionStoreManager.getState().removeFromBackground },
  get addToNotifications() { return sessionStoreManager.getState().addToNotifications },
  get removeFromNotifications() { return sessionStoreManager.getState().removeFromNotifications },
  get interruptSession() { return sessionStoreManager.getState().interruptSession },
  get interruptAllBackground() { return sessionStoreManager.getState().interruptAllBackground },
  get updateSessionWorkspace() { return sessionStoreManager.getState().updateSessionWorkspace },
  get addContextWorkspace() { return sessionStoreManager.getState().addContextWorkspace },
  get removeContextWorkspace() { return sessionStoreManager.getState().removeContextWorkspace },
}

// ============================================================================
// React Hooks
// ============================================================================

// Cache variables for useSessionMetadataList to prevent infinite render loops
let cachedMetadataMap: Map<string, SessionMetadata> | null = null
let cachedMetadataArray: SessionMetadata[] | null = null

/**
 * 获取当前活跃会话的 Store
 *
 * 注意：此 hook 返回的 store 实例不会自动触发重渲染
 * 如需响应状态变化，请使用：
 * - useActiveSessionMessages() - 订阅消息列表
 * - useActiveSessionStreaming() - 订阅流式状态
 * - useActiveSessionActions() - 获取操作方法
 */
export function useActiveConversationStore(): ConversationStore | undefined {
  const sessionId = useStore(sessionStoreManager, (state) => state.activeSessionId)
  const stores = useStore(sessionStoreManager, (state) => state.stores)

  if (!sessionId) return undefined
  return stores.get(sessionId)?.getState()
}

/**
 * 获取指定会话的 Store
 */
export function useConversationStore(sessionId: string | null): ConversationStore | undefined {
  const stores = useStore(sessionStoreManager, (state) => state.stores)

  if (!sessionId) return undefined
  return stores.get(sessionId)?.getState()
}

/**
 * 获取所有会话元数据列表
 * 使用缓存避免数组实例变化导致的无限更新
 */
export function useSessionMetadataList(): SessionMetadata[] {
  return useStore(
    sessionStoreManager,
    (state) => {
      // Implement caching logic to prevent infinite render loops
      // If the Map reference hasn't changed, return the cached array
      if (state.sessionMetadata === cachedMetadataMap && cachedMetadataArray !== null) {
        return cachedMetadataArray
      }
      
      // Map reference has changed, create new array and update cache
      const newArray = Array.from(state.sessionMetadata.values())
      cachedMetadataMap = state.sessionMetadata
      cachedMetadataArray = newArray
      
      return newArray
    }
  )
}

/**
 * 获取当前活跃会话 ID
 */
export function useActiveSessionId(): string | null {
  return useStore(sessionStoreManager, (state) => state.activeSessionId)
}

/**
 * 获取后台运行会话列表
 * 使用缓存避免数组实例变化导致的无限更新
 */
export function useBackgroundSessions(): SessionMetadata[] {
  return useStore(
    sessionStoreManager,
    (state) =>
      state.backgroundSessionIds
        .map((id) => state.sessionMetadata.get(id))
        .filter((m): m is SessionMetadata => m !== undefined)
  )
}

/**
 * 获取已完成通知列表
 * 使用缓存避免数组实例变化导致的无限更新
 */
export function useCompletedNotifications(): SessionMetadata[] {
  return useStore(
    sessionStoreManager,
    (state) =>
      state.completedNotifications
        .map((id) => state.sessionMetadata.get(id))
        .filter((m): m is SessionMetadata => m !== undefined)
  )
}

/**
 * 获取 Manager 操作方法
 * 
 * 注意：返回缓存的 actions 对象，引用永远不变
 */
export function useSessionManagerActions() {
  return cachedActions
}

// 导出创建函数（用于测试）
export { createSessionManagerStore }
