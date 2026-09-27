/**
 * SessionKernel 内核数据模型 — 阶段 0：纯类型 + 可执行状态机
 *
 * 依据 `03-地基级改造方案.md` 复审修正：
 * - 缺陷 2 修正：状态机必须是"代码能执行的"，不是 ASCII 图。
 *   定义转换函数 + 守卫条件 + 回滚策略。
 * - 缺陷 1 修正：不用 17 方法 SessionKernel 上帝接口，改为能力接口（见 capabilities.ts）。
 *
 * 三个状态机的权威归属（边界 A：前端 ←→ 后端）：
 * - MessageState 生命周期：drafted/sending 前端权威；active 及以后后端权威
 * - SessionState：后端权威，前端只能查询 + 订阅
 * - SyncState：后端权威（事件流 seq + 快照）
 */

// ============================================================================
// 引用现有基础类型（不重复定义）
// ============================================================================

import type { ChatMessage } from '@/types/chat'

// ============================================================================
// 1. Message Model — 可执行状态机
// ============================================================================

/**
 * 消息生命周期状态
 *
 * 权威归属：
 * - drafted / sending：前端权威（后端尚未确认）
 * - active / streaming / settled：后端权威（事件流）
 * - persisted：后端权威（SQLite 落盘）
 * - restored：前端恢复（从后端快照还原）
 */
export type MessageStateName =
  | 'drafted' // 前端创建，尚未发送
  | 'sending' // 前端调 aiChatDispatch，等待后端确认
  | 'active' // 后端已接收，进入 AI 处理流
  | 'streaming' // AI 正在流式输出（delta 事件）
  | 'settled' // AI 回复完成，消息定稿
  | 'persisted' // 已落盘，后端持久化为权威
  | 'restored' // 从磁盘/快照恢复到前端

/**
 * 消息状态转换守卫：前置条件
 *
 * 每个转换定义允许从哪些前置状态进入。
 * - `from: []` = 拒绝所有前置（初始状态，不可从其他状态转换回）
 * - `from` 省略 = 通配，允许从任何状态进入（如 restored 恢复覆盖）
 */
export interface MessageStateTransition {
  /** 转换后的状态 */
  to: MessageStateName
  /** 允许的前置状态（白名单）。省略 = 通配（允许从任何状态进入） */
  from?: MessageStateName[]
  /** 转换守卫：返回 false 则拒绝转换（如 active 需要后端已确认） */
  guard?: (ctx: { conversationId: string | null }) => boolean
  /** 转换副作用：状态变化后执行（用于触发持久化/广播） */
  onTransition?: () => void | Promise<void>
}

/**
 * 消息状态机定义（权威转换表）
 *
 * 非法转换（不在 from 白名单中的前置状态）会被状态机拒绝。
 */
export const MESSAGE_STATE_TRANSITIONS: MessageStateTransition[] = [
  { to: 'drafted', from: [] }, // 初始状态：不可从其他状态转换回
  { to: 'sending', from: ['drafted'], guard: ctx => !!ctx.conversationId || ctx.conversationId === null },
  { to: 'active', from: ['sending'], guard: ctx => !!ctx.conversationId },
  { to: 'streaming', from: ['active', 'streaming'], guard: ctx => !!ctx.conversationId },
  { to: 'settled', from: ['streaming', 'active'], guard: ctx => !!ctx.conversationId },
  { to: 'persisted', from: ['settled', 'active'], guard: ctx => !!ctx.conversationId },
  { to: 'restored' }, // 通配：任何状态都可被恢复覆盖（如本地草稿被后端快照替换）
]

/**
 * 消息状态机执行器（可测试的纯逻辑）
 *
 * 职责：
 * 1. 校验转换是否合法（from 白名单 + guard）
 * 2. 执行转换（更新状态 + 调用 onTransition 副作用）
 * 3. 失败时保持原状态（原子性，不产生部分状态）
 */
export class MessageStateMachine {
  private _state: MessageStateName
  /** 会话 ID（active 之后才有） */
  private _conversationId: string | null = null
  /** 最近一次被拒绝的转换（诊断用） */
  lastRejected: { from: MessageStateName; to: MessageStateName; reason: string } | null = null

  constructor(initial: MessageStateName = 'drafted') {
    this._state = initial
  }

  get state(): MessageStateName {
    return this._state
  }

  get conversationId(): string | null {
    return this._conversationId
  }

