/**
 * 跨端只读会话跟随（批 3，裁决方案 M2 核心场景）
 *
 * 场景：桌面端会话正在流式输出，手机/浏览器打开本端——此前事件路由 key 是
 * 发起端的本地 UUID，本端匹配不到 store，事件全部丢弃（审计 1.1「全员听得到、
 * 无人路由得到」），既看不到会话也看不到流。
 *
 * 机制（范式=MultiChat 插件已验证，旁路 conversationStore/eventRouter 零侵入）：
 * - 发现：轮询 session_event_read_after_seq（全局 lifecycle 日志 start/end/error，
 *   低量），推导「有 session_start 无 session_end」的 running 会话——独立于
 *   本端 store（修正 webReconnectResync 只遍历本端 stores 的盲区，审计 1.7 缺口3）。
 * - 回补：打开会话时 message_read(conversationId) 拉后端已落库消息（含批 1
 *   扩展落库的 plan/权限/提问卡片块与错误文本）。
 * - 实时：原始 chat-event 订阅，按 payload.sessionId（引擎 conversationId）
 *   归集增量（T1 文本/思考/结束/错误 + T2 工具卡基础态；T3 卡片实时可见，
 *   历史回补缺失为已知边界——依赖 turn_persist 覆盖面落地节奏）。
 *
 * 冻结条款（裁决方案批 3 修正条款）：本模块只读——不发送/不中断/不回答卡片。
 * 退役条件（批 5 已于 2026-10-24 落地反向索引路由：跨端事件可按引擎
 * conversationId 精确投递到本端持有该会话的 store）：反向索引路由稳定运行
 * 一个版本周期后，本模块降级为诊断视图或删除流式渲染逻辑——「远端面板 +
 * 主 UI」双渲染语义不长期并存（防第二系统，裁决方案评委 B 条款 1）。
 */

import { createStore } from 'zustand'
import { invoke, listen } from '@/services/transport'
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'

const log = createLogger('RemoteSessionFollower')

/** 发现轮询间隔（lifecycle 日志低量，2s 足够「<2s 见会话」验收） */
const DISCOVERY_INTERVAL_MS = 2000

/** 跟随视图的单条消息（T1/T2 渲染面） */
export interface FollowerMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  thinking?: string
  toolCalls?: FollowerToolCall[]
  streaming?: boolean
  interrupted?: boolean
  errorMessage?: string
  timestamp: number
}

export interface FollowerToolCall {
  id: string
  name: string
  status: 'running' | 'completed' | 'failed'
  output?: string
}

export interface RemoteSessionState {
  conversationId: string
  engineId?: string
  status: 'running' | 'ended'
  startedAt: number
  endedAt?: number
  endReason?: string
  messages: FollowerMessage[]
  /** 回补完成（打开后拉过后端消息库） */
  backfilled: boolean
}

interface RemoteFollowerStoreState {
  sessions: Map<string, RemoteSessionState>
  /** 当前打开查看的会话（overlay 用） */
  viewingConversationId: string | null
  followerStarted: boolean

  startFollower: () => void
  stopFollower: () => void
  openSession: (conversationId: string) => Promise<void>
  closeSession: () => void
}

const store = createStore<RemoteFollowerStoreState>((set, get) => ({
  sessions: new Map(),
  viewingConversationId: null,
  followerStarted: false,

  startFollower: () => {
    if (get().followerStarted) return
    set({ followerStarted: true })
    void discoveryLoop()
    attachLiveListener()
    log.info('跨端会话跟随已启动')
  },

  stopFollower: () => {
    set({ followerStarted: false })
    if (discoveryTimer) {
      clearInterval(discoveryTimer)
      discoveryTimer = null
    }
    if (liveUnlisten) {
      liveUnlisten()
      liveUnlisten = null
    }
  },

  openSession: async (conversationId: string) => {
    set({ viewingConversationId: conversationId })
    await backfillSession(conversationId)
  },

  closeSession: () => set({ viewingConversationId: null }),
}))

// ============================================================================
// 发现：lifecycle 日志轮询
// ============================================================================

let discoveryTimer: ReturnType<typeof setInterval> | null = null
let lastSeq = 0

