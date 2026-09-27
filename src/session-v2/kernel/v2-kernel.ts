/**
 * V2SessionKernel — 阶段 4：后端权威实现
 *
 * 依据 `00-总体规划.md` 阶段 4：
 * - 4.1 `sendMessage`：调后端 `router_dispatch_stream` + 监听事件流（复用现有
 *   aiChatDispatchStream 的 ack 通道，内容经既有 chat-event → eventHandler 回流）
 * - 4.2 `getSessionState`：调后端 `session_get_status` 查询，**不读本地 isStreaming**
 * - 4.3 `resyncSession`：快照合并（diff 本地 → 只追加缺失），非全量覆盖；
 *     恢复期间新事件不丢失（由 store.subscribe 追加语义 + 幂等保证）
 * - 4.4 `handleEvent`：统一事件入口，内部按 sessionId 路由（委托现有 dispatchEvent，
 *     保留 conversationId 反向索引 / 自动创建 / LRU touch 等既有行为）
 *
 * 影子运行原则：本实现与现有 UI 路径并存。能力 1/2/4/5 委托现有实现
 * （V2 写入路径接入后端为阶段 5+ 的「影子写」），能力 3 状态查询走后端
 * `session_get_status`（后端权威，跨设备可见）。能力 6 仲裁由阶段 2 V2StateArbiter 覆盖，
 * 不在本内核实现。
 *
 * 依赖注入：构造器接收 deps，只 import 类型，零循环依赖。
 */

import type {
  MessageSendCapability,
  SessionLifecycleCapability,
  CreateSessionOptions,
  SessionHandle,
  StateQueryCapability,
  EventHandlingCapability,
  RecoveryCapability,
} from './capabilities'
import type {
  SendMessageInput,
  SendResult,
  ContinueOptions,
  SessionState,
  SessionSnapshot,
  StateChangeHandler,
  KernelEvent,
} from './types'
import type { ChatMessage } from '@/types/chat'
import type { SessionStoreManager, ConversationStore, ConversationStoreInstance } from '@/stores/conversationStore/types'
import type { AIEvent } from '@/ai-runtime'
import type { SessionStatus } from '../core/types'

// ============================================================================
// 委托目标类型（依赖注入，仅类型引用，不 import 具体实现）
// ============================================================================

/** historyService 委托目标（结构子集，避免引入整个 service 类型） */
export interface V2HistoryServiceLike {
  restoreFromHistory(
    sessionId: string,
    engineId?: string,
    projectPath?: string,
    claudeProjectName?: string,
    titleHint?: string,
  ): Promise<boolean>
}

/** 后端状态查询委托目标（阶段 2 V2StateArbiter 的结构子集） */
export interface V2StateQueryLike {
  getStatus(conversationId: string): Promise<SessionStatus>
}

/** 事件流委托目标（阶段 4 统一事件入口的路由目标） */
export interface V2EventDispatcherLike {
  dispatchEvent(event: AIEvent & { sessionId?: string; _routeSessionId?: string }): void
}

/** sessionStoreManager 委托目标（Zustand vanilla store 形状） */
export interface V2SessionManagerLike {
  getState(): SessionStoreManager
  subscribe(listener: (state: SessionStoreManager, prevState: SessionStoreManager) => void): () => void
}

/** 快照来源（resyncSession 合并用；真实为 dialogStorageService） */
export interface V2SnapshotSourceLike {
  getSnapshot(conversationId: string): Promise<ChatMessage[]>
}

// ============================================================================
// V2SessionKernel — 后端权威实现
// ============================================================================

export interface V2SessionKernelDeps {
  sessionStoreManager: V2SessionManagerLike
  historyService: V2HistoryServiceLike
  eventDispatcher: V2EventDispatcherLike
  stateArbiter: V2StateQueryLike
  /** 流式发送委托（aiChatDispatchStream 结构子集，便于测试注入） */
  streamDispatch: (payload: Record<string, unknown>) => Promise<unknown>
  /** 快照来源（resyncSession 合并；真实为 dialogStorageService） */
  snapshotSource: V2SnapshotSourceLike
}

/**
 * V2SessionKernel：后端权威的状态查询 + 现有路径委托。
 *
 * 能力矩阵：
 * - MessageSendCapability     → 委托 store.sendMessage / continueChat / interrupt / regenerateResponse / editAndResend
 * - SessionLifecycleCapability → 委托 sessionStoreManager.createSession / deleteSession / switchSession / getActiveSessionId
 * - StateQueryCapability      → getSessionState 走后端 session_get_status（不读本地 isStreaming）
 * - EventHandlingCapability   → 委托 manager.dispatchEvent（统一入口，内部按 sessionId 路由）
 * - RecoveryCapability        → 委托 historyService.restoreFromHistory + 快照合并
 *
 * 会话状态（SessionRuntimeState）由后端 `SessionStatus.running/error` 推导：
 * - running=true → 'running'（isStreaming=true）
 * - error 非空   → 'error'
 * - 否则         → 'idle'
 * 会话不存在（前端无 store 且后端无记录）→ 'none'
 */