  /**
   * 请求状态转换
   * @returns true = 成功；false = 被拒绝（保持原状态，原子性）
   */
  async transition(to: MessageStateName, ctx: { conversationId?: string | null } = {}): Promise<boolean> {
    const rule = MESSAGE_STATE_TRANSITIONS.find(t => t.to === to)
    if (!rule) {
      this.lastRejected = { from: this._state, to, reason: `未定义转换规则: ${to}` }
      return false
    }

    // 守卫 1：前置状态白名单（from 省略 = 通配）
    if (rule.from && !rule.from.includes(this._state)) {
      this.lastRejected = {
        from: this._state,
        to,
        reason: `非法转换: ${this._state} → ${to}（允许的前置: ${rule.from.join(', ') || '无'}）`,
      }
      return false
    }

    // 守卫 2：自定义 guard
    if (rule.guard && !rule.guard({ conversationId: ctx.conversationId ?? this._conversationId })) {
      this.lastRejected = {
        from: this._state,
        to,
        reason: `守卫拒绝: ${this._state} → ${to}`,
      }
      return false
    }

    // 执行转换（先更新状态，再执行副作用；副作用失败不回滚状态——状态已推进，由上层补偿）
    if (ctx.conversationId != null) this._conversationId = ctx.conversationId
    this._state = to
    this.lastRejected = null

    if (rule.onTransition) {
      await rule.onTransition()
    }
    return true
  }

  /** 测试辅助：检查某个转换是否合法（不执行，含 guard 预检） */
  canTransition(to: MessageStateName): boolean {
    const rule = MESSAGE_STATE_TRANSITIONS.find(t => t.to === to)
    if (!rule) return false
    if (rule.from && !rule.from.includes(this._state)) return false
    if (rule.guard && !rule.guard({ conversationId: this._conversationId })) return false
    return true
  }
}

// ============================================================================
// 2. Session State Machine — 可执行状态机
// ============================================================================

/**
 * 会话运行状态（后端权威）
 *
 * 与 `03` 文档 SessionState 对齐：
 * - none：会话不存在
 * - idle：会话已创建，无 AI 运行
 * - running：AI 正在处理（streaming）
 * - error：运行出错（error 状态后可回到 idle 或终止）
 */
export type SessionRuntimeState = 'none' | 'idle' | 'running' | 'error'

/**
 * 会话状态转换守卫
 */
export interface SessionStateTransition {
  to: SessionRuntimeState
  /** 允许的前置状态（白名单）。省略 = 通配 */
  from?: SessionRuntimeState[]
  /** 转换守卫（如 requestStart 需要会话已创建） */
  guard?: (ctx: { conversationId: string | null }) => boolean
  /** 转换副作用 */
  onTransition?: () => void | Promise<void>
}

/**
 * 会话状态机定义（权威转换表）
 *
 * 关键决策：
 * - 只有 idle 可以进入 running（后端排他：同一会话只允许一个 active 操作）
 * - running 可进入 error 或回到 idle
 * - none 只能创建进入 idle（createSession）
 */
export const SESSION_STATE_TRANSITIONS: SessionStateTransition[] = [
  { to: 'none', from: [] }, // 初始状态，无前置
  { to: 'idle', from: ['none', 'running', 'error'], guard: ctx => !!ctx.conversationId },
  { to: 'running', from: ['idle'], guard: ctx => !!ctx.conversationId },
  { to: 'error', from: ['running'], guard: ctx => !!ctx.conversationId },
]

/**
 * 会话状态机执行器（可测试的纯逻辑）
 */
export class SessionStateMachine {
  private _state: SessionRuntimeState
  private _conversationId: string | null = null
  lastRejected: { from: SessionRuntimeState; to: SessionRuntimeState; reason: string } | null = null

  constructor(initial: SessionRuntimeState = 'none') {
    this._state = initial
  }

  get state(): SessionRuntimeState {
    return this._state
  }

  get conversationId(): string | null {
    return this._conversationId
  }

  async transition(
    to: SessionRuntimeState,
    ctx: { conversationId?: string | null } = {},
  ): Promise<boolean> {
    const rule = SESSION_STATE_TRANSITIONS.find(t => t.to === to)
    if (!rule) {
      this.lastRejected = { from: this._state, to, reason: `未定义转换规则: ${to}` }
      return false
    }

    if (rule.from && !rule.from.includes(this._state)) {
      this.lastRejected = {
        from: this._state,
        to,
        reason: `非法转换: ${this._state} → ${to}（允许的前置: ${rule.from.join(', ') || '无'}）`,
      }
      return false
    }

    if (rule.guard && !rule.guard({ conversationId: ctx.conversationId ?? this._conversationId })) {
      this.lastRejected = {
        from: this._state,
        to,
        reason: `守卫拒绝: ${this._state} → ${to}`,
      }
      return false
    }

    if (ctx.conversationId != null) this._conversationId = ctx.conversationId
    this._state = to
    this.lastRejected = null

    if (rule.onTransition) {
      await rule.onTransition()
    }
    return true
  }

  canTransition(to: SessionRuntimeState): boolean {
    const rule = SESSION_STATE_TRANSITIONS.find(t => t.to === to)
    if (!rule) return false
    if (rule.from && !rule.from.includes(this._state)) return false
    if (rule.guard && !rule.guard({ conversationId: this._conversationId })) return false
    return true
  }
}

// ============================================================================
// 3. Sync Protocol — 跨设备同步
// ============================================================================