async function discoveryLoop(): Promise<void> {
  if (discoveryTimer) return
  // 初始化水位：从当前最大 seq 起步（冷启动不增量回放——running 集合由
  // 一次性全量查询 seedRunningSessions 补齐），此后只增量轮询。
  try {
    lastSeq = await invoke<number>('session_event_current_seq', {})
  } catch {
    lastSeq = 0
  }
  await seedRunningSessions().catch((e) =>
    log.warn('running 会话全量补齐失败', { error: String(e) }),
  )
  discoveryTimer = setInterval(() => {
    void pollOnce().catch((e) => log.debug('发现轮询失败', { error: String(e) }))
  }, DISCOVERY_INTERVAL_MS)
}

/** 冷启动全量：读全部 lifecycle 事件推导当前 running 集合 */
async function seedRunningSessions(): Promise<void> {
  const events = await invoke<RemoteLifecycleEvent[]>('session_event_read_after_seq', { seq: 0 })
  const state = new Map<string, RemoteSessionState>()
  for (const ev of events) {
    if (isIgnorableConversation(ev.conversationId)) continue
    if (ev.type === 'session_start') {
      if (!state.has(ev.conversationId)) {
        state.set(ev.conversationId, {
          conversationId: ev.conversationId,
          status: 'running',
          startedAt: ev.timestamp,
          messages: [],
          backfilled: false,
        })
      }
    } else if (ev.type === 'session_end' || ev.type === 'error') {
      const s = state.get(ev.conversationId)
      if (s) {
        s.status = 'ended'
        s.endedAt = ev.timestamp
        s.endReason = ev.reason ?? undefined
      }
    }
    lastSeq = Math.max(lastSeq, ev.seq)
  }
  applyDiscovered(state)
}

interface RemoteLifecycleEvent {
  id: string
  conversationId: string
  type: 'session_start' | 'session_end' | 'error'
  timestamp: number
  deviceId: string
  seq: number
  reason?: string | null
  errorMessage?: string | null
}

/** 增量轮询：新事件合并进 sessions（不改既有回补/消息状态） */
async function pollOnce(): Promise<void> {
  const events = await invoke<RemoteLifecycleEvent[]>('session_event_read_after_seq', {
    seq: lastSeq,
  })
  if (events.length === 0) return
  for (const ev of events) {
    lastSeq = Math.max(lastSeq, ev.seq)
    if (isIgnorableConversation(ev.conversationId)) continue
    if (ev.type === 'session_start') {
      upsertSession(ev.conversationId, {
        status: 'running',
        startedAt: ev.timestamp,
      })
    } else if (ev.type === 'session_end' || ev.type === 'error') {
      upsertSession(ev.conversationId, {
        status: 'ended',
        endedAt: ev.timestamp,
        endReason: ev.reason ?? undefined,
      })
    }
  }
}

/** 伪会话（批 1 的 pending-<context> 用户消息暂存）与 start 排他占位不进跟随列表 */
function isIgnorableConversation(conversationId: string): boolean {
  return (
    conversationId.startsWith('pending-') ||
    conversationId.startsWith('start-gate-') ||
    conversationId === '__no_context__'
  )
}

function upsertSession(conversationId: string, patch: Partial<RemoteSessionState>): void {
  const cur = store.getState().sessions
  const existing = cur.get(conversationId)
  // 本端已持有该会话（发起端是本设备）：本地 store 已在渲染，跟随列表隐藏，
  // 避免同一会话两份视图（裁决方案批 3 定位=「另一端看不到」的补位）。
  if (!existing && isLocalConversation(conversationId)) return

  const next = existing ?? {
    conversationId,
    status: 'running' as const,
    startedAt: Date.now(),
    messages: [],
    backfilled: false,
  }
  const merged = { ...next, ...patch }
  const newMap = new Map(cur)
  newMap.set(conversationId, merged)
  store.setState({ sessions: newMap })
}

