/**
 * Workspace 分桶类型定义（S2 · 对齐 ZCode zcodeSessionStoreTypes）
 *
 * 核心模型：会话不再由全局单一 activeSessionId 管理，而是按 workspace
 * 分桶——每个 workspace 拥有独立的 sessions Map + activeSessionId，
 * 使多窗口 / 多端可同时查看与操作同/异会话而不互相覆盖。
 *
 * 设计约束（spec §3.1 / §6）：
 * - 桶是「投影缓存层」，复用现有 ConversationStoreInstance 逻辑，不改 store 内部。
 * - hooks 出口兼容：useActiveSession 签名扩展为 (workspaceKey?)，默认当前工作区。
 * - workspaceKey = identity ?? path（对齐 ZCode resolveWorkspaceStateKey）。
 */

import type { ConversationStoreInstance, SessionMetadata } from '../conversationStore/types'

/**
 * Workspace 内的会话桶。
 *
 * 一个桶对应一个 workspaceKey，持有该 workspace 下全部已创建的会话 store
 * 与该桶自己的活跃指针（不再有全局活跃会话）。
 */
export interface WorkspaceSessionBucket {
  /** workspace 分桶 key（identity ?? path） */
  workspaceKey: string
  /** 该桶内全部会话 store（复用现有 ConversationStoreInstance） */
  sessions: Map<string, ConversationStoreInstance>
  /** 该桶的活跃会话 ID（桶内单一活跃；跨桶不互踩） */
  activeSessionId: string | null
  /** 该桶内会话的元数据 */
  sessionMetadata: Map<string, SessionMetadata>
  /** 该桶后台运行的会话 ID 列表 */
  backgroundSessionIds: string[]
  /** 该桶已完成的通知列表 */
  completedNotifications: string[]
}

/**
 * workspaceKey 解析参数。
 *
 * `identity` 为远程/容器/WSL 等场景的稳定身份标识（预留扩展）；
 * 本地场景 identity 为空，回退到 path。
 */
export interface ResolveWorkspaceKeyParams {
  /** 工作区路径（本地场景的稳定标识） */
  path: string
  /** 工作区身份标识（SSH/WSL/Docker/远程等；本地通常为空） */
  identity?: string
}

/**
 * FREE 会话桶的 workspaceKey（无工作区的自由会话）。
 *
 * 对齐既有「free 会话不回退全局工作区」语义（记忆 no-workspace-free-session-complete）。
 */
export const FREE_WORKSPACE_KEY = '__free__'
