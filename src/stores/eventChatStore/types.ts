/**
 * EventChatStore 类型定义
 *
 * 用于 Zustand slice 模式的共享类型
 */

import type { StateCreator } from 'zustand'
import type { ChatMessage, ContentBlock, ToolStatus, Workspace } from '../../types'
import type { AISession } from '../../ai-runtime'

/** 最大保留消息数量 */
export const MAX_MESSAGES = 500

/** 消息保留阈值 */
export const MESSAGE_ARCHIVE_THRESHOLD = 550

/** 每批次加载的消息数量 */
export const BATCH_LOAD_COUNT = 20

/** 会话历史存储键 */
export const SESSION_HISTORY_KEY = 'event_chat_session_history'
export const MAX_SESSION_HISTORY = 50

/**
 * 当前正在构建的 Assistant 消息
 */
export interface CurrentAssistantMessage {
  id: string
  blocks: ContentBlock[]
  isStreaming: true
}

/**
 * 历史会话记录（localStorage 存储）
 */
export interface HistoryEntry {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`
  data: {
    messages: ChatMessage[]
    archivedMessages: ChatMessage[]
  }
}

/**
 * 统一的历史条目（包含 localStorage、IFlow 和 Claude Code 原生的会话）
 */
export interface UnifiedHistoryItem {
  id: string
  title: string
  timestamp: string
  messageCount: number
  engineId: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`
  source: 'local' | 'iflow' | 'claude-code-native' | 'codex'
  fileSize?: number
  inputTokens?: number
  outputTokens?: number
  /** Claude Code 项目目录名（如 D--space-app-Polaris） */
  projectPath?: string
}

/**
 * OpenAI Provider Session 缓存
 */
export interface ProviderSessionCache {
  session: AISession | null
  conversationId: string | null
  conversationSeed: string | null
  lastUsed: number
}

// ============================================================================
// 依赖注入接口（用于解耦 Store 间依赖）
// ============================================================================

/**
 * ToolPanel 操作接口
 * 用于解耦 eventChatStore 对 toolPanelStore 的直接依赖
 */
export interface ToolPanelActions {
  /** 清空工具列表 */
  clearTools: () => void
  /** 添加工具 */
  addTool: (tool: {
    id: string
    name: string
    status: ToolStatus
    input?: Record<string, unknown>
    startedAt: string
  }) => void
  /** 更新工具状态 */
  updateTool: (
    id: string,
    updates: { status?: ToolStatus; output?: string; completedAt?: string }
  ) => void
}

/**
 * Git 操作接口
 * 用于解耦 eventChatStore 对 gitStore 的直接依赖
 */
export interface GitActions {
  /** 防抖刷新 Git 状态 */
  refreshStatusDebounced: (workspacePath: string) => Promise<void>
}

/**
 * Config 操作接口
 * 用于解耦 eventChatStore 对 configStore 的直接依赖
 */
export interface ConfigActions {
  /** 获取当前配置 */
  getConfig: () => {
    defaultEngine?: string
    openaiProviders?: Array<{ id: string; enabled: boolean; [key: string]: any }>
    activeProviderId?: string
    [key: string]: any
  } | null
}

/**
 * Workspace 操作接口
 * 用于解耦 eventChatStore 对 workspaceStore 的直接依赖
 */
export interface WorkspaceActions {
  /** 获取当前工作区 */
  getCurrentWorkspace: () => Workspace | null
  /** 获取所有工作区 */
  getWorkspaces: () => Workspace[]
  /** 获取上下文工作区 */
  getContextWorkspaces: () => Workspace[]
  /** 获取当前工作区 ID */
  getCurrentWorkspaceId: () => string | null
}

/**
 * Session 操作接口
 * 用于解耦 eventChatStore 对 sessionStore 的直接依赖
 */
export interface SessionSyncActions {
  /** 获取当前活跃会话 ID */
  getActiveSessionId: () => string | null
  /** 获取会话消息状态 */
  getSessionMessages: (sessionId: string) => {
    messages: unknown[]
    archivedMessages?: unknown[]
    conversationId?: string | null
  } | undefined
  /** 设置会话消息状态 */
  setSessionMessages: (sessionId: string, state: {
    messages: unknown[]
    archivedMessages?: unknown[]
    conversationId?: string | null
  }) => void
  /** 更新会话状态 */
  updateSessionStatus: (sessionId: string, status: 'idle' | 'running' | 'waiting' | 'error') => void
}

