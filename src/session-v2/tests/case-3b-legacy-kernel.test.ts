/**
 * LegacySessionKernel 影子验证 — 阶段 3
 *
 * 目标：验证 LegacySessionKernel（桥接现有路径）对 5 个能力接口的委托
 * **行为零变化**：
 * - MessageSendCapability     → 委托 store.sendMessage / continueChat / interrupt / regenerateResponse / editAndResend
 * - SessionLifecycleCapability → 委托 sessionStoreManager.createSession / deleteSession / switchSession / getActiveSessionId
 * - StateQueryCapability      → 委托 store.messages / conversationId / isStreaming + subscribe
 * - EventHandlingCapability   → 委托 manager.dispatchEvent（KernelEvent → AIEvent 映射）
 * - RecoveryCapability        → 委托 historyService.restoreFromHistory + dialogStorageService 快照合并
 *
 * 验证方式：注入内存替身（FakeSessionManager / FakeStorage），记录调用参数，
 * 断言 kernel 只做透传（参数原样、返回值透传、无副作用扩展）。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { LegacySessionKernel } from '../kernel/legacy-kernel'
import type { SessionStoreManager, ConversationStore, ConversationStoreInstance } from '@/stores/conversationStore/types'
import type { ChatMessage } from '@/types/chat'
import type { KernelEvent, SendResult } from '../kernel/types'
import type { AIEvent } from '@/ai-runtime'
import type { LegacySessionKernelDeps } from '../kernel/legacy-kernel'

// ============================================================================
// 内存替身：模拟 sessionStoreManager 的委托目标（不含 Zustand 依赖）
// ============================================================================

interface FakeStoreState {
  sessionId: string
  conversationId: string | null
  isStreaming: boolean
  error: string | null
  messages: ChatMessage[]
}

type StoreSubscriber = () => void

class FakeConversationStore {
  state: FakeStoreState
  private subscribers = new Set<StoreSubscriber>()
  calls: { method: string; args: unknown[] }[] = []

  constructor(sessionId: string, conversationId: string | null = null) {
    this.state = {
      sessionId,
      conversationId,
      isStreaming: false,
      error: null,
      messages: [],
    }
  }

  /** 模拟 Zustand bound store：getState() 返回状态 + actions（kernel 的 getStoreState 依赖） */
  getState(): this {
    return this
  }

  get conversationId() { return this.state.conversationId }
  get isStreaming() { return this.state.isStreaming }
  get error() { return this.state.error }
  get messages() { return this.state.messages }

  async sendMessage(content: string, workspaceDir?: string, attachments?: unknown[], options?: unknown) {
    this.calls.push({ method: 'sendMessage', args: [content, workspaceDir, attachments, options] })
  }
  async continueChat(prompt?: string, allowedTools?: string[]) {
    this.calls.push({ method: 'continueChat', args: [prompt, allowedTools] })
  }
  async interrupt() {
    this.calls.push({ method: 'interrupt', args: [] })
  }
  async regenerateResponse(assistantMessageId: string) {
    this.calls.push({ method: 'regenerateResponse', args: [assistantMessageId] })
  }
  async editAndResend(userMessageId: string, newContent: string) {
    this.calls.push({ method: 'editAndResend', args: [userMessageId, newContent] })
  }
  addMessage(message: ChatMessage) {
    this.state.messages = [...this.state.messages, message]
  }
  subscribe(fn: StoreSubscriber) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
  /** 测试辅助：推进状态并通知订阅者 */
  emit(patch: Partial<FakeStoreState>) {
    this.state = { ...this.state, ...patch }
    this.subscribers.forEach((fn) => fn())
  }
}

