/**
 * 会话相关类型定义
 */

/** 会话类型 */
export type SessionType = 'project' | 'free'

/** 会话状态 */
export type SessionStatus = 'idle' | 'running' | 'waiting' | 'error' | 'background-running'

/** AI 引擎 ID */
export type EngineId = 'claude-code'

/** 会话元数据 */
export interface ChatSession {
  /** 会话 ID */
  id: string
  /** 会话标题 */
  title: string
  /** 会话类型 */
  type: SessionType
  /** 会话状态 */
  status: SessionStatus
  /** AI 引擎 ID */
  engineId: EngineId

  // 工作区相关
  /** 项目会话：绑定的工作区 ID；自由会话：null */
  workspaceId: string | null
  /** 自由会话临时切换的工作区 */
  temporaryWorkspaceId: string | null
  /** 关联工作区列表 */
  contextWorkspaceIds: string[]
  /** 主工作区是否已锁定（开始对话后 true） */
  workspaceLocked: boolean

  // 外部会话关联
  /** 外部会话 ID（Claude Code 的 sessionId） */
  externalSessionId: string | null
  /** 外部会话来源 */
  externalSource: 'claude-code-native' | null

  // 时间戳
  /** 创建时间 */
  createdAt: string
  /** 更新时间 */
  updatedAt: string
  /** 最后消息时间 */
  lastMessageAt: string | null

  // 统计
  /** 消息数量 */
  messageCount: number
}

/** 创建会话选项 */
export interface CreateSessionOptions {
  type: SessionType
  workspaceId?: string
  engineId?: EngineId
  title?: string
  /** 从已有外部会话恢复 */
  externalSessionId?: string
  externalSource?: 'claude-code-native'
}

/** 工作区切换模式 */
export type WorkspaceSwitchMode = 'temporary' | 'global' | 'context'

/** 悬浮岛展开模式 */
export type IslandExpandMode = 'sessions' | 'workspaces' | null

/** 会话消息状态（用于多会话消息隔离）
 *
 * 设计说明：
 * - 只保存持久化的消息数据（messages, archivedMessages）
 * - 流式状态（currentMessage, toolBlockMap 等）在切换会话时重置
 * - Map 类型在持久化时会转换为数组
 */
export interface SessionMessageState {
  /** 消息列表 */
  messages: unknown[]
  /** 归档消息列表 */
  archivedMessages?: unknown[]
  /** 会话 ID（用于恢复 conversationId） */
  conversationId?: string | null
  /** 是否已从外部恢复 */
  restoredFromExternal?: boolean
  /** 恢复时间 */
  restoredAt?: string
}