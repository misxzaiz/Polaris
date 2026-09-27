/**
 * LegacySessionKernel — 阶段 3：桥接现有业务路径（影子运行）
 *
 * 依据 `06-实施推进.md` 阶段 3：实现 LegacySessionKernel 委托给现有
 * sessionStoreManager + eventHandler + dialogStorageService + historyService，
 * **行为零变化**，验证 6 个能力接口完整性（能力 6 仲裁由阶段 2 V2StateArbiter 覆盖，
 * 不在此实现——Legacy 侧状态仍由 eventHandler 的前端 isStreaming 权威，影子运行）。
 *
 * 设计原则：
 * - 能力接口（capabilities.ts）方法名与触发全景图 6 类入口一一对应；
 * - 所有方法**完全委托**现有实现，不新增任何状态、不修改任何现有模块；
 * - 依赖注入（构造器传入），避免 import 环：本文件只 import 类型；
 * - 本阶段是"影子运行"：LegacySessionKernel 与现有 UI 路径并存，供消费方按需切换，
 *   现有业务路径（router_dispatch_stream / ai_chat_capability / UI 直接调用 store）零改动。
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
import type { SessionStoreManager } from '@/stores/conversationStore/types'
import type { ConversationStore, ConversationStoreInstance } from '@/stores/conversationStore/types'
import type { EventRouter } from '@/services/eventRouter'
import type { AIEvent } from '@/ai-runtime'

// ============================================================================
// 委托目标类型（依赖注入，仅类型引用，不 import 具体实现）
// ============================================================================

/** historyService 委托目标（结构子集，避免引入整个 service 类型） */
export interface LegacyHistoryServiceLike {
  restoreFromHistory(
    sessionId: string,
    engineId?: string,
    projectPath?: string,
    claudeProjectName?: string,
    titleHint?: string,
  ): Promise<boolean>
}

/** dialogStorageService 委托目标（结构子集） */
export interface LegacyDialogStorageLike {
  getConversationMessages(conversationId: string): Promise<ChatMessage[]>
  hasConversation(conversationId: string): Promise<boolean>
}

/**
 * sessionStoreManager 委托目标。
 * 真实实现是 Zustand vanilla store（StoreApi）：actions 在 getState() 上，
 * subscribe 在 StoreApi 上。测试替身也实现同一形状。
 */
export interface LegacySessionManagerLike {
  getState(): SessionStoreManager
  subscribe(listener: (state: SessionStoreManager, prevState: SessionStoreManager) => void): () => void
}

// ============================================================================
// LegacySessionKernel — 桥接实现
// ============================================================================

export interface LegacySessionKernelDeps {
  sessionStoreManager: LegacySessionManagerLike
  historyService: LegacyHistoryServiceLike
  eventRouter: EventRouter
  dialogStorageService: LegacyDialogStorageLike
}

/**
 * LegacySessionKernel：把能力接口委托到现有实现，行为零变化。
 *
 * 能力矩阵：
 * - MessageSendCapability     → store.sendMessage / continueChat / interrupt / regenerateResponse / editAndResend
 * - SessionLifecycleCapability → sessionStoreManager.createSession / deleteSession / switchSession / getActiveSessionId
 * - StateQueryCapability      → store.messages / conversationId / isStreaming（Legacy 前端权威）+ subscribe
 * - EventHandlingCapability   → manager.dispatchEvent（eventHandler 处理）
 * - RecoveryCapability        → historyService.restoreFromHistory + dialogStorageService 快照合并
 *
 * 注意：Legacy 阶段状态查询返回的是**前端权威**状态（store.isStreaming），
 * 与 V2StateArbiter（后端权威）并存——这正是"影子运行"：两条路径各自独立，
 * 待阶段 4 消费方切换到后端权威后再收敛。
 */
