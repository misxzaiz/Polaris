/**
 * V2SessionKernel 后端权威验证 — 阶段 4
 *
 * 验证 V2SessionKernel（后端权威实现）：
 * - 4.1 sendMessage：委托 store.sendMessage 返回 conversationId
 * - 4.2 getSessionState：调后端 session_get_status 查询，不读本地 isStreaming
 * - 4.3 resyncSession：快照合并（diff 本地 → 只追加缺失），恢复期间新事件不丢失
 * - 4.4 handleEvent：统一事件入口，KernelEvent → AIEvent 映射后按 sessionId 路由
 *
 * 验证方式：注入内存替身（FakeManager / FakeStore / FakeArbiter / FakeSnapshot），
 * 配置后端状态（running/error/idle），断言内核状态推导与委托透传。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { V2SessionKernel } from '../kernel/v2-kernel'
import type { SessionStoreManager, ConversationStore, ConversationStoreInstance } from '@/stores/conversationStore/types'
import type { ChatMessage } from '@/types/chat'
import type { KernelEvent, SendResult } from '../kernel/types'
import type { AIEvent } from '@/ai-runtime'
import type { SessionStatus } from '../core/types'
import type { V2SessionKernelDeps } from '../kernel/v2-kernel'

// ============================================================================
// 内存替身（模拟 sessionStoreManager + 后端状态查询 + 快照来源）
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

  getState(): this { return this }
  get conversationId() { return this.state.conversationId }
  get isStreaming() { return this.state.isStreaming }
  get error() { return this.state.error }
  get messages() { return this.state.messages }

  async sendMessage(
    content: string,
    workspaceDir?: string,
    attachments?: unknown[],
    options?: unknown,
  ) {
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
  emit(patch: Partial<FakeStoreState>) {
    this.state = { ...this.state, ...patch }
    this.subscribers.forEach((fn) => fn())
  }
  /** 批次 4 restoreRegistry 用：setState 别名（真实 store instance 有 setState） */
  setState(patch: Partial<FakeStoreState>) {
    this.emit(patch)
  }
}

class FakeSessionManager {
  stores = new Map<string, FakeConversationStore>()
  sessionMetadata = new Map<string, { status?: string; title?: string; engineId?: string; workspaceId?: string | null; type?: string; silentMode?: boolean; createdAt?: string; updatedAt?: string }>()
  activeSessionId: string | null = null
  dispatchEvents: AIEvent[] = []
  calls: { method: string; args: unknown[] }[] = []
  private subscribers = new Set<() => void>()

  getState(): this { return this }