function applyDiscovered(state: Map<string, RemoteSessionState>): void {
  const cur = store.getState().sessions
  const newMap = new Map<string, RemoteSessionState>()
  for (const [id, s] of state) {
    if (isLocalConversation(id)) continue
    const existing = cur.get(id)
    newMap.set(
      id,
      existing
        ? { ...existing, ...s, messages: existing.messages, backfilled: existing.backfilled }
        : s,
    )
  }
  // 保留本地已打开（含已回补消息/已实时累积）的条目与既有状态
  for (const [id, s] of cur) {
    if (!newMap.has(id)) newMap.set(id, s)
  }
  store.setState({ sessions: newMap })
}

function isLocalConversation(conversationId: string): boolean {
  try {
    const stores = sessionStoreManager.getState().stores
    for (const s of stores.values()) {
      if (s.getState().conversationId === conversationId) return true
    }
  } catch {
    // manager 不可用（极端 mock 环境）：按非本地处理
  }
  return false
}

// ============================================================================
// 回补：后端消息库快照
// ============================================================================

interface BackendMessageEntry {
  id: string
  conversationId: string
  role: string
  timestamp: number
  content: {
    id?: string
    type?: string
    content?: string
    blocks?: Array<Record<string, unknown>>
    timestamp?: string
    interrupted?: boolean
    errorMessage?: string
  }
}

/** 打开会话时拉取后端已落库消息（幂等；ended 会话同样可回补完整历史） */
async function backfillSession(conversationId: string): Promise<void> {
  const s = store.getState().sessions.get(conversationId)
  if (!s || s.backfilled) return
  try {
    const entries = await invoke<BackendMessageEntry[]>('message_read', {
      conversationId,
      afterTimestamp: null,
      limit: null,
    })
    const messages: FollowerMessage[] = []
    for (const e of entries) {
      messages.push(entryToFollowerMessage(e))
    }
    if (messages.length > 0) {
      upsertSession(conversationId, { messages, backfilled: true })
    } else {
      upsertSession(conversationId, { backfilled: true })
    }
  } catch (e) {
    log.warn('回补会话消息失败', { conversationId, error: String(e) })
  }
}

function entryToFollowerMessage(e: BackendMessageEntry): FollowerMessage {
  const c = e.content ?? {}
  let text = ''
  let thinking = ''
  const toolCalls: FollowerToolCall[] = []
  if (typeof c.content === 'string') {
    text = c.content
  }
  for (const b of c.blocks ?? []) {
    const type = b['type']
    if (type === 'text' && typeof b['content'] === 'string') {
      text += b['content']
    } else if (type === 'thinking' && typeof b['content'] === 'string') {
      thinking += b['content']
    } else if (type === 'tool_call') {
      toolCalls.push({
        id: String(b['id'] ?? ''),
        name: String(b['name'] ?? ''),
        status: (b['status'] as FollowerToolCall['status']) ?? 'running',
        output: typeof b['output'] === 'string' ? b['output'] : undefined,
      })
    }
  }
  return {
    id: e.id,
    role: c.type === 'user' || e.role === 'user' ? 'user' : 'assistant',
    text,
    thinking: thinking || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    interrupted: c.interrupted,
    errorMessage: c.errorMessage,
    timestamp: e.timestamp,
  }
}

// ============================================================================
// 实时：原始 chat-event 订阅（按引擎 conversationId 归集）
// ============================================================================

let liveUnlisten: (() => void) | null = null

interface ChatEnvelope {
  contextId?: string
  payload: Record<string, unknown> & { type?: string; sessionId?: string }
}

function attachLiveListener(): void {
  // listen 注册是异步的：注册完成前 stopFollower 已被调用则立即注销
  void listen<ChatEnvelope>('chat-event', (envelope) => {
    const payload = envelope?.payload
    if (!payload || typeof payload !== 'object') return
    const conversationId = payload['sessionId']
    if (typeof conversationId !== 'string' || !conversationId) return
    // 只跟踪已发现的远端会话（未发现的由发现轮询补录，避免乱序建立）
    const s = store.getState().sessions.get(conversationId)
    if (!s) return
    applyLiveEvent(conversationId, s, payload)
  }).then((unlisten) => {
    if (!store.getState().followerStarted) {
      unlisten()
      return
    }
    liveUnlisten = unlisten
  })
}