export class LegacySessionKernel
  implements
    MessageSendCapability,
    SessionLifecycleCapability,
    StateQueryCapability,
    EventHandlingCapability,
    RecoveryCapability
{
  private deps: LegacySessionKernelDeps

  constructor(deps: LegacySessionKernelDeps) {
    this.deps = deps
  }

  // ==========================================================================
  // 能力 1：消息发送（委托 store.sendMessage 等）
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
  // 能力 3：状态查询（Legacy：前端权威）
  // ==========================================================================

  async getSessionState(sessionId: string): Promise<SessionState> {
    const store = this.getStoreState(sessionId)
    if (!store) {
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
    const meta = this.deps.sessionStoreManager.getState().sessionMetadata.get(sessionId)
    return {
      sessionId,
      state: this.toRuntimeState(store, meta?.status),
      isStreaming: store.isStreaming,
      lastEventSeq: store.messages.length, // Legacy 无事件 seq，用消息数近似（仅供消费方排序）
      error: store.error,
      startedAt: null, // Legacy 不维护开始/结束时间
      endedAt: null,
      startedByDevice: null,
    }
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot> {
    const store = this.getStoreState(sessionId)
    if (!store) {
      throw new Error(`会话不存在: ${sessionId}`)
    }
    const meta = this.deps.sessionStoreManager.getState().sessionMetadata.get(sessionId)
    const conversationId = store.conversationId
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
      state: this.toRuntimeState(store, meta?.status),
      lastEventSeq: store.messages.length,
    }
  }

  async getMessages(sessionId: string): Promise<ChatMessage[]> {
    const store = this.getStoreState(sessionId)
    return store ? store.messages : []
  }

  subscribe(sessionId: string, handler: StateChangeHandler): () => void {
    const store = this.getStoreInstance(sessionId)
    const manager = this.deps.sessionStoreManager
    if (!store) return () => {}

    // Legacy 订阅：监听 store 状态变化 → 推导 SessionState 变化通知
    let prev = this.snapshotState(sessionId, store.getState())
    const unsub = store.subscribe(() => {
      const next = this.snapshotState(sessionId, this.getStoreState(sessionId) ?? store.getState())
      if (next.isStreaming !== prev.isStreaming || next.error !== prev.error) {
        handler(next, prev)
      }
      prev = next
    })
    // 会话切换（manager 级）也可能改变活跃会话的状态
    const unsubManager = manager.subscribe(() => {
      const cur = this.getStoreState(sessionId)
      if (!cur) return
      const next = this.snapshotState(sessionId, cur)
      if (next.isStreaming !== prev.isStreaming || next.error !== prev.error) {
        handler(next, prev)
      }
      prev = next
    })
    return () => {
      unsub()
      unsubManager()
    }
  }

  // ==========================================================================
  // 能力 4：事件处理（委托 manager.dispatchEvent → eventHandler）
  // ==========================================================================

  handleEvent(event: KernelEvent): void {
    // KernelEvent → AIEvent 映射（KernelEvent 是对 AIEvent 会话域事件的子集抽象）
    const aiEvent = this.toAIEvent(event)
    if (!aiEvent) return
    this.deps.sessionStoreManager.getState().dispatchEvent(aiEvent)
  }

  // ==========================================================================
  // 能力 5：恢复与同步（委托 historyService + dialogStorageService）
  // ==========================================================================

  async restoreFromHistory(historyId: string): Promise<string> {
    const ok = await this.deps.historyService.restoreFromHistory(historyId)
    if (!ok) throw new Error(`历史恢复失败: ${historyId}`)
    // restoreFromHistory 内部 createSessionFromHistory 已创建新会话并激活
    const activeId = this.deps.sessionStoreManager.getState().getActiveSessionId()
    if (!activeId) throw new Error('历史恢复成功但无活跃会话')
    return activeId
  }

  async resyncSession(sessionId: string): Promise<void> {
    // Legacy 快照合并：仅当磁盘已有完整会话时，把磁盘消息并入本地（幂等，不覆盖）
    const store = this.getStoreState(sessionId)
    if (!store) return
    const conversationId = store.conversationId
    if (!conversationId) return
    const exists = await this.deps.dialogStorageService.hasConversation(conversationId)
    if (!exists) return
    const disk = await this.deps.dialogStorageService.getConversationMessages(conversationId)
    if (disk.length === 0) return
    const inMemoryIds = new Set(store.messages.map((m) => m.id))
    const fresh = disk.filter((m) => !inMemoryIds.has(m.id))
    if (fresh.length === 0) return
    // 追加缺失消息（对齐 createConversationStore 的追加语义）
    for (const m of fresh) store.addMessage(m)
  }

  // ==========================================================================
  // 内部辅助
  // ==========================================================================

  /** 会话 store 实例（Zustand bound instance，含 subscribe） */
  private getStoreInstance(sessionId: string): ConversationStoreInstance | undefined {
    return this.deps.sessionStoreManager.getState().stores.get(sessionId)
  }

  /** 会话 store 状态 */
  private getStoreState(sessionId: string): ConversationStore | undefined {
    return this.getStoreInstance(sessionId)?.getState()
  }

  /** Legacy 前端权威状态 → SessionRuntimeState 映射 */
  private toRuntimeState(
    store: { isStreaming: boolean; error: string | null },
    _status?: 'idle' | 'running' | 'waiting' | 'error' | 'background-running',
  ): SessionState['state'] {
    if (store.isStreaming) return 'running'
    if (store.error) return 'error'
    return 'idle'
  }

  /** 构造订阅用的 SessionState 快照 */
  private snapshotState(sessionId: string, store: {
    isStreaming: boolean
    error: string | null
    messages: ChatMessage[]
  }): SessionState {
    return {
      sessionId,
      state: this.toRuntimeState(store, undefined),
      isStreaming: store.isStreaming,
      lastEventSeq: store.messages.length,
      error: store.error,
      startedAt: null,
      endedAt: null,
      startedByDevice: null,
    }
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

// ============================================================================
// 工厂：默认依赖（真实实现）
// ============================================================================

/**
 * 创建 LegacySessionKernel（默认依赖：全局单例）。
 * 异步动态 import：避免模块加载时触发 store 单例初始化（影子运行不主动初始化）。
 * 消费方可用 createLegacySessionKernel(deps) 注入测试替身。
 */
export async function createLegacySessionKernel(
  deps?: Partial<LegacySessionKernelDeps>,
): Promise<LegacySessionKernel> {
  const { sessionStoreManager } = await import('@/stores/conversationStore/sessionStoreManager')
  const { historyService } = await import('@/services/historyService')
  const { getEventRouter } = await import('@/services/eventRouter')
  const { dialogStorageService } = await import('@/services/dialogStorage')

  return new LegacySessionKernel({
    sessionStoreManager: deps?.sessionStoreManager ?? sessionStoreManager,
    historyService: deps?.historyService ?? historyService,
    eventRouter: deps?.eventRouter ?? getEventRouter(),
    dialogStorageService: deps?.dialogStorageService ?? dialogStorageService,
  })
}