class FakeSessionManager {
  stores = new Map<string, FakeConversationStore>()
  sessionMetadata = new Map<string, { status?: string; title?: string; engineId?: string; workspaceId?: string | null; type?: string; silentMode?: boolean; createdAt?: string; updatedAt?: string }>()
  activeSessionId: string | null = null
  dispatchEvents: AIEvent[] = []
  calls: { method: string; args: unknown[] }[] = []
  private subscribers = new Set<() => void>()
  /** conversationId → sessionId 反向索引（模拟真实 manager 的 registerConversationId） */
  private convIndex = new Map<string, string>()

  /** 模拟 Zustand vanilla store：getState() 暴露全部 actions + 状态 */
  getState(): this {
    return this
  }

  // ===== SessionManagerActions 子集（kernel 用到的方法） =====
  createSession(options: { id?: string; type: 'project' | 'free'; workspaceId?: string; contextWorkspaceIds?: string[]; title?: string; engineId?: string; silentMode?: boolean; kind?: string; commitWorkspaceId?: string; forkFromId?: string }) {
    this.calls.push({ method: 'createSession', args: [options] })
    const sessionId = options.id ?? `sess-${this.stores.size + 1}`
    const store = new FakeConversationStore(sessionId)
    this.stores.set(sessionId, store)
    this.sessionMetadata.set(sessionId, {
      status: 'idle',
      title: options.title,
      engineId: options.engineId,
      workspaceId: options.workspaceId ?? null,
      type: options.type,
      silentMode: options.silentMode,
    })
    if (!options.silentMode) this.activeSessionId = sessionId
    return sessionId
  }
  deleteSession(sessionId: string) {
    this.calls.push({ method: 'deleteSession', args: [sessionId] })
    this.stores.delete(sessionId)
    this.sessionMetadata.delete(sessionId)
  }
  switchSession(sessionId: string) {
    this.calls.push({ method: 'switchSession', args: [sessionId] })
    this.activeSessionId = sessionId
  }
  getActiveSessionId(): string | null {
    return this.activeSessionId
  }
  getStore(sessionId: string) {
    return this.stores.get(sessionId)
  }
  interruptSession(sessionId: string) {
    this.calls.push({ method: 'interruptSession', args: [sessionId] })
    const store = this.stores.get(sessionId)
    if (store) return store.interrupt()
    return Promise.resolve()
  }
  dispatchEvent(event: AIEvent) {
    this.calls.push({ method: 'dispatchEvent', args: [event] })
    this.dispatchEvents.push(event)
    // 模拟 eventHandler 的 session_start/session_end 效果（含 conversationId 反向索引续接）
    const targetStore =
      this.stores.get(event.sessionId) ??
      (event.sessionId ? this.stores.get(this.convIndex.get(event.sessionId) ?? '') : undefined)
    if (event.type === 'session_start') {
      if (targetStore) targetStore.emit({ isStreaming: true, conversationId: event.sessionId })
    } else if (event.type === 'session_end') {
      if (targetStore) targetStore.emit({ isStreaming: false })
    }
  }
  /** 测试辅助：注册 conversationId → sessionId 映射 */
  registerSimpleMapping(conversationId: string, sessionId: string) {
    this.convIndex.set(conversationId, sessionId)
  }
  subscribe(fn: () => void) {
    this.subscribers.add(fn)
    return () => this.subscribers.delete(fn)
  }
}

// ============================================================================

function makeUserMessage(id: string, content: string): ChatMessage {
  return { id, type: 'user', content, timestamp: new Date().toISOString() }
}

function makeDeps(overrides?: Partial<LegacySessionKernelDeps>) {
  const manager = new FakeSessionManager()
  const historyService = {
    restoreFromHistory: vi.fn(async () => true),
  }
  const eventRouter = {
    initialize: vi.fn(async () => {}),
    register: vi.fn(() => () => {}),
  } as unknown as LegacySessionKernelDeps['eventRouter']
  const dialogStorageService = {
    getConversationMessages: vi.fn(async () => [] as ChatMessage[]),
    hasConversation: vi.fn(async () => false),
  }
  const deps: LegacySessionKernelDeps = {
    sessionStoreManager: manager as unknown as LegacySessionKernelDeps['sessionStoreManager'],
    historyService: historyService as unknown as LegacySessionKernelDeps['historyService'],
    eventRouter,
    dialogStorageService: dialogStorageService as unknown as LegacySessionKernelDeps['dialogStorageService'],
    ...overrides,
  }
  return { deps, manager, historyService, dialogStorageService }
}

