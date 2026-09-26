/**
 * 会话核心类型定义
 *
 * 地基级改造的第一块砖：纯类型，零行为。
 * 所有后续实现（InMemory / SQLite / V2）都基于这些类型。
 */

// ============================================================================
// 消息日志（Append-Only Message Log）
// ============================================================================

/**
 * 消息角色
 */
export type MessageRole = 'user' | 'assistant' | 'system'

/**
 * 消息内容（JSON，兼容现有 ChatMessage 的 blocks/attachments）
 */
export type MessageContent = Record<string, unknown>

/**
 * 不可变消息条目
 *
 * 一旦写入不可修改。需要"修改"时追加新版本（revision）。
 * 借鉴 Git 不可变对象 + 银行账本 append-only。
 */
export interface MessageEntry {
  /** 全局唯一 ID，由创建方设备生成，后端透传不修改 */
  id: string
  /** 所属会话 ID（= 后端 conversationId） */
  conversationId: string
  /** 消息角色 */
  role: MessageRole
  /** 创建时间戳（epoch ms），用于因果序排序 */
  timestamp: number
  /** 创建方设备标识（用于跨设备溯源） */
  deviceId: string
  /** 消息内容（完整 ChatMessage 序列化） */
  content: MessageContent
  /** 内容版本号（初始=1，每次修订递增） */
  version: number
  /** 修订前版本号（链式修订，初始=undefined） */
  parentVersion?: number
}

/**
 * 消息读取选项
 */
export interface ReadOptions {
  /** 从此 timestamp 之后读取（不含等于） */
  afterTimestamp?: number
  /** 最多读取条数 */
  limit?: number
}

/**
 * 消息日志存储接口（append-only）
 *
 * 地基核心接口。所有实现（InMemory / SQLite / 云端）都实现此接口。
 */
export interface MessageLogStorage {
  /**
   * 追加消息（幂等：相同 id 重复追加不报错不重复写入）
   * @returns true = 新写入；false = 已存在（幂等跳过）
   */
  append(entry: MessageEntry): Promise<boolean>

  /**
   * 修订消息（追加新版本，旧版本保留）
   * @returns 新版本号
   */
  revise(id: string, newContent: MessageContent): Promise<number>

  /**
   * 读取消息（按 timestamp 升序）
   */
  read(conversationId: string, opts?: ReadOptions): Promise<MessageEntry[]>

  /**
   * 读取消息的完整修订历史（按 version 升序）
   */
  readHistory(id: string): Promise<MessageEntry[]>

  /**
   * 读取最新版本
   */
  getLatest(id: string): Promise<MessageEntry | null>

  /** 删除会话的所有消息 */
  deleteByConversation(conversationId: string): Promise<void>
}

// ============================================================================
// 会话注册表（Session Registry）
// ============================================================================

/**
 * 会话记录
 *
 * 会话 = 有序的消息 ID 列表（引用 MessageLog，不存内容）。
 * 借鉴 Git 可变引用 + Minecraft 注册表。
 */
export interface SessionRecord {
  /** 前端生成的会话 ID */
  id: string
  /** 后端分配的引擎会话 ID（首次发消息后才有） */
  conversationId: string | null
  /** 会话标题 */
  title: string
  /** 引擎 ID */
  engineId: string
  /** 工作区 ID */
  workspaceId: string | null
  /** 关联工作区 ID 列表 */
  contextWorkspaceIds: string[]
  /** 会话类型 */
  type: 'project' | 'free'
  /** 静默模式 */
  silentMode: boolean
  /** 会话用途标记 */
  kind?: 'commit-message' | 'prompt-optimize' | 'title-generation'
  /** 有序消息 ID 列表（引用 MessageLog） */
  messageIds: string[]
  /** 元数据版本号（CAS 乐观锁） */
  version: number
  /** 创建时间 */
  createdAt: number
  /** 更新时间 */
  updatedAt: number
}

/**
 * 会话注册表接口
 */