  createSession(options: { id?: string; type: 'project' | 'free'; workspaceId?: string; title?: string; engineId?: string; silentMode?: boolean; kind?: string; commitWorkspaceId?: string; forkFromId?: string }) {
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
  /** 批次 4 restoreRegistry：重建 conversationId → sessionId 反向索引 */
  registerConversationId(conversationId: string, sessionId: string) {
    this.calls.push({ method: 'registerConversationId', args: [conversationId, sessionId] })
  }
  unregisterConversationId(_conversationId: string) { /* noop */ }
  switchSession(sessionId: string) {
    this.calls.push({ method: 'switchSession', args: [sessionId] })
    this.activeSessionId = sessionId
  }
  getActiveSessionId(): string | null {
    return this.activeSessionId
  }
  getStore(sessionId: string) { return this.stores.get(sessionId) }
  interruptSession(sessionId: string) {
    this.calls.push({ method: 'interruptSession', args: [sessionId] })
    return Promise.resolve()
  }
  dispatchEvent(event: AIEvent) {
    this.calls.push({ method: 'dispatchEvent', args: [event] })
    this.dispatchEvents.push(event)
    const targetStore = this.stores.get(event.sessionId)
    if (event.type === 'session_start' && targetStore) {
      targetStore.emit({ isStreaming: true, conversationId: event.sessionId })
    } else if (event.type === 'session_end' && targetStore) {
      targetStore.emit({ isStreaming: false })
    }
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

function makeStatus(overrides?: Partial<SessionStatus>): SessionStatus {
  return {
    conversationId: 'conv-1',
    running: false,
    lastEventSeq: 3,
    error: null,
    startedAt: 1000,
    endedAt: null,
    startedByDevice: null,
    ...overrides,
  }
}

function makeDeps(overrides?: Partial<V2SessionKernelDeps>) {
  const manager = new FakeSessionManager()
  const historyService = { restoreFromHistory: vi.fn(async () => true) }
  const stateArbiter = { getStatus: vi.fn(async (conversationId: string) => makeStatus({ conversationId })) }
  const streamDispatch = vi.fn(async () => 'ack')
  const snapshotSource = { getSnapshot: vi.fn(async () => [] as ChatMessage[]) }
  const registryClient = { list: vi.fn(async () => [] as Array<{ id: string; conversationId: string | null }>) }
  const deps: V2SessionKernelDeps = {
    sessionStoreManager: manager as unknown as V2SessionKernelDeps['sessionStoreManager'],
    historyService: historyService as unknown as V2SessionKernelDeps['historyService'],
    eventDispatcher: manager.getState() as unknown as V2SessionKernelDeps['eventDispatcher'],
    stateArbiter: stateArbiter as unknown as V2SessionKernelDeps['stateArbiter'],
    streamDispatch: streamDispatch as unknown as V2SessionKernelDeps['streamDispatch'],
    snapshotSource: snapshotSource as unknown as V2SessionKernelDeps['snapshotSource'],
    registryClient: registryClient as unknown as V2SessionKernelDeps['registryClient'],
    ...overrides,
  }
  return { deps, manager, historyService, stateArbiter, snapshotSource, registryClient }
}

describe('V2SessionKernel 后端权威验证（阶段 4）', () => {
  let deps: V2SessionKernelDeps
  let manager: FakeSessionManager
  let stateArbiter: { getStatus: ReturnType<typeof vi.fn> }
  let snapshotSource: { getSnapshot: ReturnType<typeof vi.fn> }
  let kernel: V2SessionKernel

  beforeEach(() => {
    const built = makeDeps()
    deps = built.deps
    manager = built.manager
    stateArbiter = built.stateArbiter
    snapshotSource = built.snapshotSource
    kernel = new V2SessionKernel(deps)
  })

  // ==========================================================================
  // 4.1 消息发送（委托 store.sendMessage）
  // ==========================================================================

  it('sendMessage 委托 store.sendMessage，返回对话 ID', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    const result = await kernel.sendMessage({ sessionId: sid, content: 'hello' })
    expect(result.ok).toBe(true)
    expect(store.calls.some((c) => c.method === 'sendMessage' && c.args[0] === 'hello')).toBe(true)
  })

  it('sendMessage 会话不存在 → ok=false，不抛错', async () => {
    const result = await kernel.sendMessage({ sessionId: 'no-such', content: 'x' })
    expect(result.ok).toBe(false)
    expect(result.reason).toBeDefined()
  })

  it('continueChat 附加上下文拼入 prompt', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    await kernel.continueChat(sid, '继续', { extraContext: '上下文' })
    expect(store.calls.some((c) => c.method === 'continueChat' && c.args[0] === '继续\n\n上下文')).toBe(true)
  })

  it('批次 3：sendMessage 完整透传 workspaceDir / attachments / sendOptions 4 参', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    const attachments = [{ id: 'a1', type: 'image', fileName: 'x.png', fileSize: 1, mimeType: 'image/png' }]
    const sendOptions = { oneTimeSystemPrompt: '人格', runtimeOverride: { permissionMode: 'bypassPermissions' } }
    await kernel.sendMessage({
      sessionId: sid,
      content: '带附件',
      workspaceDir: '/ws',
      attachments,
      sendOptions,
    })
    const call = store.calls.find((c) => c.method === 'sendMessage')
    expect(call?.args[0]).toBe('带附件')
    expect(call?.args[1]).toBe('/ws')
    expect(call?.args[2]).toEqual(attachments)
    expect(call?.args[3]).toEqual(sendOptions)
  })

  it('批次 3：continueChat 透传 allowedTools', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    await kernel.continueChat(sid, '继续', { allowedTools: ['bash', 'read'] })
    const call = store.calls.find((c) => c.method === 'continueChat')
    expect(call?.args[0]).toBe('继续')
    expect(call?.args[1]).toEqual(['bash', 'read'])
  })