describe('LegacySessionKernel 影子验证（阶段 3）', () => {
  let deps: LegacySessionKernelDeps
  let manager: FakeSessionManager
  let historyService: { restoreFromHistory: ReturnType<typeof vi.fn> }
  let dialogStorageService: { getConversationMessages: ReturnType<typeof vi.fn>; hasConversation: ReturnType<typeof vi.fn> }
  let kernel: LegacySessionKernel

  beforeEach(() => {
    const built = makeDeps()
    deps = built.deps
    manager = built.manager
    historyService = built.historyService
    dialogStorageService = built.dialogStorageService
    kernel = new LegacySessionKernel(deps)
  })

  // ==========================================================================
  // 能力 1：消息发送
  // ==========================================================================

  it('sendMessage 委托 store.sendMessage，返回对话 ID', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)
    expect(store).toBeDefined()

    const result = await kernel.sendMessage({ sessionId: sid, content: 'hello' })
    expect(result.ok).toBe(true)
    expect(store!.calls.some((c) => c.method === 'sendMessage' && c.args[0] === 'hello')).toBe(true)
  })

  it('sendMessage 会话不存在 → ok=false，不抛错', async () => {
    const result = await kernel.sendMessage({ sessionId: 'no-such', content: 'x' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()
  })

  it('continueChat 委托 store.continueChat（附加上下文拼入 prompt）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)
    await kernel.continueChat(sid, '继续')
    expect(store!.calls.some((c) => c.method === 'continueChat' && c.args[0] === '继续')).toBe(true)

    // extraContext 拼入
    await kernel.continueChat(sid, '继续', { extraContext: '附加上下文' })
    expect(store!.calls.some((c) => c.method === 'continueChat' && c.args[0] === '继续\n\n附加上下文')).toBe(true)
  })

  it('interrupt 委托 sessionStoreManager.interruptSession', async () => {
    const sid = manager.createSession({ type: 'free' })
    await kernel.interrupt(sid)
    expect(manager.calls.some((c) => c.method === 'interruptSession' && c.args[0] === sid)).toBe(true)
  })

  it('regenerate / editAndResend 委托 store 对应方法', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)
    await kernel.regenerate(sid, 'assistant-1')
    await kernel.editAndResend(sid, 'user-1', '新内容')
    expect(store!.calls.some((c) => c.method === 'regenerateResponse' && c.args[0] === 'assistant-1')).toBe(true)
    expect(store!.calls.some((c) => c.method === 'editAndResend' && c.args[0] === 'user-1' && c.args[1] === '新内容')).toBe(true)
  })

  // ==========================================================================
  // 能力 2：会话生命周期
  // ==========================================================================

  it('createSession 委托 manager 并返回句柄（含 conversationId）', async () => {
    const handle = await kernel.createSession({ type: 'project', title: '测试', silentMode: true })
    expect(handle.sessionId).toBeDefined()
    expect(manager.calls.some((c) => c.method === 'createSession')).toBe(true)
    // silent 会话不激活
    expect(manager.activeSessionId).toBeNull()
  })

  it('deleteSession / switchSession / getActiveSessionId 透传 manager', async () => {
    const sid = manager.createSession({ type: 'free' })
    kernel.switchSession(sid)
    expect(manager.getActiveSessionId()).toBe(sid)
    expect(kernel.getActiveSessionId()).toBe(sid)
    await kernel.deleteSession(sid)
    expect(manager.stores.has(sid)).toBe(false)
  })

  // ==========================================================================
  // 能力 3：状态查询（Legacy 前端权威）
  // ==========================================================================

  it('getSessionState：exists → idle；isStreaming → running；error → error', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!

    let state = await kernel.getSessionState(sid)
    expect(state.state).toBe('idle')
    expect(state.isStreaming).toBe(false)

    store.emit({ isStreaming: true })
    state = await kernel.getSessionState(sid)
    expect(state.state).toBe('running')
    expect(state.isStreaming).toBe(true)

    store.emit({ isStreaming: false, error: '模型超时' })
    state = await kernel.getSessionState(sid)
    expect(state.state).toBe('error')
    expect(state.error).toBe('模型超时')
  })

  it('getSessionState：会话不存在 → state=none', async () => {
    const state = await kernel.getSessionState('no-such')
    expect(state.state).toBe('none')
    expect(state.isStreaming).toBe(false)
  })

  it('getSessionSnapshot 返回消息 + 元数据 + 状态', async () => {
    const sid = manager.createSession({ type: 'project', title: '快照测试', workspaceId: 'ws-1' })
    const store = manager.getStore(sid)!
    store.addMessage(makeUserMessage('m1', '你好'))
    store.emit({ isStreaming: true })

    const snap = await kernel.getSessionSnapshot(sid)
    expect(snap.sessionId).toBe(sid)
    expect(snap.messages).toHaveLength(1)
    expect(snap.messages[0].content).toBe('你好')
    expect(snap.metadata.title).toBe('快照测试')
    expect(snap.metadata.workspaceId).toBe('ws-1')
    expect(snap.state).toBe('running')
  })

  it('getMessages 返回 store 消息', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.addMessage(makeUserMessage('m1', 'hi'))
    expect(await kernel.getMessages(sid)).toHaveLength(1)
    expect(await kernel.getMessages('no-such')).toEqual([])
  })

  it('subscribe：isStreaming / error 变化时回调，返回取消函数', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    const handler = vi.fn()
    const unsub = kernel.subscribe(sid, handler)

    store.emit({ isStreaming: true })
    expect(handler).toHaveBeenCalledTimes(1)
    const [next] = handler.mock.calls[0]
    expect(next.isStreaming).toBe(true)
    expect(next.state).toBe('running')

    // 无变化（仅消息增长）不回调
    store.addMessage(makeUserMessage('m2', 'x'))
    store.emit({ isStreaming: true })
    expect(handler).toHaveBeenCalledTimes(1)

    store.emit({ isStreaming: false })
    expect(handler).toHaveBeenCalledTimes(2)

    unsub()
    store.emit({ isStreaming: true })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  // ==========================================================================
  // 能力 4：事件处理（KernelEvent → AIEvent 映射）
  // ==========================================================================

  it('handleEvent: session_start / session_end / error 映射为 AIEvent 并 dispatch', () => {
    manager.createSession({ type: 'free' })

    kernel.handleEvent({ type: 'session_start', sessionId: 'conv-1', engineId: 'claude-code' })
    expect(manager.dispatchEvents[0]).toEqual({ type: 'session_start', sessionId: 'conv-1', engineId: 'claude-code' })
    // dispatchEvent 模拟 eventHandler：session_start → 会话流式
    const store = manager.getStore('conv-1')
    // 注意：dispatchSessionId 用 event.sessionId（后端 conv id），这里 manager 无此 store 时跳过
    expect(store).toBeUndefined()

    kernel.handleEvent({ type: 'session_end', sessionId: 'conv-1', reason: 'completed' })
    expect(manager.dispatchEvents[1]).toEqual({ type: 'session_end', sessionId: 'conv-1', reason: 'completed' })

    kernel.handleEvent({ type: 'error', sessionId: 'conv-1', errorMessage: 'boom' })
    expect(manager.dispatchEvents[2]).toEqual({ type: 'error', sessionId: 'conv-1', error: 'boom' })
  })

  it('handleEvent: user_message / assistant_message 映射', () => {
    kernel.handleEvent({ type: 'user_message', sessionId: 'conv-1', content: 'hi', clientMessageId: 'cm-1' })
    expect(manager.dispatchEvents[0]).toEqual({
      type: 'user_message',
      sessionId: 'conv-1',
      content: 'hi',
      clientMessageId: 'cm-1',
    })

    kernel.handleEvent({ type: 'assistant_message', sessionId: 'conv-1', content: 'reply' })
    expect(manager.dispatchEvents[1]).toEqual({
      type: 'assistant_message',
      sessionId: 'conv-1',
      content: 'reply',
      isDelta: true,
    })
  })

  it('handleEvent: session_start 事件经 dispatch 后更新会话流式状态（事件副本验证）', () => {
    // 用后端 conversationId 作为 sessionId 建立 store（真实场景中 dispatchEvent 反向索引续接）
    const sid = manager.createSession({ type: 'free', id: 'front-1' })
    void sid
    manager.registerSimpleMapping('conv-9', 'front-1')
    kernel.handleEvent({ type: 'session_start', sessionId: 'conv-9' })
    const frontStore = manager.getStore('front-1')
    expect(frontStore!.isStreaming).toBe(true)
    kernel.handleEvent({ type: 'session_end', sessionId: 'conv-9', reason: 'completed' })
    expect(frontStore!.isStreaming).toBe(false)
  })

  // ==========================================================================
  // 能力 5：恢复与同步
  // ==========================================================================

  it('restoreFromHistory 委托 historyService，返回新会话 ID', async () => {
    const sid = manager.createSession({ type: 'free', id: 'restored-1' })
    const result = await kernel.restoreFromHistory('hist-1')
    expect(historyService.restoreFromHistory).toHaveBeenCalledWith('hist-1')
    expect(result).toBe(sid)
  })

  it('restoreFromHistory 失败 → 抛错', async () => {
    historyService.restoreFromHistory.mockResolvedValueOnce(false)
    await expect(kernel.restoreFromHistory('hist-x')).rejects.toThrow()
  })

  it('resyncSession：磁盘有缺失消息 → 追加（幂等不覆盖）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-resync-1' })
    // 本地已有 m1
    store.addMessage(makeUserMessage('m1', '本地'))
    // 磁盘有 m1 + m2（m1 相同 id 应跳过，只补 m2）
    dialogStorageService.hasConversation.mockResolvedValueOnce(true)
    dialogStorageService.getConversationMessages.mockResolvedValueOnce([
      makeUserMessage('m1', '本地'), // 同 id → 跳过
      makeUserMessage('m2', '磁盘新增'),
    ])

    await kernel.resyncSession(sid)
    expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(store.messages[1].content).toBe('磁盘新增')
  })

  it('resyncSession：无 conversationId / 磁盘无记录 → no-op', async () => {
    const sid = manager.createSession({ type: 'free' })
    // 无 conversationId
    await kernel.resyncSession(sid)
    expect(dialogStorageService.hasConversation).not.toHaveBeenCalled()

    // 有 conversationId 但磁盘无
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-x' })
    await kernel.resyncSession(sid)
    expect(dialogStorageService.hasConversation).toHaveBeenCalledWith('conv-x')
    expect(dialogStorageService.getConversationMessages).not.toHaveBeenCalled()
  })

  // ==========================================================================
  // 行为零变化：kernel 只透传，不包装额外语义
  // ==========================================================================

  it('kernel 方法不会向 store 写入额外状态（行为零变化）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    const before = JSON.stringify(store.state)
    await kernel.sendMessage({ sessionId: sid, content: 'hi' })
    await kernel.continueChat(sid, '继续')
    // FakeConversationStore 的 sendMessage/continueChat 是 no-op，不发消息流，
    // 因此状态不变是预期（真实 store 会通过事件回流更新——那是现有路径，影子不变）。
    expect(JSON.stringify(store.state)).toBe(before)
  })
})