export interface SessionRegistry {
  create(record: Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'>): Promise<SessionRecord>
  get(id: string): Promise<SessionRecord | null>
  list(): Promise<SessionRecord[]>
  updateMetadata(id: string, patch: Partial<SessionRecord>, expectedVersion: number): Promise<SessionRecord>
  appendMessageId(id: string, messageId: string): Promise<SessionRecord>
  delete(id: string): Promise<void>
}

// ============================================================================
// 状态仲裁器（State Authority）
// ============================================================================

/**
 * 会话事件类型（用于状态计算的事件日志）
 *
 * 这些是影响会话运行状态的事件，与 AIEvent 的 session_start/session_end/error 对齐。
 * 事件日志是 append-only 的，一旦写入不可修改。
 */
export type SessionEventType = 'session_start' | 'session_end' | 'error'

/**
 * 会话事件条目（append-only 事件日志）
 *
 * 借鉴银行账本：日志即真相。
 * 会话的 running 状态是从事件日志计算的结果，不是存储值。
 */
export interface SessionEventEntry {
  /** 全局唯一事件 ID */
  id: string
  /** 所属会话 ID（= 后端 conversationId） */
  conversationId: string
  /** 事件类型 */
  type: SessionEventType
  /** 事件发生时间（epoch ms） */
  timestamp: number
  /** 触发方设备 ID */
  deviceId: string
  /** 全局递增序号（由后端分配，用于因果排序） */
  seq: number
  /** 结束原因（仅 session_end） */
  reason?: 'completed' | 'aborted' | 'error'
  /** 错误信息（仅 error / session_end reason=error） */
  errorMessage?: string
}

/**
 * 会话运行状态（从事件日志计算，不是存储值）
 */
export interface SessionStatus {
  /** 会话 ID */
  conversationId: string
  /** 是否正在运行（存在 session_start 但无对应 session_end） */
  running: boolean
  /** 最后事件 seq */
  lastEventSeq: number
  /** 错误信息（如果有） */
  error: string | null
  /** 运行开始时间（running=true 时有值） */
  startedAt: number | null
  /** 运行结束时间（running=false 时有值） */
  endedAt: number | null
  /** 发起方设备 ID（running=true 时有值） */
  startedByDevice: string | null
}

/**
 * 会话事件日志接口（append-only）
 */
export interface SessionEventLog {
  /** 追加事件（幂等：相同 id 重复追加跳过） */
  append(event: SessionEventEntry): Promise<boolean>
  /** 读取会话的所有事件（按 seq 升序） */
  read(conversationId: string): Promise<SessionEventEntry[]>
  /** 读取指定 seq 之后的事件（用于 resume） */
  readAfterSeq(seq: number): Promise<SessionEventEntry[]>
  /** 当前最大 seq */
  currentSeq(): number
  /** 删除会话的所有事件 */
  deleteByConversation(conversationId: string): Promise<void>
}

/**
 * 状态仲裁器接口（后端权威）
 *
 * 借鉴操作系统内核仲裁：所有状态查询/修改请求都经仲裁器，
 * 仲裁器从事件日志计算结果，不存储状态值。
 */
export interface StateArbiter {
  /** 查询会话状态（从事件日志计算） */
  getStatus(conversationId: string): Promise<SessionStatus>
  /** 请求开始（仲裁：已 running 则拒绝） */
  requestStart(conversationId: string, deviceId: string): Promise<{ ok: boolean; reason?: string }>
  /** 请求中断（能力检查：deviceId 是否有权中断） */
  requestInterrupt(conversationId: string, deviceId: string): Promise<{ ok: boolean; reason?: string }>
}

// ============================================================================
// 对账（Reconcile）
// ============================================================================

/**
 * 对账结果
 */
export interface ReconcileResult {
  /** 前端缺失的消息（需从后端拉取） */
  missing: MessageEntry[]
  /** 前端多出的消息（可能是未同步的本地草稿，不应删除） */
  extra: MessageEntry[]
  /** 状态是否不一致 */
  statusMismatch: boolean
  /** 后端真实状态 */
  serverStatus: SessionStatus
}

// ============================================================================
// 插件扩展点（Extension Points）
// ============================================================================

/**
 * 加载阶段（借鉴 Minecraft PRE_INIT / INIT / POST_INIT）
 */
export type LoadPhase = 'register' | 'wire' | 'run'

/**
 * 插件 hook：会话创建前
 * 可修改 record（如注入 metadata），返回 null 阻止创建
 */
export type BeforeCreateSessionHook = (
  record: Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'>,
) => Omit<SessionRecord, 'version' | 'createdAt' | 'updatedAt'> | null

/**
 * 插件 hook：消息追加前
 * 可修改 entry（如过滤敏感信息），返回 null 阻止追加
 */
export type BeforeAppendMessageHook = (
  entry: MessageEntry,
) => MessageEntry | null

/**
 * 插件 hook：会话状态变化
 * 支持异步（标题生成、TTS 等真实场景）
 */
export type OnSessionStatusChangeHook = (
  conversationId: string,
  old: SessionStatus,
  next: SessionStatus,
) => void | Promise<void>

/**
 * 插件 hook：会话开始请求前（仲裁前）
 * 可注入自定义仲裁逻辑，返回 false 拒绝
 */
export type BeforeRequestStartHook = (
  conversationId: string,
  deviceId: string,
) => boolean

/**
 * 会话插件接口
 *
 * 借鉴 Minecraft 模组：引擎不知道插件存在，只通过 hook 通信。
 * 插件可选实现任意子集的 hook。
 */
export interface SessionPlugin {
  /** 插件 ID（全局唯一） */
  id: string
  /** 依赖的其他插件 ID（加载排序用） */
  dependencies?: string[]
  /** 会话创建前 */
  beforeCreateSession?: BeforeCreateSessionHook
  /** 消息追加前 */
  beforeAppendMessage?: BeforeAppendMessageHook
  /** 会话状态变化 */
  onSessionStatusChange?: OnSessionStatusChangeHook
  /** 会话开始请求前 */
  beforeRequestStart?: BeforeRequestStartHook
}

/**
 * 插件上下文：插件可访问的核心组件
 */
export interface PluginContext {
  messageLog: MessageLogStorage
  eventLog: SessionEventLog
  arbiter: StateArbiter
}

/**
 * 插件宿主接口
 */
export interface PluginHost {
  /** 注册插件（仅 register 阶段允许） */
  register(plugin: SessionPlugin): void
  /** 进入下一加载阶段 */
  advancePhase(): void
  /** 当前加载阶段 */
  readonly phase: LoadPhase
  /** 获取已注册插件列表 */
  listPlugins(): SessionPlugin[]
}