/**
 * 外部依赖集合
 */
export interface ExternalDependencies {
  toolPanelActions?: ToolPanelActions
  gitActions?: GitActions
  configActions?: ConfigActions
  workspaceActions?: WorkspaceActions
  sessionSyncActions?: SessionSyncActions
}

// ============================================================================
// Slice 状态类型定义
// ============================================================================

/**
 * 待聚合的工具组（用于智能聚合）
 */
export interface PendingToolGroup {
  /** 工具组 ID */
  groupId: string
  /** 包含的工具列表 */
  tools: Array<{
    id: string
    name: string
    input?: Record<string, unknown>
    status: 'pending' | 'running' | 'completed' | 'failed'
    startedAt: string
    completedAt?: string
    output?: string
    summary?: string
  }>
  /** 工具组开始时间 */
  startedAt: string
  /** 最后一个工具的时间戳 */
  lastToolAt: number
  /** 聚合计时器 ID */
  timerId?: ReturnType<typeof setTimeout>
}

/**
 * 消息状态
 */
export interface MessageState {
  /** 消息列表 */
  messages: ChatMessage[]
  /** 归档的消息列表 */
  archivedMessages: ChatMessage[]
  /** 当前正在构建的 Assistant 消息 */
  currentMessage: CurrentAssistantMessage | null
  /** 工具调用块映射 (toolUseId -> blockIndex) */
  toolBlockMap: Map<string, number>
  /** 问题块映射 (questionId -> blockIndex) */
  questionBlockMap: Map<string, number>
  /** PlanMode 块映射 (planId -> blockIndex) */
  planBlockMap: Map<string, number>
  /** 当前活跃的计划 ID（用于追踪正在编辑/审批的计划） */
  activePlanId: string | null
  /** AgentRun 块映射 (taskId -> blockIndex) */
  agentRunBlockMap: Map<string, number>
  /** 当前活跃的任务 ID（用于追踪正在运行的 Agent） */
  activeTaskId: string | null
  /** ToolGroup 块映射 (groupId -> blockIndex) */
  toolGroupBlockMap: Map<string, number>
  /** 待聚合的工具组（用于智能聚合） */
  pendingToolGroup: PendingToolGroup | null
  /** PermissionRequest 块映射 (requestId -> blockIndex) */
  permissionRequestBlockMap: Map<string, number>
  /** 当前活跃的权限请求 ID（用于追踪待处理的权限请求） */
  activePermissionRequestId: string | null
  /** 流式更新计数器 - 用于强制触发React重新渲染 */
  streamingUpdateCounter: number
}

/**
 * 会话状态
 */
export interface SessionState {
  /** 当前会话 ID */
  conversationId: string | null
  /** 当前对话的唯一标识（用于区分不同对话） */
  currentConversationSeed: string | null
  /** 是否正在流式传输 */
  isStreaming: boolean
  /** 错误 */
  error: string | null
  /** 当前进度消息 */
  progressMessage: string | null
  /** OpenAI Provider Session 缓存 */
  providerSessionCache: ProviderSessionCache | null
}

/**
 * 事件处理器状态
 */
export interface EventHandlerState {
  /** 事件监听器是否已初始化 */
  _eventListenersInitialized: boolean
  /** 事件监听器清理函数 */
  _eventListenersCleanup: (() => void) | null
}

/**
 * 依赖注入状态
 */
export interface DependencyState {
  /** 外部依赖（用于解耦 Store 间依赖） */
  _dependencies: ExternalDependencies | null
}

/**
 * 历史管理状态
 */
export interface HistoryState {
  /** 是否已初始化 */
  isInitialized: boolean
  /** 是否正在加载历史 */
  isLoadingHistory: boolean
  /** 归档是否展开 */
  isArchiveExpanded: boolean
  /** 最大消息数配置 */
  maxMessages: number
}

// ============================================================================
// Slice 方法类型定义
// ============================================================================

/**
 * 消息操作方法
 */
export interface MessageActions {
  /** 添加消息 */
  addMessage: (message: ChatMessage) => void
  /** 删除消息（根据消息 ID） */
  deleteMessage: (messageId: string) => void
  /** 编辑用户消息内容 */
  editMessage: (messageId: string, newContent: string) => void
  /** 清空消息 */
  clearMessages: () => void
  /** 完成当前消息 */
  finishMessage: () => void