export class V2SessionKernel
  implements
    MessageSendCapability,
    SessionLifecycleCapability,
    StateQueryCapability,
    EventHandlingCapability,
    RecoveryCapability
{
  private deps: V2SessionKernelDeps

  constructor(deps: V2SessionKernelDeps) {
    this.deps = deps
  }

  // ==========================================================================
  // 能力 1：消息发送（委托 store.sendMessage）
  // ==========================================================================

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    const store = this.getStoreState(input.sessionId)
    if (!store) {
      return { ok: false, reason: `会话不存在: ${input.sessionId}`, retryable: false }
    }
    try {
      // files（路径数组）：Legacy 路径对附件的处理在 UI 层完成（Attachment 对象），
      // 桥接层不包装——内容已含文件引用时透传即可。与现有
      // sendMessage(content, workspaceDir?, attachments?, options?) 第一参契约对齐。
      await store.sendMessage(input.content)
      return { ok: true, conversationId: store.conversationId ?? undefined }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, reason: msg, retryable: true }
    }
  }

  async continueChat(sessionId: string, prompt: string, opts?: ContinueOptions): Promise<void> {
    const store = this.getStoreState(sessionId)
    if (!store) return
    // opts.extraContext 附加上下文：追加为消息内容的一部分（Legacy continueChat 无独立上下文槽位）
    const message = opts?.extraContext ? `${prompt}\n\n${opts.extraContext}` : prompt
    await store.continueChat(message)
  }

  async interrupt(sessionId: string): Promise<void> {
    await this.deps.sessionStoreManager.getState().interruptSession(sessionId)
  }

  async regenerate(sessionId: string, assistantMessageId: string): Promise<void> {
    const store = this.getStoreState(sessionId)
    if (!store) return
    await store.regenerateResponse(assistantMessageId)
  }

  async editAndResend(sessionId: string, userMessageId: string, newContent: string): Promise<void> {
    const store = this.getStoreState(sessionId)
    if (!store) return
    await store.editAndResend(userMessageId, newContent)
  }

  // ==========================================================================
  // 能力 2：会话生命周期（委托 sessionStoreManager）
  // ==========================================================================

  async createSession(opts: CreateSessionOptions): Promise<SessionHandle> {
    const sessionId = this.deps.sessionStoreManager.getState().createSession({
      id: opts.id,
      type: opts.type,
      workspaceId: opts.workspaceId,
      contextWorkspaceIds: opts.contextWorkspaceIds,
      title: opts.title,
      engineId: opts.engineId,
      silentMode: opts.silentMode,
      kind: opts.kind,
      commitWorkspaceId: opts.commitWorkspaceId,
      forkFromId: opts.forkFromId,
    })
    const store = this.getStoreState(sessionId)
    return { sessionId, conversationId: store?.conversationId ?? null }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deps.sessionStoreManager.getState().deleteSession(sessionId)
  }

  switchSession(sessionId: string): void {
    this.deps.sessionStoreManager.getState().switchSession(sessionId)
  }

  getActiveSessionId(): string | null {
    return this.deps.sessionStoreManager.getState().getActiveSessionId()
  }

  // ==========================================================================
  // 能力 3：状态查询（后端权威，不读本地 isStreaming）
  // ==========================================================================

  async getSessionState(sessionId: string): Promise<SessionState> {
    const store = this.getStoreState(sessionId)
    const conversationId = store?.conversationId ?? null
    // 会话不存在（前端无 store）→ none
    if (!store) {
      return this.noneState(sessionId)
    }
    // 有 conversationId → 走后端 session_get_status（权威）
    if (conversationId) {
      try {
        const status = await this.deps.stateArbiter.getStatus(conversationId)
        return {
          sessionId,
          state: this.statusToRuntime(status),
          isStreaming: status.running,
          lastEventSeq: status.lastEventSeq,
          error: status.error ?? store.error,
          startedAt: status.startedAt,
          endedAt: status.endedAt,
          startedByDevice: status.startedByDevice,
        }
      } catch {
        // 后端查询失败：不抛错（消费方降级用本地快照），返回本地兜底状态
        return this.localFallbackState(sessionId, store)
      }
    }
    // 前端已创建但尚无 conversationId（未发送首条消息）→ idle（本地兜底）
    return this.localFallbackState(sessionId, store)
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const store = this.getStoreState(sessionId)
    if (!store) {
      throw new Error(`会话不存在: ${sessionId}`)
    }
    const meta = this.deps.sessionStoreManager.getState().sessionMetadata.get(sessionId)
    const conversationId = store.conversationId
    const state = conversationId
      ? this.statusToRuntime(await this.safeStatus(conversationId))
      : this.localRuntime(store)
    return {
      sessionId,
      conversationId: conversationId ?? '',
      metadata: {
        title: meta?.title ?? '',
        engineId: meta?.engineId ?? '',
        workspaceId: meta?.workspaceId ?? null,
        type: meta?.type ?? 'free',
        silentMode: meta?.silentMode ?? false,
        createdAt: meta?.createdAt ? new Date(meta.createdAt).getTime() : 0,
        updatedAt: meta?.updatedAt ? new Date(meta.updatedAt).getTime() : 0,
      },
      messages: store.messages,
      state,
      lastEventSeq: conversationId ? (await this.safeStatus(conversationId)).lastEventSeq : store.messages.length,
    }
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const store = this.getStoreState(sessionId)
    return store ? store.messages : []
  }

  /** 后端状态订阅：getSessionState 后端权威 + store/manager 双通道事件驱动轮询 */
  subscribe(sessionId: string, handler: StateChangeHandler): () => void {
    const store = this.getStoreInstance(sessionId)
    const manager = this.deps.sessionStoreManager
    if (!store) return () => {}

    let prev: SessionState | null = null
    let polling = false
    let disposed = false
    let timer: ReturnType<typeof setInterval> | null = null

    /** 推一次状态；失败静默（降级本地快照，仍可推） */
    const push = async () => {
      if (disposed) return
      try {
        const next = await this.getSessionState(sessionId)
        if (disposed) return
        if (prev && this.sameState(prev, next)) return
        const before = prev
        prev = next
        handler(next, before ?? next)
      } catch {
        // 查询失败：保持上次状态（不误报）
      }
    }

    const stopPolling = () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      polling = false
    }

    /** 事件驱动后检查是否需要轮询（后端状态可能未随本地事件翻转） */
    const schedulePolling = () => {
      if (disposed) return
      const last = prev
      if (last?.state === 'running') {
        if (!polling) {
          polling = true
          timer = setInterval(() => void push(), V2_POLL_INTERVAL_MS)
        }
      } else if (polling) {
        stopPolling()
      }
    }

    // 初始快照
    void push().then(schedulePolling)

    const unsubStore = store.subscribe(() => {
      void push().then(schedulePolling)
    })
    const unsubManager = manager.subscribe(() => {
      void push().then(schedulePolling)
    })

    return () => {
      disposed = true
      stopPolling()
      unsubStore()
      unsubManager()
    }
  }

  // ==========================================================================
  // 能力 4：事件处理（统一入口，委托 dispatchEvent 按 sessionId 路由）
  // ==========================================================================

  handleEvent(event: KernelEvent): void {
    const aiEvent = this.toAIEvent(event)
    if (!aiEvent) return
    this.deps.eventDispatcher.dispatchEvent(aiEvent)
  }

  // ==========================================================================
  // 能力 5：恢复与同步（委托 historyService + 快照合并）
  // ==========================================================================

  async restoreFromHistory(historyId: string): Promise<string> {
    const ok = await this.deps.historyService.restoreFromHistory(historyId)
    if (!ok) throw new Error(`历史恢复失败: ${historyId}`)
    const activeId = this.deps.sessionStoreManager.getState().getActiveSessionId()
    if (!activeId) throw new Error('历史恢复成功但无活跃会话')
    return activeId
  }

  async resyncSession(sessionId: string): Promise<void> {
    // 快照合并：仅当磁盘已有完整会话时，把磁盘消息并入本地（幂等，不覆盖）。
    // 恢复期间新事件不丢失：追加语义按 id 去重，本地已存在的消息（含新事件产生的）
    // 一律跳过，只补缺失。
    const store = this.getStoreState(sessionId)
    if (!store) return
    const conversationId = store.conversationId
    if (!conversationId) return
    // 委托目标由注入提供（真实为 dialogStorageService，测试注入伪后端快照）
    if (!this.deps.snapshotSource) return
    const snapshot = await this.deps.snapshotSource.getSnapshot(conversationId)
    if (!snapshot || snapshot.length === 0) return
    const inMemoryIds = new Set(store.messages.map((m) => m.id))
    const fresh = snapshot.filter((m) => !inMemoryIds.has(m.id))
    if (fresh.length === 0) return
    for (const m of fresh) store.addMessage(m)
  }

  // ==========================================================================
  // 内部辅助
  // ==========================================================================

  private getStoreInstance(sessionId: string): ConversationStoreInstance | undefined {
    return this.deps.sessionStoreManager.getState().stores.get(sessionId)
  }

  private getStoreState(sessionId: string): ConversationStore | undefined {
    return this.getStoreInstance(sessionId)?.getState()
  }

  /** 后端 SessionStatus → SessionRuntimeState */
  private statusToRuntime(status: SessionStatus): SessionState['state'] {
    if (status.running) return 'running'
    if (status.error) return 'error'
    return 'idle'
  }

  /** 本地兜底运行态（无 conversationId / 后端查询失败时使用） */
  private localRuntime(store: { isStreaming: boolean; error: string | null }): SessionState['state'] {
    if (store.isStreaming) return 'running'
    if (store.error) return 'error'
    return 'idle'
  }

  /** 会话不存在时的 none 状态 */
  private noneState(sessionId: string): SessionState {
    return {
      sessionId,
      state: 'none',
      isStreaming: false,
      lastEventSeq: 0,
      error: null,
      startedAt: null,
      endedAt: null,
      startedByDevice: null,
    }
  }

  /** 本地兜底状态（不抛错，供消费方降级） */
  private localFallbackState(sessionId: string, store: {
    isStreaming: boolean
    error: string | null
    messages: ChatMessage[]
  }): SessionState {
    return {
      sessionId,
      state: this.localRuntime(store),
      isStreaming: store.isStreaming,
      lastEventSeq: store.messages.length,
      error: store.error,
      startedAt: null,
      endedAt: null,
      startedByDevice: null,
    }
  }

  private async safeStatus(conversationId: string): Promise<SessionStatus> {
    try {
      return await this.deps.stateArbiter.getStatus(conversationId)
    } catch {
      return { conversationId, running: false, lastEventSeq: 0, error: null, startedAt: null, endedAt: null, startedByDevice: null }
    }
  }

  /** 状态比较：isStreaming / error / state 变化才通知 */
  private sameState(a: SessionState, b: SessionState): boolean {
    return a.isStreaming === b.isStreaming && a.error === b.error && a.state === b.state
  }

  /** KernelEvent → AIEvent 映射（对齐 ai-runtime 的会话域事件） */
  private toAIEvent(event: KernelEvent): AIEvent | null {
    switch (event.type) {
      case 'session_start':
        return { type: 'session_start', sessionId: event.sessionId, engineId: event.engineId }
      case 'session_end':
        return {
          type: 'session_end',
          sessionId: event.sessionId,
          reason: event.reason,
        }
      case 'user_message':
        return {
          type: 'user_message',
          sessionId: event.sessionId,
          content: event.content,
          clientMessageId: event.clientMessageId,
        }
      case 'assistant_message':
        return {
          type: 'assistant_message',
          sessionId: event.sessionId,
          content: event.content,
          isDelta: true, // Kernel 层的 assistant_message 为增量流式事件（Legacy 由 eventHandler 逐块构建）
        }
      case 'error':
        return { type: 'error', sessionId: event.sessionId, error: event.errorMessage }
      default:
        return null
    }
  }
}