function applyLiveEvent(
  conversationId: string,
  s: RemoteSessionState,
  payload: Record<string, unknown>,
): void {
  const type = String(payload['type'] ?? '')
  const messages = [...s.messages]
  const ensureAssistant = (): FollowerMessage => {
    let last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant' || !last.streaming) {
      last = {
        id: `remote-${conversationId}-${Date.now()}`,
        role: 'assistant',
        text: '',
        streaming: true,
        timestamp: Date.now(),
      }
      messages.push(last)
    }
    return last
  }

  switch (type) {
    case 'user_message': {
      const content = String(payload['content'] ?? '')
      messages.push({
        id: String(payload['messageId'] ?? `remote-user-${Date.now()}`),
        role: 'user',
        text: content,
        timestamp: Date.now(),
      })
      break
    }
    case 'token':
    case 'assistant_message': {
      const m = ensureAssistant()
      const value = type === 'token' ? payload['value'] : payload['content']
      m.text += typeof value === 'string' ? value : ''
      break
    }
    case 'thinking': {
      const m = ensureAssistant()
      m.thinking = (m.thinking ?? '') + String(payload['content'] ?? '')
      break
    }
    case 'tool_call_start': {
      const m = ensureAssistant()
      m.toolCalls = [
        ...(m.toolCalls ?? []),
        {
          id: String(payload['callId'] ?? `t-${Date.now()}`),
          name: String(payload['tool'] ?? ''),
          status: 'running',
        },
      ]
      break
    }
    case 'tool_call_end': {
      const m = ensureAssistant()
      const callId = String(payload['callId'] ?? '')
      const list = m.toolCalls ?? []
      const idx = callId ? list.findIndex((t) => t.id === callId) : list.length - 1
      if (idx >= 0 && list[idx]) {
        list[idx] = {
          ...list[idx],
          status: payload['success'] === false ? 'failed' : 'completed',
          output: typeof payload['result'] === 'string' ? payload['result'] : undefined,
        }
        m.toolCalls = [...list]
      }
      break
    }
    case 'session_end': {
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') {
        last.streaming = false
        if (payload['reason'] && payload['reason'] !== 'completed') {
          last.interrupted = true
        }
      }
      upsertSession(conversationId, {
        messages,
        status: 'ended',
        endedAt: Date.now(),
        endReason: String(payload['reason'] ?? ''),
      })
      return
    }
    case 'error': {
      const last = messages[messages.length - 1]
      if (last?.role === 'assistant') {
        last.streaming = false
        last.errorMessage = String(payload['error'] ?? '未知错误')
      }
      break
    }
    default:
      // T3 卡片类（question/plan/permission/plugin_card）实时不渲染进跟随视图
      // （只读视图的已知边界，裁决方案批 3 修正条款 C-1）
      return
  }
  upsertSession(conversationId, { messages })
}

// ============================================================================
// 对外 API
// ============================================================================

/**
 * 把远端会话接入本端窗口（spec：remote-session-join-v2 §2.2，能力层）。
 *
 * 复用既有管线，零新增后端代码：
 * - createSessionFromHistory 建本端会话格（消息源 = message_read 后端权威，
 *   conversationId 挂上 store）→ 反向索引路由此后自动把实时事件投进本端 store；
 * - 加入后发送走 continue 到同一引擎会话；双端并发由后端 try_start 单写者
 *   仲裁拒绝（reason 带启动设备）；
 * - is_chat_session_running 校正流式状态（对齐 webReconnectResync 恢复语义）；
 * - 从跟随列表移除该条目（isLocalConversation 过滤天然阻止再收录，防双入口）。
 *
 * @returns 本端新会话 id；失败返回 null（调用方 toast）
 */
