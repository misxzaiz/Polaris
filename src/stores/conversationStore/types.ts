/**
 * ConversationStore 类型定义
 *
 * 每个会话拥有独立的状态和方法
 */

import type {
  ChatMessage,
  ContentBlock,
  ToolStatus,
  Workspace,
} from '../../types'
import type { Attachment } from '../../types/attachment'
import type {
  CurrentAssistantMessage,
  PendingToolGroup,
  ProviderSessionCache,
} from '../eventChatStore/types'
import type { AIEvent } from '../../ai-runtime'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { EventRouter } from '../../services/eventRouter'

// ============================================================================
// 输入草稿类型
// ============================================================================

/**
 * 输入草稿
 *
 * 保存用户正在编辑的消息内容和附件
 */
export interface InputDraft {
  text: string
  attachments: Attachment[]
}

// ============================================================================
// 依赖注入接口
// ============================================================================

/**
 * ConversationStore 外部依赖
 *
 * 通过依赖注入解耦与全局 Store 的直接依赖
 */
export interface StoreDeps {
  /** 获取配置（简化版，只关心 defaultEngine） */
  getConfig: () => { defaultEngine?: string } | null
  /** 获取当前工作区 */
  getWorkspace: () => Workspace | null
  /** 获取事件路由器 */
  getEventRouter: () => EventRouter
  /** 事件路由标识（独立 contextId） */
  contextId: string
}

// ============================================================================
// 会话状态
// ============================================================================

/**
 * 单个会话的完整状态
 *
 * 每个会话拥有独立的：
 * - 消息列表和流式构建状态
 * - 会话 ID 和流式传输状态
 * - 错误和进度信息
 * - 各种 block 映射
 */
export interface ConversationState {
  // ===== 消息状态 =====
  messages: ChatMessage[]
  archivedMessages: ChatMessage[]
  currentMessage: CurrentAssistantMessage | null

  // ===== 流式构建映射 =====
  toolBlockMap: Map<string, number>
  questionBlockMap: Map<string, number>
  planBlockMap: Map<string, number>
  activePlanId: string | null
  agentRunBlockMap: Map<string, number>
  activeTaskId: string | null
  toolGroupBlockMap: Map<string, number>
  pendingToolGroup: PendingToolGroup | null
  permissionRequestBlockMap: Map<string, number>
  activePermissionRequestId: string | null
  streamingUpdateCounter: number

  // ===== 会话状态 =====
  conversationId: string | null
  currentConversationSeed: string | null
  isStreaming: boolean
  error: string | null
  progressMessage: string | null
  providerSessionCache: ProviderSessionCache | null

  // ===== 元数据 =====
  sessionId: string // 会话唯一标识，由后端返回或前端生成

  // ===== 输入草稿 =====
  inputDraft: InputDraft

  // ===== 工作区关联 =====
  workspaceId: string | null
}

// ============================================================================
// 会话操作
// ============================================================================

export interface ConversationActions {
  // ===== 消息操作 =====
  addMessage: (message: ChatMessage) => void
  deleteMessage: (messageId: string) => void
  editMessage: (messageId: string, newContent: string) => void
  clearMessages: () => void
  finishMessage: () => void

  // ===== 输入草稿 =====
  updateInputDraft: (draft: InputDraft) => void
  clearInputDraft: () => void

  // ===== 流式构建 =====
  appendTextBlock: (content: string) => void
  appendThinkingBlock: (content: string) => void
  appendToolCallBlock: (toolId: string, toolName: string, input: Record<string, unknown>) => void
  updateToolCallBlock: (toolId: string, status: ToolStatus, output?: string, error?: string) => void
  updateToolCallBlockDiff: (toolId: string, diffData: { oldContent: string; newContent: string; filePath: string }) => void
  updateToolCallBlockFullContent: (toolId: string, fullContent: string) => void
  updateCurrentAssistantMessage: (blocks: ContentBlock[]) => void

  // ===== 问题块 =====
  appendQuestionBlock: (questionId: string, header: string, options: Array<{ value: string; label?: string; description?: string; preview?: string }>, multiSelect?: boolean, allowCustomInput?: boolean, categoryLabel?: string) => void
  updateQuestionBlock: (questionId: string, answer: { selected: string[]; customInput?: string }) => void