/**
 * 同步层状态
 *
 * 层 1（事件流）：连接状态
 * 层 2（快照）：拉取状态
 * 层 3（持久化）：CAS 乐观锁
 */
export type SyncState =
  | 'disconnected' // 与后端断开
  | 'connecting' // 正在连接
  | 'live' // 事件流已建立，实时增量
  | 'gap' // 检测到消息缺口，需要快照合并
  | 'resyncing' // 正在拉取快照合并
  | 'synced' // 快照合并完成，回到 live

/**
 * 断线后的恢复策略
 */
export type ResyncStrategy = 'merge' | 'full-snapshot'

// ============================================================================
// 4. 内核操作类型
// ============================================================================

/**
 * 发送消息输入（对齐现有 SendMessageInput 的关键字段）
 *
 * 批次 3：完整透传 store.sendMessage 的 4 参签名
 * `(content, workspaceDir?, attachments?, options?)`，消除「改走 kernel
 * 丢附件 / 工作区 / 发送选项」的透传缺陷。
 */
export interface SendMessageInput {
  /** 会话 ID（前端生成的本地 ID） */
  sessionId: string
  /** 用户消息内容 */
  content: string
  /** 工作区目录（透传 store.sendMessage 第 2 参） */
  workspaceDir?: string
  /** 附件（透传 store.sendMessage 第 3 参） */
  attachments?: import('../../types/attachment').Attachment[]
  /** 发送选项（透传 store.sendMessage 第 4 参：一次性系统提示 / 运行时覆盖等） */
  sendOptions?: import('../../stores/conversationStore/types').SendMessageOptions
  /** 关联文件（保留：兼容早期 kernel 契约） */
  files?: string[]
  /** 前端生成的用户消息 ID（透传，用于本机回显去重） */
  clientMessageId?: string
  /** 静默模式：不显示在 UI，不激活会话 */
  silentMode?: boolean
}

/**
 * 发送结果
 */
export interface SendResult {
  /** 是否成功 */
  ok: boolean
  /** 后端分配的 conversationId（成功后必有） */
  conversationId?: string
  /** 失败原因 */
  reason?: string
  /** 失败时是否可重试 */
  retryable?: boolean
}

/**
 * 继续会话输入
 */
export interface ContinueOptions {
  /** 权限授权后继续 / 回答问题后继续 */
  prompt?: string
  /** 附加上下文 */
  extraContext?: string
  /** 允许的工具列表（透传 store.continueChat 第 2 参） */
  allowedTools?: string[]
}

/**
 * 会话快照（层 2：快照拉取）
 *
 * 取代 `setMessagesFromHistory` 的全量覆盖，改为"快照合并"。
 */
export interface SessionSnapshot {
  /** 会话 ID */
  sessionId: string
  /** 后端 conversationId */
  conversationId: string
  /** 会话元数据 */
  metadata: SessionSnapshotMetadata
  /** 消息列表（按时间升序） */
  messages: ChatMessage[]
  /** 运行状态 */
  state: SessionRuntimeState
  /** 最后事件 seq（用于增量续传） */
  lastEventSeq: number
}

/**
 * 快照中的会话元数据（轻量版，不含内存态字段）
 */
export interface SessionSnapshotMetadata {
  title: string
  engineId: string
  workspaceId: string | null
  type: 'project' | 'free'
  silentMode: boolean
  createdAt: number
  updatedAt: number
}

/**
 * 会话状态（后端权威）
 *
 * 取代前端自行维护的 isStreaming。
 */
export interface SessionState {
  /** 会话 ID */
  sessionId: string
  /** 运行状态 */
  state: SessionRuntimeState
  /** 是否正在流式输出（由 running 推导，非存储值） */
  isStreaming: boolean
  /** 最后事件 seq */
  lastEventSeq: number
  /** 错误信息（state=error 时有值） */
  error: string | null
  /** 运行开始时间 */
  startedAt: number | null
  /** 运行结束时间 */
  endedAt: number | null
  /** 发起方设备 ID */
  startedByDevice: string | null
}

/**
 * 状态变化订阅回调
 */
export type StateChangeHandler = (next: SessionState, prev: SessionState) => void

// ============================================================================
// 5. 事件模型（内核统一入口）
// ============================================================================

/**
 * 内核事件类型（对齐 AIEvent，但限定会话域）
 *
 * 取代 eventRouter + dispatchEvent 双层路由，统一入口。
 */
export type KernelEvent =
  | { type: 'session_start'; sessionId: string; engineId?: string }
  | { type: 'session_end'; sessionId: string; reason?: 'completed' | 'aborted' | 'error'; errorMessage?: string }
  | { type: 'user_message'; sessionId: string; content: string; clientMessageId?: string }
  | { type: 'assistant_message'; sessionId: string; content: string; messageId?: string }
  | { type: 'error'; sessionId: string; errorMessage: string }
