/**
 * 能力接口（Capabilities）— 阶段 0：替代 17 方法上帝接口
 *
 * 依据 `03-地基级改造方案.md` 复审缺陷 1 修正：
 * SessionKernel 17 方法"上帝接口" → 拆分为按职责的小接口。
 *
 * 借鉴操作系统"能力（capability）而非身份"：
 * - 谁拿到接口，谁就有对应能力
 * - 不同模块只注入它需要的能力，不暴露全部内核
 *
 * 设计原则：
 * - 每个接口 ≤ 4 个方法，单一职责
 * - 方法名与全景图 6 类触发入口一一对应
 * - 所有状态查询走后端权威（不读本地 isStreaming）
 */

import type { ChatMessage } from '@/types/chat'
import type {
  SendMessageInput,
  SendResult,
  ContinueOptions,
  SessionState,
  SessionSnapshot,
  StateChangeHandler,
  KernelEvent,
} from './types'

// ============================================================================
// 能力 1：消息发送（用户直接交互 — 全景图类 1）
// ============================================================================

/**
 * 消息发送能力
 *
 * 覆盖入口：sendMessage / continueChat / regenerateResponse / editAndResend
 */
export interface MessageSendCapability {
  /** 发送消息：drafted → sending → active */
  sendMessage(input: SendMessageInput): Promise<SendResult>
  /** 继续会话（权限授权后 / 回答问题后） */
  continueChat(sessionId: string, prompt: string, opts?: ContinueOptions): Promise<void>
  /** 中断（任何设备可调用，后端确认后广播） */
  interrupt(sessionId: string): Promise<void>
  /** 重新生成 AI 回复 */
  regenerate(sessionId: string, assistantMessageId: string): Promise<void>
  /** 编辑用户消息后重发 */
  editAndResend(sessionId: string, userMessageId: string, newContent: string): Promise<void>
}

// ============================================================================
// 能力 2：会话生命周期（会话管理 — 全景图类 2/3 的基础）
// ============================================================================

/**
 * 会话生命周期能力
 *
 * 覆盖入口：createSession / deleteSession / switchSession / 静默会话创建
 */
export interface SessionLifecycleCapability {
  /** 创建会话（前端生成 ID，后端确认 conversationId） */
  createSession(opts: CreateSessionOptions): Promise<SessionHandle>
  /** 删除会话 */
  deleteSession(sessionId: string): Promise<void>
  /** 切换当前活跃会话 */
  switchSession(sessionId: string): void
  /** 获取当前活跃会话 ID */
  getActiveSessionId(): string | null
}

/**
 * 创建会话选项（对齐现有 CreateSessionOptions 的关键字段）
 */
export interface CreateSessionOptions {
  id?: string
  type: 'project' | 'free'
  workspaceId?: string
  contextWorkspaceIds?: string[]
  title?: string
  engineId?: string
  /** 静默模式：不显示在 UI，不激活会话 */
  silentMode?: boolean
  /** 会话用途标记（commit-message / prompt-optimize / title-generation） */
  kind?: 'commit-message' | 'prompt-optimize' | 'title-generation'
  /** commit-message 会话关联的工作区 ID */
  commitWorkspaceId?: string
  /** Fork 来源会话 ID */
  forkFromId?: string
}

/**
 * 会话句柄（创建后的轻量引用）
 */
export interface SessionHandle {
  /** 前端会话 ID */
  sessionId: string
  /** 后端 conversationId（首次发消息前为 null） */
  conversationId: string | null
}

// ============================================================================
// 能力 3：状态查询（后端权威 — 取代前端 isStreaming）
// ============================================================================

/**
 * 状态查询能力
 *
 * 覆盖入口：getSessionState / getSessionSnapshot / getMessages
 * 核心：所有状态从后端查询，前端不自行维护 isStreaming
 */
export interface StateQueryCapability {
  /** 查询会话真实状态（后端权威） */
  getSessionState(sessionId: string): Promise<SessionState>
  /** 获取会话快照（消息 + 状态 + conversationId，层 2） */
  getSessionSnapshot(sessionId: string): Promise<SessionSnapshot>
  /** 获取消息列表 */
  getMessages(sessionId: string): Promise<ChatMessage[]>
  /** 订阅会话状态变化（返回取消函数） */
  subscribe(sessionId: string, handler: StateChangeHandler): () => void
}

// ============================================================================
// 能力 4：事件处理（统一事件入口 — 取代双层路由）
// ============================================================================

/**
 * 事件处理能力
 *
 * 覆盖入口：handleEvent（取代 eventRouter + dispatchEvent 双层路由）
 * 后端事件统一流入，内核内部分发到对应会话
 */
export interface EventHandlingCapability {
  /** 处理后端事件 */
  handleEvent(event: KernelEvent): void
}

// ============================================================================
// 能力 5：恢复与同步（历史恢复 — 全景图类 4）
// ============================================================================

/**
 * 恢复与同步能力
 *
 * 覆盖入口：restoreFromHistory / resyncSession
 * 核心：快照合并（diff 本地 → 只追加缺失），非全量覆盖
 */
export interface RecoveryCapability {
  /** 从历史恢复（拉后端快照 → 建会话 → 加载消息） */
  restoreFromHistory(historyId: string): Promise<string>
  /** 断线重连后恢复（快照合并，非全量覆盖） */
  resyncSession(sessionId: string): Promise<void>
}

// ============================================================================
// 能力 6：仲裁策略（插件扩展点 — 可替换）
// ============================================================================

/**
 * 状态仲裁策略（可替换）
 *
 * 覆盖入口：requestStart / requestInterrupt 的自定义策略
 * 默认实现：后端排他仲裁（StateArbiter）
 * 插件实现：协作模式、多设备策略等
 */
export interface ArbitrationCapability {
  /** 请求开始（仲裁：已 running 则拒绝） */
  requestStart(conversationId: string, deviceId: string): Promise<{ ok: boolean; reason?: string }>
  /** 请求中断（能力检查：deviceId 是否有权中断） */
  requestInterrupt(conversationId: string, deviceId: string): Promise<{ ok: boolean; reason?: string }>
}

// ============================================================================
// 组合接口（可选，按需组合多个能力）
// ============================================================================

/**
 * 完整内核能力（所有能力组合）
 *
 * 不是上帝接口——这是"组合"而非"聚合"：
 * - 实现方可以实现全部，也可以只实现子集
 * - 消费方只注入自己需要的能力接口
 */
export interface SessionKernel
  extends MessageSendCapability,
    SessionLifecycleCapability,
    StateQueryCapability,
    EventHandlingCapability,
    RecoveryCapability {}

// ============================================================================
// 命名空间导出（供模块引用）
// ============================================================================

export type { KernelEvent } from './types'