  it('interrupt / regenerate / editAndResend 委托对应方法', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    await kernel.interrupt(sid)
    await kernel.regenerate(sid, 'assistant-1')
    await kernel.editAndResend(sid, 'user-1', '新内容')
    expect(manager.calls.some((c) => c.method === 'interruptSession' && c.args[0] === sid)).toBe(true)
    expect(store.calls.some((c) => c.method === 'regenerateResponse' && c.args[0] === 'assistant-1')).toBe(true)
    expect(store.calls.some((c) => c.method === 'editAndResend' && c.args[0] === 'user-1' && c.args[1] === '新内容')).toBe(true)
  })

  // ==========================================================================
  // 4.2 getSessionState（后端权威，不读本地 isStreaming）
  // ==========================================================================

  it('getSessionState：会话不存在 → none（不查询后端）', async () => {
    const state = await kernel.getSessionState('no-such')
    expect(state.state).toBe('none')
    expect(state.isStreaming).toBe(false)
    expect(stateArbiter.getStatus).not.toHaveBeenCalled()
  })

  it('getSessionState：前端已创建但无 conversationId → idle 本地兜底（不查询后端）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ isStreaming: false, error: null })
    const state = await kernel.getSessionState(sid)
    expect(state.state).toBe('idle')
    expect(state.isStreaming).toBe(false)
    expect(stateArbiter.getStatus).not.toHaveBeenCalled()
  })

  it('getSessionState：调后端 session_get_status，running 推导 isStreaming', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-1' })
    // 本地 isStreaming=false（前端不自行维护），后端 running=true
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: true, lastEventSeq: 8 }))

    const state = await kernel.getSessionState(sid)
    expect(stateArbiter.getStatus).toHaveBeenCalledWith('conv-1')
    expect(state.state).toBe('running')
    expect(state.isStreaming).toBe(true)
    expect(state.lastEventSeq).toBe(8)
  })

  it('getSessionState：后端 error → state=error 且透传错误', async () => {
    const sid = manager.createSession({ type: 'free' })
    manager.getStore(sid)!.emit({ conversationId: 'conv-2' })
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: false, error: '引擎崩溃' }))
    const state = await kernel.getSessionState(sid)
    expect(state.state).toBe('error')
    expect(state.error).toBe('引擎崩溃')
  })

  it('getSessionState：后端 idle → state=idle / isStreaming=false', async () => {
    const sid = manager.createSession({ type: 'free' })
    manager.getStore(sid)!.emit({ conversationId: 'conv-3' })
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: false, endedAt: 5000 }))
    const state = await kernel.getSessionState(sid)
    expect(state.state).toBe('idle')
    expect(state.isStreaming).toBe(false)
    expect(state.endedAt).toBe(5000)
  })

  it('getSessionState：后端查询失败 → 降级本地快照（不抛错）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-err', isStreaming: true })
    stateArbiter.getStatus.mockRejectedValueOnce(new Error('network'))
    const state = await kernel.getSessionState(sid)
    expect(state.state).toBe('running')
    expect(state.isStreaming).toBe(true) // 降级用本地快照（仅兜底）
  })

  it('getSessionSnapshot 返回消息 + 元数据 + 后端权威状态', async () => {
    const sid = manager.createSession({ type: 'project', title: '快照', workspaceId: 'ws-1' })
    const store = manager.getStore(sid)!
    store.addMessage(makeUserMessage('m1', '你好'))
    store.emit({ conversationId: 'conv-snap' })
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: true }))
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: true, lastEventSeq: 11 }))

    const snap = await kernel.getSessionSnapshot(sid)
    expect(snap.messages).toHaveLength(1)
    expect(snap.metadata.title).toBe('快照')
    expect(snap.state).toBe('running')
    expect(snap.lastEventSeq).toBe(11)
  })

  it('getMessages 返回 store 消息', async () => {
    const sid = manager.createSession({ type: 'free' })
    manager.getStore(sid)!.addMessage(makeUserMessage('m1', 'hi'))
    expect(await kernel.getMessages(sid)).toHaveLength(1)
  })

  // ==========================================================================
  // 4.3 resyncSession（快照合并，非全量覆盖；恢复期间新事件不丢失）
  // ==========================================================================

  it('resyncSession：快照合并只追加缺失消息（幂等）', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-resync' })
    store.addMessage(makeUserMessage('m1', '本地'))
    snapshotSource.getSnapshot.mockResolvedValueOnce([
      makeUserMessage('m1', '本地'), // 同 id → 跳过
      makeUserMessage('m2', '磁盘新增'),
    ])

    await kernel.resyncSession(sid)
    expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2'])
    expect(store.messages[1].content).toBe('磁盘新增')
  })

  it('resyncSession：恢复期间新事件产生的消息不丢失', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-resync-2' })
    store.addMessage(makeUserMessage('m1', '本地'))
    // 快照获取耗时窗口内，新事件追加了 m2（本地已有）
    snapshotSource.getSnapshot.mockImplementationOnce(async () => {
      store.addMessage(makeUserMessage('m2', '恢复期间新事件')) // 模拟并发新事件
      return [
        makeUserMessage('m1', '本地'),
        makeUserMessage('m2', '恢复期间新事件'),
        makeUserMessage('m3', '磁盘快照'),
      ]
    })

    await kernel.resyncSession(sid)
    // m2 不被覆盖（本地优先），只补 m3 —— 新事件不丢失
    expect(store.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
    expect(store.messages[1].content).toBe('恢复期间新事件')
  })

  it('resyncSession：无 conversationId / 无快照 → no-op', async () => {
    const sid = manager.createSession({ type: 'free' })
    await kernel.resyncSession(sid)
    expect(snapshotSource.getSnapshot).not.toHaveBeenCalled()
  })

  it('restoreFromHistory 委托 historyService，失败抛错', async () => {
    const sid = manager.createSession({ type: 'free', id: 'restored-1' })
    const result = await kernel.restoreFromHistory('hist-1')
    expect(result).toBe(sid)
    deps.historyService.restoreFromHistory = vi.fn(async () => false)
    await expect(kernel.restoreFromHistory('hist-x')).rejects.toThrow()
  })

  // ==========================================================================
  // 4.5 restoreRegistry（批次 4：重启后重建 conversationIdToStoreId 反向索引）
  // ==========================================================================

  it('restoreRegistry：为被驱逐会话重建 store + 反向索引', async () => {
    // 后端注册表有 2 个会话，前端 store 均未创建（模拟重启）
    deps.registryClient.list = vi.fn(async () => [
      { id: 'reg-1', conversationId: 'conv-1', title: 't1', engineId: 'claude-code', silentMode: true },
      { id: 'reg-2', conversationId: 'conv-2', title: 't2', engineId: 'claude-code', silentMode: false },
    ])
    const count = await kernel.restoreRegistry()
    expect(count).toBe(2)
    // 静默重建会话壳
    expect(manager.getStore('reg-1')?.getState().conversationId).toBe('conv-1')
    expect(manager.getStore('reg-2')?.getState().conversationId).toBe('conv-2')
    // 反向索引已重建（事件路由可恢复）
    expect(manager.calls.some((c) => c.method === 'registerConversationId' && c.args[0] === 'conv-1' && c.args[1] === 'reg-1')).toBe(true)
    expect(manager.calls.some((c) => c.method === 'registerConversationId' && c.args[0] === 'conv-2' && c.args[1] === 'reg-2')).toBe(true)
  })

  it('restoreRegistry：已有 store 仅补齐 conversationId，不重复创建', async () => {
    const sid = manager.createSession({ type: 'free', id: 'existing-1' })
    deps.registryClient.list = vi.fn(async () => [
      { id: 'existing-1', conversationId: 'conv-x' },
    ])
    const before = manager.stores.size
    const count = await kernel.restoreRegistry()
    expect(count).toBe(1)
    expect(manager.stores.size).toBe(before) // 未重复创建
    expect(manager.getStore(sid)?.getState().conversationId).toBe('conv-x')
  })

  it('restoreRegistry：无 conversationId 记录跳过；后端失败返回 0', async () => {
    deps.registryClient.list = vi.fn(async () => [
      { id: 'no-conv', conversationId: null },
    ])
    expect(await kernel.restoreRegistry()).toBe(0)
    deps.registryClient.list = vi.fn(async () => { throw new Error('db down') })
    expect(await kernel.restoreRegistry()).toBe(0)
  })

  // ==========================================================================
  // 4.4 handleEvent（统一事件入口 + KernelEvent → AIEvent 映射）
  // ==========================================================================

  it('handleEvent: 各类 KernelEvent 映射为 AIEvent 并路由', () => {
    manager.createSession({ type: 'free' })
    kernel.handleEvent({ type: 'session_start', sessionId: 'conv-1', engineId: 'claude-code' })
    kernel.handleEvent({ type: 'session_end', sessionId: 'conv-1', reason: 'completed' })
    kernel.handleEvent({ type: 'error', sessionId: 'conv-1', errorMessage: 'boom' })
    kernel.handleEvent({ type: 'user_message', sessionId: 'conv-1', content: 'hi', clientMessageId: 'cm-1' })
    kernel.handleEvent({ type: 'assistant_message', sessionId: 'conv-1', content: 'reply' })

    expect(manager.dispatchEvents[0]).toEqual({ type: 'session_start', sessionId: 'conv-1', engineId: 'claude-code' })
    expect(manager.dispatchEvents[1]).toEqual({ type: 'session_end', sessionId: 'conv-1', reason: 'completed' })
    expect(manager.dispatchEvents[2]).toEqual({ type: 'error', sessionId: 'conv-1', error: 'boom' })
    expect(manager.dispatchEvents[3]).toEqual({ type: 'user_message', sessionId: 'conv-1', content: 'hi', clientMessageId: 'cm-1' })
    expect(manager.dispatchEvents[4]).toEqual({ type: 'assistant_message', sessionId: 'conv-1', content: 'reply', isDelta: true })
  })

  // ==========================================================================
  // 能力 2：会话生命周期
  // ==========================================================================

  it('createSession / deleteSession / switchSession / getActiveSessionId 委托 manager', async () => {
    const handle = await kernel.createSession({ type: 'project', title: '测试', silentMode: true })
    expect(handle.sessionId).toBeDefined()
    expect(manager.activeSessionId).toBeNull()

    const sid = manager.createSession({ type: 'free' })
    kernel.switchSession(sid)
    expect(kernel.getActiveSessionId()).toBe(sid)
    await kernel.deleteSession(sid)
    expect(manager.stores.has(sid)).toBe(false)
  })

  // ==========================================================================
  // subscribe（后端权威 + store/manager 双通道）
  // ==========================================================================

  it('subscribe：后端状态变化时回调，返回取消函数', async () => {
    const sid = manager.createSession({ type: 'free' })
    const store = manager.getStore(sid)!
    store.emit({ conversationId: 'conv-sub' })
    const handler = vi.fn()
    const unsub = kernel.subscribe(sid, handler)

    // 初始查询（后端 idle）
    await Promise.resolve()
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].isStreaming).toBe(false)

    // 后端翻转为 running → 事件驱动重新查询
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: true }))
    store.emit({})
    await Promise.resolve()
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(2)
    expect(handler.mock.calls[1][0].isStreaming).toBe(true)

    unsub()
    stateArbiter.getStatus.mockResolvedValueOnce(makeStatus({ running: false }))
    store.emit({})
    await Promise.resolve()
    await Promise.resolve()
    expect(handler).toHaveBeenCalledTimes(2)
  })
})