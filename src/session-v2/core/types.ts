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
}

/**
 * 状态仲裁器接口（后端权威）
 */
export interface StateArbiter {
  /** 查询会话状态（从日志计算） */
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