  /** 添加文本块 */
  appendTextBlock: (content: string) => void
  /** 添加思考过程块 */
  appendThinkingBlock: (content: string) => void
  /** 添加工具调用块 */
  appendToolCallBlock: (toolId: string, toolName: string, input: Record<string, unknown>) => void
  /** 更新工具调用块状态 */
  updateToolCallBlock: (toolId: string, status: ToolStatus, output?: string, error?: string) => void
  /** 更新工具调用块的 Diff 数据 */
  updateToolCallBlockDiff: (toolId: string, diffData: { oldContent: string; newContent: string; filePath: string }) => void
  /** 更新工具调用块的完整文件内容（用于撤销） */
  updateToolCallBlockFullContent: (toolId: string, fullContent: string) => void
  /** 更新当前 Assistant 消息（内部方法） */
  updateCurrentAssistantMessage: (blocks: ContentBlock[]) => void

  /** 添加问题块（AskUserQuestion 工具） */
  appendQuestionBlock: (questionId: string, header: string, options: Array<{ value: string; label?: string; description?: string; preview?: string }>, multiSelect?: boolean, allowCustomInput?: boolean, categoryLabel?: string) => void
  /** 更新问题块答案 */
  updateQuestionBlock: (questionId: string, answer: { selected: string[]; customInput?: string }) => void

  /** 添加计划模式块 */
  appendPlanModeBlock: (planId: string, sessionId: string, title?: string, description?: string, stages?: import('../../types/chat').PlanStageBlock[]) => void
  /** 更新计划模式块 */
  updatePlanModeBlock: (planId: string, updates: Partial<import('../../types/chat').PlanModeBlock>) => void
  /** 更新计划阶段状态 */
  updatePlanStageStatus: (planId: string, stageId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', tasks?: import('../../types/chat').PlanTaskBlock[]) => void
  /** 设置活跃计划 */
  setActivePlan: (planId: string | null) => void

  /** 添加 Agent 运行块 */
  appendAgentRunBlock: (taskId: string, agentType: string, capabilities?: string[]) => void
  /** 更新 Agent 运行块 */
  updateAgentRunBlock: (taskId: string, updates: Partial<import('../../types/chat').AgentRunBlock>) => void
  /** 添加嵌套工具调用到 AgentRun */
  appendAgentToolCall: (taskId: string, toolId: string, toolName: string) => void
  /** 更新嵌套工具调用状态 */
  updateAgentToolCallStatus: (taskId: string, toolId: string, status: 'pending' | 'running' | 'completed' | 'failed', summary?: string) => void
  /** 设置活跃任务 */
  setActiveTask: (taskId: string | null) => void

  /** 添加工具组块 */
  appendToolGroupBlock: (groupId: string, tools: Array<{ id: string; name: string; status: 'pending' | 'running' | 'completed' | 'failed'; startedAt: string }>, summary: string) => void
  /** 更新工具组块 */
  updateToolGroupBlock: (groupId: string, updates: Partial<import('../../types/chat').ToolGroupBlock>) => void
  /** 更新工具组内的工具状态 */
  updateToolInGroup: (groupId: string, toolId: string, updates: { status?: 'pending' | 'running' | 'completed' | 'failed'; output?: string; summary?: string }) => void
  /** 设置待聚合的工具组 */
  setPendingToolGroup: (group: PendingToolGroup | null) => void
  /** 添加工具到待聚合组 */
  addToolToPendingGroup: (tool: { id: string; name: string; input?: Record<string, unknown>; startedAt: string }) => void
  /** 完成待聚合组并创建 ToolGroupBlock */
  finalizePendingToolGroup: () => void

  /** 添加权限请求块 */
  appendPermissionRequestBlock: (requestId: string, sessionId: string, denials: Array<{ toolName: string; reason: string; extra?: Record<string, unknown> }>) => void
  /** 更新权限请求块状态 */
  updatePermissionRequestBlock: (requestId: string, status: 'pending' | 'approved' | 'denied', decision?: { approved: boolean; timestamp: string }) => void
  /** 设置活跃权限请求 */
  setActivePermissionRequest: (requestId: string | null) => void
}

/**
 * 会话操作方法
 */
export interface SessionActions {
  /** 设置会话 ID */
  setConversationId: (id: string | null) => void
  /** 设置流式状态 */
  setStreaming: (streaming: boolean) => void
  /** 设置错误 */
  setError: (error: string | null) => void
  /** 设置进度消息 */
  setProgressMessage: (message: string | null) => void
}

/**
 * 事件处理方法
 */
export interface EventHandlerActions {
  /** 初始化事件监听 */
  initializeEventListeners: () => Promise<() => void>