  // ===== PlanMode =====
  appendPlanModeBlock: (planId: string, sessionId: string, title?: string, description?: string, stages?: import('../../types/chat').PlanStageBlock[]) => void
  updatePlanModeBlock: (planId: string, updates: Partial<import('../../types/chat').PlanModeBlock>) => void
  updatePlanStageStatus: (planId: string, stageId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', tasks?: import('../../types/chat').PlanTaskBlock[]) => void
  setActivePlan: (planId: string | null) => void

  // ===== AgentRun =====
  appendAgentRunBlock: (taskId: string, agentType: string, capabilities?: string[]) => void
  updateAgentRunBlock: (taskId: string, updates: Partial<import('../../types/chat').AgentRunBlock>) => void
  appendAgentToolCall: (taskId: string, toolId: string, toolName: string) => void
  updateAgentToolCallStatus: (taskId: string, toolId: string, status: 'pending' | 'running' | 'completed' | 'failed', summary?: string) => void
  setActiveTask: (taskId: string | null) => void

  // ===== ToolGroup =====
  appendToolGroupBlock: (groupId: string, tools: Array<{ id: string; name: string; status: 'pending' | 'running' | 'completed' | 'failed'; startedAt: string }>, summary: string) => void
  updateToolGroupBlock: (groupId: string, updates: Partial<import('../../types/chat').ToolGroupBlock>) => void
  updateToolInGroup: (groupId: string, toolId: string, updates: { status?: 'pending' | 'running' | 'completed' | 'failed'; output?: string; summary?: string }) => void
  setPendingToolGroup: (group: PendingToolGroup | null) => void
  addToolToPendingGroup: (tool: { id: string; name: string; input?: Record<string, unknown>; startedAt: string }) => void
  finalizePendingToolGroup: () => void

  // ===== PermissionRequest =====
  appendPermissionRequestBlock: (requestId: string, sessionId: string, denials: Array<{ toolName: string; reason: string; extra?: Record<string, unknown> }>) => void
  updatePermissionRequestBlock: (requestId: string, status: 'pending' | 'approved' | 'denied', decision?: { approved: boolean; timestamp: string }) => void
  setActivePermissionRequest: (requestId: string | null) => void

  // ===== 会话控制 =====
  setConversationId: (id: string | null) => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  setProgressMessage: (message: string | null) => void

  // ===== 历史恢复 =====
  /** 设置初始消息（用于从历史恢复） */
  setMessagesFromHistory: (messages: ChatMessage[], conversationId: string | null) => void

  // ===== 事件处理（核心） =====
  handleAIEvent: (event: AIEvent) => void

  // ===== 主动操作 =====
  sendMessage: (content: string, workspaceDir?: string, attachments?: import('../../types/attachment').Attachment[]) => Promise<void>
  /** 继续会话（用于回答问题/审批计划后） */
  continueChat: (prompt?: string) => Promise<void>
  interrupt: () => Promise<void>
  regenerateResponse: (assistantMessageId: string) => Promise<void>
  editAndResend: (userMessageId: string, newContent: string) => Promise<void>

  // ===== 资源清理 =====
  dispose: () => void
}

export type ConversationStore = ConversationState & ConversationActions

/**
 * ConversationStore 实例类型（Zustand store with getState）
 */
export type ConversationStoreInstance = UseBoundStore<StoreApi<ConversationStore>>

// ============================================================================
// SessionStoreManager 类型
// ============================================================================

/**
 * 会话元数据
 */
export interface SessionMetadata {
  id: string
  title: string
  type: 'project' | 'free'
  workspaceId: string | null
  workspaceName?: string // 工作区名称（用于显示）
  contextWorkspaceIds: string[] // 关联工作区 ID 列表
  status: 'idle' | 'running' | 'waiting' | 'error' | 'background-running'
  silentMode?: boolean // 静默模式标志 - 静默会话不显示在标签栏
  createdAt: string
  updatedAt: string
}

/**
 * 创建会话选项
 */
export interface CreateSessionOptions {
  /** 指定会话 ID（可选，不指定则自动生成） */
  id?: string
  type: 'project' | 'free'
  workspaceId?: string
  title?: string
  engineId?: string
  silentMode?: boolean // 静默模式 - 静默会话不显示在标签栏
}

/**
 * 从历史创建会话选项
 */
export interface CreateSessionFromHistoryOptions {
  title: string
  workspaceId?: string
  engineId?: 'claude-code' | `provider-${string}`
  externalSessionId?: string
  messages: ChatMessage[]
  conversationId?: string | null
}

/**
 * SessionStoreManager 状态
 */
export interface SessionManagerState {
  /** 所有会话 Store 实例 */
  stores: Map<string, ConversationStoreInstance>

  /** 当前活跃会话 ID */
  activeSessionId: string | null

  /** 会话元数据 */
  sessionMetadata: Map<string, SessionMetadata>

  /** 后台运行的会话 ID 列表 */
  backgroundSessionIds: string[]

  /** 已完成但未查看的会话 ID 列表 */
  completedNotifications: string[]

  /** 初始化状态 */
  isInitialized: boolean
}

/**
 * SessionStoreManager 操作
 */
export interface SessionManagerActions {
  // ===== 会话生命周期 =====
  createSession: (options: CreateSessionOptions) => string
  /** 从历史创建会话（恢复历史消息） */
  createSessionFromHistory: (options: import('../../types').ChatMessage[], conversationId: string | null, metadata?: { title?: string; workspaceId?: string }) => string
  deleteSession: (sessionId: string) => void
  switchSession: (sessionId: string) => void
  /** 将静默会话转换为可见会话 */
  makeSessionVisible: (sessionId: string) => void

  // ===== Store 访问 =====
  getStore: (sessionId: string) => ConversationStore | undefined
  getActiveStore: () => ConversationStore | undefined
  getActiveSessionId: () => string | null

  // ===== 事件分发 =====
  dispatchEvent: (event: AIEvent & { sessionId?: string; _routeSessionId?: string }) => void

  // ===== 工作区管理 =====
  updateSessionWorkspace: (sessionId: string, workspaceId: string | null) => void
  addContextWorkspace: (sessionId: string, workspaceId: string) => void
  removeContextWorkspace: (sessionId: string, workspaceId: string) => void

  // ===== 后台运行管理 =====
  addToBackground: (sessionId: string) => void
  removeFromBackground: (sessionId: string) => void
  addToNotifications: (sessionId: string) => void
  removeFromNotifications: (sessionId: string) => void

  // ===== 批量操作 =====
  getStreamingSessions: () => string[]
  interruptSession: (sessionId: string) => Promise<void>
  interruptAllBackground: () => Promise<void>

  // ===== 初始化 =====
  initialize: () => Promise<void>
}

export type SessionStoreManager = SessionManagerState & SessionManagerActions