/** 订阅轮询间隔（运行中状态下事件驱动之外的后端状态兜底刷新） */
export const V2_POLL_INTERVAL_MS = 1000

// ============================================================================
// 工厂：默认依赖（真实实现，异步动态 import 避免循环依赖）
// ============================================================================

/**
 * 创建 V2SessionKernel（默认依赖：全局单例）。
 * - stateArbiter：阶段 2 V2StateArbiter（后端 session_get_status，后端权威）
 * - eventDispatcher：sessionStoreManager（dispatchEvent 统一事件入口）
 * - streamDispatch：aiChatDispatchStream（router_dispatch_stream）
 * 消费方可用 createV2SessionKernel(deps) 注入测试替身。
 */
export async function createV2SessionKernel(
  deps?: Partial<V2SessionKernelDeps>,
): Promise<V2SessionKernel> {
  const { sessionStoreManager } = await import('@/stores/conversationStore/sessionStoreManager')
  const { historyService } = await import('@/services/historyService')
  const { V2StateArbiter } = await import('../core/v2-session-event-log')
  const { aiChatDispatchStream } = await import('@/services/aiChatDispatch')
  const { dialogStorageService } = await import('@/services/dialogStorage')

  return new V2SessionKernel({
    sessionStoreManager: deps?.sessionStoreManager ?? sessionStoreManager,
    historyService: deps?.historyService ?? historyService,
    eventDispatcher: deps?.eventDispatcher ?? sessionStoreManager.getState(),
    stateArbiter: deps?.stateArbiter ?? new V2StateArbiter(),
    streamDispatch: deps?.streamDispatch ?? ((payload) => aiChatDispatchStream(payload)),
    snapshotSource: deps?.snapshotSource ?? {
      getSnapshot: (conversationId: string) => dialogStorageService.getConversationMessages(conversationId),
    },
  })
}