  /** 发送消息 */
  sendMessage: (content: string, workspaceDir?: string, attachments?: import('../../types/attachment').Attachment[]) => Promise<void>
  /** 使用前端引擎发送消息（OpenAI Provider） */
  sendMessageToFrontendEngine: (content: string, workspaceDir?: string, systemPrompt?: string, attachments?: import('../../types/attachment').Attachment[]) => Promise<void>
  /** 继续会话 */
  continueChat: (prompt?: string) => Promise<void>
  /** 中断会话 */
  interruptChat: () => Promise<void>
  /** 重新生成助手回复 */
  regenerateResponse: (assistantMessageId: string) => Promise<void>
  /** 编辑用户消息并重新发送 */
  editAndResend: (userMessageId: string, newContent: string) => Promise<void>
}

/**
 * 历史管理方法
 */
export interface HistoryActions {
  /** 设置最大消息数 */
  setMaxMessages: (max: number) => void
  /** 切换归档展开状态 */
  toggleArchive: () => void
  /** 加载归档消息（一次性全部加载） */
  loadArchivedMessages: () => void
  /** 分批加载归档消息 */
  loadMoreArchivedMessages: (count?: number) => void

  /** 保存状态到本地存储 */
  saveToStorage: () => void
  /** 从本地存储恢复状态 */
  restoreFromStorage: () => boolean

  /** 保存会话到历史 */
  saveToHistory: (title?: string) => void
  /** 获取统一会话历史（包含 localStorage 和 IFlow） */
  getUnifiedHistory: () => Promise<UnifiedHistoryItem[]>
  /** 从历史恢复会话 */
  restoreFromHistory: (sessionId: string, engineId?: 'claude-code' | 'iflow' | 'codex' | `provider-${string}`, projectPath?: string) => Promise<boolean>
  /** 删除历史会话 */
  deleteHistorySession: (sessionId: string, source?: 'local' | 'iflow' | 'codex') => void
  /** 清空历史 */
  clearHistory: () => void
}

/**
 * 依赖注入方法
 */
export interface DependencyActions {
  /** 设置外部依赖 */
  setDependencies: (deps: ExternalDependencies) => void
  /** 获取工具面板操作 */
  getToolPanelActions: () => ToolPanelActions | undefined
  /** 获取 Git 操作 */
  getGitActions: () => GitActions | undefined
  /** 获取配置操作 */
  getConfigActions: () => ConfigActions | undefined
  /** 获取工作区操作 */
  getWorkspaceActions: () => WorkspaceActions | undefined
  /** 获取会话同步操作 */
  getSessionSyncActions: () => SessionSyncActions | undefined
}

// ============================================================================
// 组合状态类型
// ============================================================================

/**
 * 完整的 EventChat 状态
 */
export type EventChatState = MessageState &
  SessionState &
  EventHandlerState &
  HistoryState &
  DependencyState &
  MessageActions &
  SessionActions &
  EventHandlerActions &
  HistoryActions &
  DependencyActions

// ============================================================================
// Slice Creator 类型
// ============================================================================

/** 消息 Slice Creator 类型 */
export type MessageSlice = StateCreator<EventChatState, [], [], MessageState & MessageActions>

/** 会话 Slice Creator 类型 */
export type SessionSlice = StateCreator<EventChatState, [], [], SessionState & SessionActions>

/** 事件处理 Slice Creator 类型 */
export type EventHandlerSlice = StateCreator<EventChatState, [], [], EventHandlerState & EventHandlerActions>

/** 历史 Slice Creator 类型 */
export type HistorySlice = StateCreator<EventChatState, [], [], HistoryState & HistoryActions>

/** 依赖注入 Slice Creator 类型 */
export type DependencySlice = StateCreator<EventChatState, [], [], DependencyState & DependencyActions>
