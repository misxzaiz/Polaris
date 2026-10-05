import { generateUUID } from '@/utils/uuid';
/**
 * SessionStoreManager 实现
 *
 * 管理多个会话 Store 实例，支持：
 * - 会话创建、删除、切换
 * - 事件路由（按 sessionId）
 * - 后台运行管理
 */

import { createStore, useStore } from 'zustand'
import type { AIEvent } from '@/ai-runtime'
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
import { getEventRouter } from '@/services/eventRouter'
import { useConfigStore } from '../configStore'
import { getEventBus } from '@/ai-runtime'
import { voiceNotificationService } from '@/services/voiceNotificationService'
import { useWorkspaceStore } from '../workspaceStore'
import { useViewStore } from '../index'
import { createLogger } from '@/utils/logger'
import { normalizeEngineId } from '@/utils/engineDisplay'
import { useSessionConfig } from '../sessionConfigStore'
import { OFFICIAL_API_PROFILE } from '@/types/modelProfile'

const log = createLogger('SessionStoreManager')

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
      const sessionId = options.id || generateUUID()
      const timestamp = new Date().toISOString()

      log.info('createSession 调用', { sessionId, optionsWorkspaceId: options.workspaceId, optionsType: options.type, optionsTitle: options.title, engineId: options.engineId })

      // 检查会话是否已存在
      if (get().stores.has(sessionId)) {
        log.info('会话已存在', { sessionId })
        return sessionId
      }

      // 创建元数据
      const configEngineId = useConfigStore.getState().config?.defaultEngine
      const metadata: SessionMetadata = {
        id: sessionId,
        title: options.title || `新对话 ${get().stores.size + 1}`,
        type: options.type,
        engineId: normalizeEngineId(options.engineId || configEngineId),
        workspaceId: options.workspaceId || null,
        contextWorkspaceIds: options.contextWorkspaceIds || [],
        workspaceLocked: options.workspaceLocked ?? (!!options.workspaceId),
        status: 'idle',
        silentMode: options.silentMode || false, // 设置静默模式
        createdAt: timestamp,
        updatedAt: timestamp,
        forkFromId: options.forkFromId,
        modelProfileId: options.modelProfileId,
        model: options.model,
        agent: options.agent,
        kind: options.kind,
        commitWorkspaceId: options.commitWorkspaceId,
      }

      log.info('创建会话元数据', { sessionId, metadataWorkspaceId: metadata.workspaceId, metadataType: metadata.type, engineId: metadata.engineId })

      // 构建依赖注入
      const contextId = `session-${sessionId}`
      const deps: StoreDeps = {
        getConfig: () => {
          const state = useConfigStore.getState()
          return state.config as { defaultEngine?: string; activeProviderGroupId?: string } | null
        },
        getWorkspace: () => {
          // 获取【当前会话】的工作区
          // 优先级：metadata.workspaceId（支持用户后续更新）> 初始 options.workspaceId
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

          // 自由会话（无显式绑定）不静默回退全局工作区：
          // 全局工作区是"行为与展示不一致"的漂移源（UI 标签显示无工作区，实际却注入全局 workDir + 系统提示词）。
          // free 会话应语义上就是"无工作区"。有显式绑定的会话（project）已在上方命中返回。
          // 历史恢复（createSessionFromHistory）的 free 会话本质上仍是自由会话语义，同样不回退。
          if (metadata?.type === 'free') {
            return null
          }

          // 回退到全局工作区（仅非 free 会话，如默认会话/旧数据）
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

      // 同步 ConversationStore 的 workspaceId（与 updateSessionWorkspace 行为对齐）。
      // createInitialState 硬编码 workspaceId: null，若不在这里同步，
      // useActiveSessionWorkspace() 对任何新建会话恒返回 null，
      // 会话级工作区感知（ChatInput 内嵌等）从创建起就是失效的。
      conversationStore.setState({ workspaceId: metadata.workspaceId })

      log.info('创建会话', { sessionId })

      // 非静默模式时自动加入多窗口视图
      if (!options.silentMode) {
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
        engineId: metadata?.engineId,
      })

      // 获取新创建的 Store 并设置历史消息（paging 非空 = 尾部优先分页恢复）
      const store = get().stores.get(sessionId)
      if (store) {
        store.getState().setMessagesFromHistory(messages, conversationId, metadata?.paging)
        log.info('从历史创建会话', { sessionId, messageCount: messages.length, conversationId, forkFromId: metadata?.forkFromId })
      }

      return sessionId
    },

    deleteSession: (sessionId: string) => {
      const state = get()
      const store = state.stores.get(sessionId)

      if (!store) {
        log.warn('会话不存在', { sessionId })
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

      log.info('删除会话', { sessionId })
    },

    switchSession: (sessionId: string) => {
      const state = get()
      const store = state.stores.get(sessionId)

      if (!store) {
        log.warn('会话不存在', { sessionId })
        return
      }

      // 当前活跃会话如果正在 streaming，移入后台（单路径：本地快照）。
      // 删除原异步 kernel 复核：它引入竞态（切换完成后异步回调仍用旧 prevActiveId）。
      const currentStore = state.activeSessionId
        ? state.stores.get(state.activeSessionId)
        : null

      if (currentStore && currentStore.getState().isStreaming && state.activeSessionId) {
        get().addToBackground(state.activeSessionId)
      }

      // 切换到新会话
      set({ activeSessionId: sessionId })

      // 如果新会话在后台运行列表中，移出（用户主动切换回来了）
      get().removeFromBackground(sessionId)

      // 多窗口模式协调：确保目标会话在网格中，并请求滚动
      const viewState = useViewStore.getState()
      viewState.addToMultiView(sessionId)
      viewState.requestScrollToSession(sessionId)

      // P1: 切换会话时，把该会话的生效 Profile 与模型同步到状态栏镜像。
      // 生效值 = 会话覆盖 ?? 全局默认；这样无覆盖会话显示并使用全局默认，与发送逻辑一致。
      const targetMetadata = get().sessionMetadata.get(sessionId)
      if (targetMetadata) {
        const globalDefault = useConfigStore.getState().config?.activeModelProfileId
        // 会话明确选官方（哨兵）→ 镜像置空串（状态栏高亮「官方 API」项，且不把哨兵写入镜像）；
        // 有具体覆盖 → 原样；未设置(undefined) → 跟随全局默认。
        const sessionOverride = targetMetadata.modelProfileId
        const mirror = sessionOverride === OFFICIAL_API_PROFILE
          ? ''
          : (sessionOverride ?? globalDefault ?? '')
        useSessionConfig.getState().setModelProfileId(mirror)

        // 全局供应商模式默认（此时镜像尚未被 setProfileMode 覆盖）。
        // 注意不要在 profileMode 镜像时再读已覆盖后的 config，语义会串。
        const globalProfileMode = useSessionConfig.getState().config.profileMode ?? 'profile'

        // 会话级模型镜像：有覆盖时用之，未设置时清空（让状态栏反映全局默认）。
        useSessionConfig.getState().setModel(targetMetadata.model ?? '')

        // 会话级专家镜像：有覆盖时用之，未设置时清空（让状态栏反映无专家）。
        useSessionConfig.getState().setAgent(targetMetadata.agent ?? '')

        // P2: 会话级供应商模式镜像：有会话级覆盖时用之；未设置时回退全局默认。
        // 与 modelProfileId 三态（会话覆盖 > 镜像 > 全局默认）一致。
        // 注意：必须先读全局默认（此时 setProfileMode 尚未覆盖镜像）。
        useSessionConfig.getState().setProfileMode(
          targetMetadata.profileMode ?? globalProfileMode,
        )

        // 会话级供应商分组镜像：有会话级覆盖时用之；未设置时回退全局镜像。
        // 与 modelProfileId 三态一致，配合 profileMode='group' 定位到具体分组。
        useSessionConfig.getState().setProviderGroupId(
          targetMetadata.providerGroupId ?? useSessionConfig.getState().config.providerGroupId ?? '',
        )
      }

      log.info('切换会话', { sessionId })
    },

    updateSessionTitle: (sessionId: string, title: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
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

      log.info('更新会话标题', { sessionId, title })
    },

    updateSessionEngine: (sessionId, engineId) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return false
      }

      const store = get().stores.get(sessionId)?.getState()
      if (store && (store.isStreaming || store.conversationId || store.messages.length > 0)) {
        log.warn('已有内容的会话不允许切换引擎', {
          sessionId,
          isStreaming: store.isStreaming,
          hasConversationId: Boolean(store.conversationId),
          messageCount: store.messages.length,
        })
        return false
      }

      const normalizedEngineId = normalizeEngineId(engineId)
      if (normalizeEngineId(metadata.engineId) === normalizedEngineId) {
        return true
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          engineId: normalizedEngineId,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话引擎', { sessionId, engineId: normalizedEngineId })
      return true
    },

    updateSessionModelProfile: (sessionId, modelProfileId) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          // null = 清除会话级覆盖（→ 跟随全局默认）；字符串（含官方哨兵）原样保留。
          // 用 ?? 而非 ||：只把 null/undefined 当「清除」，避免误伤有意义的值。
          modelProfileId: modelProfileId ?? undefined,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话 Profile', { sessionId, modelProfileId })
    },

    updateSessionProfileMode: (sessionId, profileMode) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          // null/undefined = 清除会话级覆盖（→ 跟随全局默认）；三态值原样写入。
          profileMode: profileMode ?? undefined,
          // official/group 不绑定单 Profile：同步清掉会话级 Profile 覆盖，避免残留穿透。
          ...((profileMode === 'official' || profileMode === 'group')
            ? { modelProfileId: undefined }
            : {}),
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话供应商模式', { sessionId, profileMode })
    },

    updateSessionProviderGroupId: (sessionId, providerGroupId) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          // null/undefined/空串 = 清除会话级分组覆盖（→ 跟随全局 active_provider_group_id）
          providerGroupId: providerGroupId || undefined,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话供应商分组', { sessionId, providerGroupId })
    },

    updateSessionModel: (sessionId, model) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          // null = 清除会话级覆盖（→ 跟随全局默认）；字符串（含空串）原样保留。
          // 用 ?? 而非 ||：只把 null/undefined 当「清除」，避免误伤有意义的值。
          model: model ?? undefined,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话模型', { sessionId, model })
    },

    updateSessionAgent: (sessionId, agent) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      set((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(sessionId, {
          ...metadata,
          // null / 空串 = 清除会话级专家覆盖；非空字符串原样保留。
          agent: agent && agent.length > 0 ? agent : undefined,
          updatedAt: new Date().toISOString(),
        })
        return { sessionMetadata: newMetadata }
      })

      log.info('更新会话专家', { sessionId, agent })
    },

    makeSessionVisible: (sessionId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
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

      log.info('会话已转为可见', { sessionId })
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
      // 单一路由路径：_routeSessionId 是前端 sessionId（由 EventRouter 从 contextId 解析注入）。
      // 不再用 event.sessionId（后端 conversationId）兜底，不再回退 activeSessionId，
      // 不再"找不到 store 就自动建会话"——这三条正是"对不准窗口/新开窗口"的根因。
      const routeSessionId = event._routeSessionId
      if (!routeSessionId) {
        log.warn('事件缺少 _routeSessionId，丢弃', { type: event.type })
        return
      }
      const store = get().stores.get(routeSessionId)
      if (!store) {
        // store 不存在 = 前端尚未创建该会话（用户从未打开 / 已删除）。
        // 事件丢弃，由前端主动创建会话后再发起新一轮对话。
        log.warn('事件未匹配到会话，丢弃', { routeSessionId, type: event.type })
        return
      }

      store.getState().handleAIEvent(event)

      // 补发到 EventBus，确保 DeveloperPanel 等订阅者能收到事件
      try {
        getEventBus().emit(event)
      } catch (e) {
        log.warn('EventBus emit 失败', { error: String(e) })
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
            // 语音提醒：后台完成通知
            voiceNotificationService.notifyBackgroundComplete()
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

      log.info('会话进入后台', { sessionId })
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

    interruptSession: async (sessionId: string) => {
      const store = get().stores.get(sessionId)
      if (!store) {
        log.warn('interruptSession: 会话不存在', { sessionId })
        return
      }

      const state = store.getState()
      log.info('interruptSession', { frontendSessionId: sessionId, backendConversationId: state.conversationId, isStreaming: state.isStreaming })

      try {
        await state.interrupt()
      } catch (e) {
        log.error('打断会话失败', e instanceof Error ? e : new Error(String(e)), { sessionId })
      }
    },

    // ===== 工作区管理 =====

    updateSessionWorkspace: (sessionId: string, workspaceId: string | null) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
        return
      }

      log.info('updateSessionWorkspace 调用', { sessionId, newWorkspaceId: workspaceId, oldWorkspaceId: metadata.workspaceId })

      // 获取工作区名称
      let workspaceName: string | undefined
      if (workspaceId) {
        const workspace = useWorkspaceStore.getState().workspaces.find(w => w.id === workspaceId)
        workspaceName = workspace?.name
        log.info('找到工作区', { workspaceId, workspaceName, workspacePath: workspace?.path })
      }

      // 更新 SessionMetadata
      const updatedMetadata: SessionMetadata = {
        ...metadata,
        workspaceId,
        workspaceName,
        type: workspaceId ? 'project' : 'free',
        // 解除主工作区 = 解锁（转为自由会话，允许再次绑定）
        workspaceLocked: workspaceId === null ? false : metadata.workspaceLocked,
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

      log.info('更新会话工作区完成', { sessionId, workspaceId })
    },

    addContextWorkspace: (sessionId: string, workspaceId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
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

      log.info('添加关联工作区', { sessionId, workspaceId })
    },

    removeContextWorkspace: (sessionId: string, workspaceId: string) => {
      const metadata = get().sessionMetadata.get(sessionId)
      if (!metadata) {
        log.warn('会话不存在', { sessionId })
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

      log.info('移除关联工作区', { sessionId, workspaceId })
    },

    // ===== 初始化 =====

    initialize: async () => {
      const state = get()

      // 如果没有会话，创建默认会话
      if (state.stores.size === 0) {
        // 有全局工作区时，默认会话绑定全局工作区（project 语义）；
        // 无全局工作区时创建自由会话（free，不强制工作区）。
        const currentWorkspace = useWorkspaceStore.getState().getCurrentWorkspace()
        get().createSession(
          currentWorkspace
            ? {
                type: 'project',
                title: '新对话',
                workspaceId: currentWorkspace.id,
                workspaceLocked: false,
              }
            : {
                type: 'free',
                title: '新对话',
              }
        )
        log.info('已创建默认会话')
      }

      set({ isInitialized: true })
      log.info('初始化完成')
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
  get updateSessionEngine() { return sessionStoreManager.getState().updateSessionEngine },
  get updateSessionModelProfile() { return sessionStoreManager.getState().updateSessionModelProfile },
  get updateSessionProfileMode() { return sessionStoreManager.getState().updateSessionProfileMode },
  get updateSessionProviderGroupId() { return sessionStoreManager.getState().updateSessionProviderGroupId },
  get updateSessionModel() { return sessionStoreManager.getState().updateSessionModel },
  get updateSessionAgent() { return sessionStoreManager.getState().updateSessionAgent },
  get makeSessionVisible() { return sessionStoreManager.getState().makeSessionVisible },
  get addToBackground() { return sessionStoreManager.getState().addToBackground },
  get removeFromBackground() { return sessionStoreManager.getState().removeFromBackground },
  get addToNotifications() { return sessionStoreManager.getState().addToNotifications },
  get removeFromNotifications() { return sessionStoreManager.getState().removeFromNotifications },
  get interruptSession() { return sessionStoreManager.getState().interruptSession },
  get updateSessionWorkspace() { return sessionStoreManager.getState().updateSessionWorkspace },
  get addContextWorkspace() { return sessionStoreManager.getState().addContextWorkspace },
  get removeContextWorkspace() { return sessionStoreManager.getState().removeContextWorkspace },
}

/**
 * 通过后端 conversationId 查找前端 store。
 * 用于权限/提问等事件的 block 携带后端 conversationId 的场景。
 * 简化实现：遍历 stores（会话数通常 ≤10，O(n) 可接受），不再维护反向索引。
 */
export function findStoreByConversationId(conversationId: string): ConversationStore | undefined {
  const stores = sessionStoreManager.getState().stores
  for (const store of stores.values()) {
    if (store.getState().conversationId === conversationId) return store.getState()
  }
  return undefined
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
 * 获取 Manager 操作方法
 * 
 * 注意：返回缓存的 actions 对象，引用永远不变
 */
export function useSessionManagerActions() {
  return cachedActions
}

// 导出创建函数（用于测试）
export { createSessionManagerStore }