export async function joinRemoteSession(conversationId: string): Promise<string | null> {
  const s = store.getState().sessions.get(conversationId)
  if (!s) {
    log.warn('加入失败：会话不在跟随列表', { conversationId })
    return null
  }
  if (isLocalConversation(conversationId)) {
    log.info('该会话已在本端，直接切换', { conversationId })
    return null
  }

  try {
    const { invoke } = await import('@/services/transport')
    const { sessionStoreManager } = await import('@/stores/conversationStore/sessionStoreManager')
    const { useViewStore } = await import('@/stores/viewStore')

    // ① 元数据：投影优先（title/engineId），降级首条用户消息截断标题
    let title = shortConversationTitle(conversationId)
    let engineId: string | undefined = s.engineId
    try {
      const indexResult = await invoke<{ sessions: Array<Record<string, unknown>> }>(
        'session_index_list',
        { workspaceKey: 'default' },
      )
      const row = indexResult?.sessions?.find(
        (r) => r['conversationId'] === conversationId,
      )
      if (row) {
        if (typeof row['title'] === 'string' && row['title'].trim()) title = row['title']
        if (typeof row['engineId'] === 'string' && row['engineId']) engineId = row['engineId']
      }
    } catch {
      // 投影查询失败：走降级链（标题用 conversationId 短标识）
    }

    // ② 后端权威消息快照 → ChatMessage[]
    const entries = await invoke<Array<{ content: Record<string, unknown> }>>('message_read', {
      conversationId,
      afterTimestamp: null,
      limit: null,
    })
    const messages = entries.map((e) => e.content)
    if (messages.length === 0) {
      // 空会话（极端：用户消息尚未落库即加入）：用首条用户消息文本生成标题
      const firstUser = s.messages.find((m) => m.role === 'user')
      if (firstUser?.text) title = firstUser.text.slice(0, 24)
    } else if (title === shortConversationTitle(conversationId)) {
      const firstUserEntry = messages.find((m) => m['type'] === 'user')
      const c = firstUserEntry?.['content']
      if (typeof c === 'string' && c.trim()) title = c.slice(0, 24)
    }

    // ③ 建本端会话格（createSessionFromHistory 把 conversationId 挂上 store）
    const manager = sessionStoreManager.getState()
    const sessionId = manager.createSessionFromHistory(messages as never, conversationId, {
      title,
      engineId,
    })
    useViewStore.getState().addToMultiView(sessionId)
    manager.switchSession(sessionId)

    // ④ 校正流式状态：远端仍在流式 → 本端 setStreaming(true) 接实时续流
    const store2 = manager.stores.get(sessionId)
    if (store2) {
      try {
        const running = await invoke<{ running: boolean }>('is_chat_session_running', {
          sessionId: conversationId,
        })
        if (running?.running) {
          store2.getState().setStreaming(true)
        }
      } catch {
        // 查询失败保守不置位（实时 session_end 到达仍会正常收尾）
      }
    }

    // ⑤ 从跟随列表移除（防双入口）
    removeFollowerEntry(conversationId)

    log.info('远端会话已加入本端窗口', { conversationId, sessionId, title, engineId })
    return sessionId
  } catch (e) {
    log.error('加入远端会话失败', e instanceof Error ? e : new Error(String(e)), {
      conversationId,
    })
    return null
  }
}

function shortConversationTitle(conversationId: string): string {
  return conversationId.length > 14 ? `${conversationId.slice(0, 12)}…` : conversationId
}

function removeFollowerEntry(conversationId: string): void {
  const cur = store.getState().sessions
  if (!cur.has(conversationId)) return
  const next = new Map(cur)
  next.delete(conversationId)
  store.setState({ sessions: next })
}

export const remoteSessionFollower = {
  start: () => store.getState().startFollower(),
  stop: () => store.getState().stopFollower(),
  openSession: (conversationId: string) => store.getState().openSession(conversationId),
  closeSession: () => store.getState().closeSession(),
  /** 一键加入：远端会话 → 本端正式会话格（spec remote-session-join-v2 §2.2） */
  joinSession: (conversationId: string) => joinRemoteSession(conversationId),
  /** 组件用 useStore(store, selector) 订阅 */
  store,
}

/** 当前 running 的远端会话（列表用，按启动时间倒序） */
export function getRunningRemoteSessions(): RemoteSessionState[] {
  const all = [...store.getState().sessions.values()]
  return all
    .filter((s) => s.status === 'running')
    .sort((a, b) => b.startedAt - a.startedAt)
}
