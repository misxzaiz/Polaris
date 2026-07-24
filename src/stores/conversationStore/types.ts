/**
 * ConversationStore 类型定义
 *
 * 每个会话拥有独立的状态和方法
 */

import type {
  ChatMessage,
  ContentBlock,
  EngineId,
  ToolStatus,
  Workspace,
} from '@/types'
import type { Attachment } from '@/types/attachment'
import type { AIEvent, ModelUsageBreakdown } from '@/ai-runtime'
import type { StoreApi, UseBoundStore } from 'zustand'
import type { EventRouter } from '@/services/eventRouter'

/** 当前正在构建的 Assistant 消息 */
export interface CurrentAssistantMessage {
  id: string
  engineId?: EngineId
  blocks: ContentBlock[]
  isStreaming: true
}

/** 待聚合的工具组 */
export interface PendingToolGroup {
  groupId: string
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
  startedAt: string
  lastToolAt: number
  timerId?: ReturnType<typeof setTimeout>
}

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
// 提示词优化类型
// ============================================================================

/**
 * 提示词优化模式。
 * - quick = 快速优化：零上下文、禁用工具，仅措辞打磨（现状）
 * - deep  = 深度优化：放开只读工具白名单，让模型自读对话/项目上下文做贴合改写
 */
export type PromptOptimizeMode = 'quick' | 'deep'

/** 提示词优化版本栈中的一个版本 */
export interface PromptVersion {
  text: string
  /**
   * original = 首次优化触发时的原始输入；
   * edited   = 用户手改后再优化/回滚时的快照；
   * optimized = AI 优化产物
   */
  origin: 'original' | 'edited' | 'optimized'
  /** origin === 'optimized' 时记录来源引擎 */
  engineId?: EngineId
  /** origin === 'optimized' 时记录来源模型（可选） */
  model?: string
  /** origin === 'optimized' 时记录来源模式（quick / deep，回滚时可辨识） */
  mode?: PromptOptimizeMode
  createdAt: number
}

/**
 * 提示词优化状态（per-session 内存态，不持久化）。
 *
 * 版本栈语义：history[0] 恒为首次优化时的原始输入；cursor 指向输入框当前
 * 文本对应的版本；回滚/重做移动 cursor 并把版本文本写回 inputDraft
 * （ChatInput 通过既有 inputDraft 同步 effect 回填本地文本）。
 */
export interface PromptOptimizeState {
  /** idle = 空闲；running = 优化中；ready = 完成但输入被手改，待用户点击应用 */
  status: 'idle' | 'running' | 'ready'
  /** 版本栈（空数组 = 从未优化过） */
  history: PromptVersion[]
  /** 当前输入框文本对应的版本下标（history 为空时为 -1） */
  cursor: number
  /** 本轮优化触发时的输入快照（完成时做冲突检测） */
  sourceSnapshot: string | null
  /** status === 'ready' 时的待应用结果 */
  pendingResult: string | null
  /** 本轮优化的引擎/模型/模式（结果入栈时随版本记录） */
  pendingMeta: { engineId: EngineId; model?: string; mode?: PromptOptimizeMode } | null
  /** 本轮优化使用的静默会话 ID（流式预览订阅 / 取消中断用） */
  optimizeSessionId: string | null
  /** 最近一次优化失败的错误信息（进入 running 时清空） */
  error: string | null
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
  /** 获取当前会话的工作区 */
  getWorkspace: () => Workspace | null
  /** 获取当前会话的关联工作区 ID 列表 */
  getContextWorkspaceIds: () => string[]
  /** 获取所有工作区列表 */
  getAllWorkspaces: () => Workspace[]
  /** 获取事件路由器 */
  getEventRouter: () => EventRouter
  /** 事件路由标识（独立 contextId） */
  contextId: string
}

export interface SendMessageOptions {
  allowedTools?: string[]
  /**
   * 一次性系统提示（仅本次请求生效，不持久化、不出现在消息流中）。
   * 经 appendSystemPrompt 通道注入引擎，用于语音伙伴人格等场景。
   */
  oneTimeSystemPrompt?: string
  /**
   * 一次性运行时配置覆盖（仅本次发送生效，不写入会话级 metadata、不改全局状态栏配置）。
   * 用于「压缩交接」等编排场景：以指定 agent/effort/permissionMode 静默驱动某会话，
   * 而不污染用户的常规会话配置。留空的字段回退到常规解析链。
   */
  runtimeOverride?: {
    agent?: string
    effort?: string
    permissionMode?: string
  }
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
/** 会话级累计用量（跨消息累加每次 run 的 cumulative 用量事件，对标 /cost 会话总量） */
export interface SessionUsageTotals {
  /** 累计未命中缓存输入 token */
  input: number
  /** 累计缓存写入 token */
  cacheCreation: number
  /** 累计缓存读取 token */
  cacheRead: number
  /** 累计输出 token */
  output: number
  /** 累计成本（美元）。顶层 total_cost_usd 优先，退化 modelUsage 求和；中转站自定义模型按 CLI 默认定价估算，仅供参考 */
  costUsd: number
  /** 已完成的 run（用户消息）数 */
  runs: number
}

/**
 * Token 用量统计（会话级）
 *
 * 上下文占用 = input + cacheCreation + cacheRead（三项之和，用于水位分子）。
 * output 不占上下文窗口，但计入成本。
 *
 * 水位三元组（input/cacheCreation/cacheRead）优先来自 scope='turn' 的单轮快照
 * （message_delta.usage，与 CLI /context 一致）；引擎未提供快照时由 cumulative
 * 累计事件兜底（多轮工具调用时可能偏大）。成本/明细组（output/totalOutput/
 * modelUsage/rawPayload/sessionTotals）始终来自 cumulative 事件。
 */
export interface UsageStats {
  /** 水位：未命中缓存的输入 token（turn 快照优先，cumulative 兜底） */
  input: number
  /** 水位：写入缓存的 token */
  cacheCreation: number
  /** 水位：从缓存读取的 token */
  cacheRead: number
  /** 本次 run 输出 token（cumulative 口径） */
  output: number
  /** 推理输出 token（Codex 有） */
  reasoning?: number
  /** 上下文窗口大小；缺省时由 UI 从 ModelProfile 取 */
  contextWindow?: number
  /** 累计输出 token（跨轮累加，用于成本估算；全量统计见 sessionTotals） */
  totalOutput: number
  /** 按模型维度的用量明细（model → ModelUsageBreakdown），本次 run 累计（成本口径）。key 为请求侧配置模型名（如中转站别名 qusc） */
  modelUsage?: Record<string, ModelUsageBreakdown>
  /** 最近一轮响应侧实际模型（API 响应 message.model；中转站动态路由时与配置名不同且逐轮可变） */
  actualModel?: string
  /** 会话内出现过的实际模型（去重保序），供展示路由分布 */
  actualModels?: string[]
  /** 会话累计用量与成本（跨消息累加每次 run 的 cumulative 事件） */
  sessionTotals?: SessionUsageTotals
  /** 水位三元组的口径来源：'turn'=单轮快照（精确）| 'cumulative'=累计兜底（可能偏大） */
  contextSource?: 'turn' | 'cumulative'
  /**
   * 本次 run 内是否已收到 turn 快照。turn 事件置 true；run 启动（cli_init）时复位 false
   * ——保证下一 run 若无快照（非流式端点）时累计兜底仍能接管水位。
   *
   * 不能在 cumulative 事件消费时复位：CLI 后台子代理完成后经 task-notification 续跑，
   * 单 run 会输出多条 result（实测 2.1.205），若首条 result 消费掉标记，次条就会用
   * 进程累计值（含子代理消耗，实测 3.6 倍虚高）覆盖水位。
   */
  turnSnapshotSeen?: boolean
  /**
   * 本 run 已计入 sessionTotals/totalOutput 的贡献值，用于同 run 多条 result 的幂等
   * 替换（modelUsage 是 CLI 进程累计，后到 result 是前一条的超集，直接累加会重复计数）。
   * run 启动（cli_init）时复位 null。仅 scope='cumulative'（Claude 引擎）参与替换；
   * scope 缺省引擎（Codex/SimpleAI）无 run 边界信号，维持逐事件累加旧语义。
   */
  runContribution?: {
    input: number
    cacheCreation: number
    cacheRead: number
    output: number
    costUsd: number
  } | null
  /** 原始 result 事件报文（含 usage/modelUsage/cost 等全字段），供调试查看 */
  rawPayload?: Record<string, unknown>
}

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
  pluginCardBlockMap: Map<string, number>
  /** 会话级工具放行集合（scope=session/global 的批准项累积；--resume 续聊自动并入 allowedTools）。绑定会话生命周期，不持久化。 */
  sessionAllowedTools: string[]
  streamingUpdateCounter: number

  // ===== 会话状态 =====
  conversationId: string | null
  currentConversationSeed: string | null
  isStreaming: boolean
  error: string | null
  progressMessage: string | null
  /** 下一步提示建议（--prompt-suggestions），点击填入输入框；null 表示无建议 */
  promptSuggestion: string | null

  /**
   * 最近一轮 token 用量（来自 AIEvent.usage）。
   * 上下文占用 = input + cacheCreation + cacheRead（三项之和）。
   * null 表示本会话尚未收到用量事件。
   */
  usageStats: UsageStats | null

  // ===== 元数据 =====
  sessionId: string // 会话唯一标识，由后端返回或前端生成

  // ===== 输入草稿 =====
  inputDraft: InputDraft

  /**
   * 待发送简报（压缩交接产物）。非空时输入框上方展示可编辑卡片，
   * 用户发送自己的消息时作为一次性系统上下文（oneTimeSystemPrompt）随之带出，
   * 不占用输入框、不进入用户消息气泡。发送后自动清空。
   */
  pendingBriefing: string | null

  // ===== 提示词优化（版本栈内存态） =====
  promptOptimize: PromptOptimizeState

  // ===== 工作区关联 =====
  workspaceId: string | null

  // ===== 可见区域追踪（消息压缩） =====
  visibleRange: { start: number; end: number } | null

  // ===== 增量落盘水位（WAL 崩溃保护） =====
  /** 已增量落盘的消息条数（messages 前缀长度）；轮末整体覆写后推进到 messages.length */
  persistedSeq: number
  /** 水位对应的 conversationId；变化（如引擎轮换会话 ID / Fork）时水位归零重刷 */
  persistedConversationId: string | null

  // ===== 历史分页（尾部优先恢复） =====
  /**
   * 磁盘侧还有更早消息未加载时的分页游标：
   * - earliestSeq = 当前已加载最早一条的磁盘 seq（不变量：messages[i] 的磁盘 seq = earliestSeq + i），
   *   向上滚动用它继续取上一页；
   * - sourceId = 前缀所在的会话文件（引擎轮换 conversationId 后仍从原文件取更早消息，
   *   轮末规整会把前缀复制进新文件后指回自身）。
   * null 表示消息已全量在内存（新会话 / 小会话 / 归档读尽）。
   */
  historyPaging: { earliestSeq: number; hasMore: boolean; sourceId: string } | null
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
  finishMessage: () => ChatMessage | null

  // ===== 输入草稿 =====
  updateInputDraft: (draft: InputDraft) => void
  clearInputDraft: () => void

  /** 设置/清空待发送简报（压缩交接产物）；传 null 清空 */
  setPendingBriefing: (briefing: string | null) => void

  // ===== 提示词优化（版本栈） =====
  /**
   * 开始一轮优化：登记快照/引擎/优化会话，status → running。
   * 版本栈处理：首轮把原文入栈；多轮先截断 redo 分支，输入被手改则手改文本先入栈。
   */
  beginPromptOptimize: (sourceText: string, meta: { engineId: EngineId; model?: string; mode?: PromptOptimizeMode; optimizeSessionId: string }) => void
  /**
   * 优化完成回填：输入与快照一致 → 结果入栈并写回 inputDraft；
   * 输入被手改 → status → ready，结果暂存 pendingResult 待用户点击应用。
   * 仅在 status === 'running' 时生效。
   */
  completePromptOptimize: (resultText: string) => void
  /** 应用 ready 状态的待应用结果（当前手改文本先入栈保留） */
  applyPendingPromptOptimize: () => void
  /** 优化失败/取消：status → idle（版本栈保留），error 可为 null（用户主动取消） */
  failPromptOptimize: (error: string | null) => void
  /** 回滚到上一版本（当前文本有未入栈手改时先入栈保留，可 redo 回来） */
  undoPromptOptimize: () => void
  /** 重做到下一版本（当前文本被手改时为 no-op，避免覆盖丢失） */
  redoPromptOptimize: () => void
  /** 清空优化状态（发送消息 / 清空草稿时调用） */
  resetPromptOptimize: () => void

  // ===== 流式构建 =====
  appendTextBlock: (content: string) => void
  /** 内部方法：将缓冲区文本 flush 到 store（流式优化，减少 set() 频率） */
  _flushTextBuffer: () => void
  appendThinkingBlock: (content: string) => void
  appendToolCallBlock: (toolId: string, toolName: string, input: Record<string, unknown>) => void
  updateToolCallBlock: (toolId: string, status: ToolStatus, output?: string, error?: string) => void
  updateToolCallBlockDiff: (toolId: string, diffData: { oldContent: string; newContent: string; filePath: string }) => void
  /** apply_patch 补丁数据回填 */
  updateToolCallBlockPatch: (toolId: string, patchData: { type: 'add' | 'update' | 'delete'; filePath: string; movePath?: string; chunkCount: number; addedLines: number; removedLines: number; oldContent: string; newContent: string }[]) => void
  appendArtifactPreviewBlock: (artifact: import('../../types/chat').ArtifactPreviewBlock) => void
  updateCurrentAssistantMessage: (blocks: ContentBlock[]) => void

  // ===== 问题块 =====
  appendQuestionBlock: (
    questionId: string,
    sessionId: string,
    questions: import('../../types/chat').QuestionItem[]
  ) => void
  updateQuestionBlock: (
    questionId: string,
    payload: {
      answers?: import('../../types/chat').SubAnswer[]
      declined?: boolean
    }
  ) => void

  // ===== PlanMode =====
  appendPlanModeBlock: (planId: string, sessionId: string, title?: string, description?: string, stages?: import('../../types/chat').PlanStageBlock[]) => void
  updatePlanModeBlock: (planId: string, updates: Partial<import('../../types/chat').PlanModeBlock>) => void
  updatePlanStageStatus: (planId: string, stageId: string, status: 'pending' | 'in_progress' | 'completed' | 'failed', tasks?: import('../../types/chat').PlanTaskBlock[]) => void
  setActivePlan: (planId: string | null) => void

  // ===== PluginCard =====
  appendPluginCardBlock: (block: import('../../types/chat').PluginCardBlock) => void
  updatePluginCardBlock: (id: string, updates: Partial<import('../../types/chat').PluginCardBlock>) => void

  // ===== 上下文压缩（Claude CLI /compact 或 autoCompact 完成） =====
  appendContextCompactBlock: (trigger: string, preTokens?: number, postTokens?: number) => void

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
  appendPermissionRequestBlock: (requestId: string, sessionId: string, denials: Array<{ toolName: string; reason: string; toolInput?: Record<string, unknown>; toolUseId?: string; extra?: Record<string, unknown> }>) => void
  updatePermissionRequestBlock: (requestId: string, status: 'pending' | 'approved' | 'denied', decision?: { approved: boolean; timestamp: string }) => void
  setActivePermissionRequest: (requestId: string | null) => void
  /** 逐项落库权限请求决策（每项批准/拒绝 + 授权范围），并据此推导整卡状态（任一批准→approved，否则 denied）。同时扫描流式消息与已归档消息。 */
  resolvePermissionRequest: (requestId: string, perItem: Array<{ status: 'approved' | 'denied'; scope?: import('../../types/chat').PermissionScope } | undefined>) => void
  /** 失效仍待处理的「工具权限请求」（仅 status==='pending' 且有真实 denials 的块；跳过 plan 审批复用的空 denials 块）。用户发新消息 / 历史恢复时调用。 */
  expireStalePermissionRequests: () => void
  /** 追加会话级放行工具（去重）。scope=session/global 的批准项调用，使本会话续聊不再询问。绑定会话生命周期，不持久化。 */
  addSessionAllowedTools: (tools: string[]) => void

  // ===== 会话控制 =====
  setConversationId: (id: string | null) => void
  setStreaming: (streaming: boolean) => void
  setError: (error: string | null) => void
  setProgressMessage: (message: string | null) => void
  setPromptSuggestion: (suggestion: string | null) => void

  // ===== 历史恢复 =====
  /** 设置初始消息（用于从历史恢复）；paging 非空 = 尾部优先分页恢复（更早消息按需从磁盘补读） */
  setMessagesFromHistory: (
    messages: ChatMessage[],
    conversationId: string | null,
    paging?: { earliestSeq: number; hasMore: boolean; sourceId: string } | null
  ) => void

  // ===== 事件处理（核心） =====
  handleAIEvent: (event: AIEvent) => void

  // ===== 主动操作 =====
  sendMessage: (
    content: string,
    workspaceDir?: string,
    attachments?: import('../../types/attachment').Attachment[],
    options?: SendMessageOptions
  ) => Promise<void>
  /** 继续会话（用于回答问题/审批计划/权限重试后） */
  continueChat: (prompt?: string, allowedTools?: string[]) => Promise<void>
  interrupt: () => Promise<void>
  regenerateResponse: (assistantMessageId: string) => Promise<void>
  editAndResend: (userMessageId: string, newContent: string) => Promise<void>
  /** 从磁盘归档中加载更早的消息（向上滚动分页；同步内存归档兜底） */
  loadMoreArchivedMessages: (count?: number) => void

  // ===== 消息压缩 =====
  /** 当可见区域变化时触发压缩/恢复 */
  onVisibleRangeChange: (start: number, end: number) => void
  /**
   * 返回适合持久化的完整消息数组。
   *
   * store 中的离屏消息可能已被 MessageCompactor 压缩（output 清空、content 截断、
   * 带 __compacted__ 标记）。若直接序列化会把这些压缩态写进 JSONL / localStorage，
   * 导致历史会话重启后内容永久丢失。本方法在持久化前把压缩态消息恢复为完整态：
   * 优先从 compactor 内存快照恢复，降级到 localStorage 历史。无压缩消息时返回原引用。
   */
  getPersistableMessages: () => ChatMessage[]

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
  engineId?: EngineId
  workspaceId: string | null
  workspaceName?: string // 工作区名称（用于显示）
  contextWorkspaceIds: string[] // 关联工作区 ID 列表
  workspaceLocked?: boolean // 主工作区是否锁定（发送消息后锁定）
  silentMode?: boolean // 静默模式（不显示在会话列表中）
  status: 'idle' | 'running' | 'waiting' | 'error' | 'background-running'
  lastAccessedAt: number // 最后访问时间戳（用于 LRU 驱逐）
  createdAt: string
  updatedAt: string
  /** Fork 来源会话 ID（Fork 创建时记录，发送第一条消息时作为 --fork-session 参数传给 CLI） */
  forkFromId?: string
  /**
   * 会话绑定的模型 Profile ID（第三方端点配置），三态语义：
   * - `undefined`：未设置 → 发送时跟随全局默认
   * - `OFFICIAL_API_PROFILE` 哨兵：用户明确选「官方 API」→ 不使用任何 Profile（优先于全局默认）
   * - 具体 id：使用该 Profile
   * 解析见 resolveEffectiveProfileId；哨兵不会透传后端。
   */
  modelProfileId?: string
  /** 会话绑定的模型名（如 'sonnet'、'opus'）。undefined 时发送降级到全局 sessionConfig.model。 */
  model?: string
  /**
   * 会话绑定的专家 agent slug（L0 用户显式 persona 覆盖）。
   * - `undefined`：未设置 → 发送时无专家（跟随全局 sessionConfig.agent，通常为空）
   * - 非空字符串：使用该 corpus/自定义专家人格
   *
   * 与 model/modelProfileId 同属「会话级覆盖 + 切换镜像回填」模式：
   * 状态栏镜像存 useSessionConfig.config.agent（即显），持久化存此字段（切换时回填镜像）。
   * sessionStoreManager 为内存级（无 persist），重启后会话级 agent 丢失，与 model 行为一致。
   */
  agent?: string
  /**
   * 会话用途标记。
   * - 'commit-message'  = GitPanel 触发的提交信息生成会话，用于回流定位
   * - 'prompt-optimize' = 输入框提示词优化的一次性静默会话（完成后即删除）
   */
  kind?: 'commit-message' | 'prompt-optimize'
  /** 当 kind === 'commit-message' 时，关联的工作区 ID，用于按工作区隔离回流。 */
  commitWorkspaceId?: string
}

/**
 * 创建会话选项
 */
export interface CreateSessionOptions {
  /** 指定会话 ID（可选，不指定则自动生成） */
  id?: string
  type: 'project' | 'free'
  workspaceId?: string
  /** 关联工作区 ID 列表（可选，多选） */
  contextWorkspaceIds?: string[]
  /** 创建时是否锁定主工作区（默认：有 workspaceId 时为 true） */
  workspaceLocked?: boolean
  title?: string
  engineId?: string
  /** 静默模式：不自动激活，不显示在 UI */
  silentMode?: boolean
  /** Fork 来源会话 ID（Fork 场景下记录源会话，发消息时用于 --fork-session） */
  forkFromId?: string
  /** 会话绑定的模型 Profile ID（可选，不指定则使用全局默认） */
  modelProfileId?: string
  /** 会话绑定的模型名（可选，不指定则使用全局默认） */
  model?: string
  /** 会话绑定的专家 agent slug（可选，不指定则无专家） */
  agent?: string
  /** 会话用途标记（透传到 SessionMetadata.kind） */
  kind?: 'commit-message' | 'prompt-optimize'
  /** commit-message 会话关联的工作区 ID（透传到 SessionMetadata.commitWorkspaceId） */
  commitWorkspaceId?: string
}

/**
 * 从历史创建会话选项
 */
export interface CreateSessionFromHistoryOptions {
  title: string
  workspaceId?: string
  engineId?: EngineId
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

  /** 反向索引：后端 conversationId → 前端 sessionId，用于 O(1) 查找 store */
  conversationIdToStoreId: Map<string, string>
}

/**
 * SessionStoreManager 操作
 */
export interface SessionManagerActions {
  // ===== 会话生命周期 =====
  createSession: (options: CreateSessionOptions) => string
  /** 从历史创建会话（恢复历史消息） */
  createSessionFromHistory: (options: import('../../types').ChatMessage[], conversationId: string | null, metadata?: { title?: string; workspaceId?: string; forkFromId?: string; engineId?: EngineId; paging?: { earliestSeq: number; hasMore: boolean; sourceId: string } | null }) => string
  deleteSession: (sessionId: string) => void
  switchSession: (sessionId: string) => void
  /** 更新会话标题 */
  updateSessionTitle: (sessionId: string, title: string) => void
  /** 更新空会话的 AI 引擎 */
  updateSessionEngine: (sessionId: string, engineId: EngineId) => boolean
  /**
   * 更新会话的模型 Profile ID。
   * - 传具体 id 或 OFFICIAL_API_PROFILE 哨兵 → 写入会话级覆盖
   * - 传 `null` → 清除会话级覆盖（回到「未设置 → 跟随全局默认」）
   */
  updateSessionModelProfile: (sessionId: string, modelProfileId: string | null) => void
  /**
   * 更新会话绑定的模型名。
   * - 传具体模型名或空串 → 写入会话级覆盖
   * - 传 `null` → 清除会话级覆盖（回到「未设置 → 跟随全局默认」）
   */
  updateSessionModel: (sessionId: string, model: string | null) => void
  /**
   * 更新会话绑定的专家 agent slug。
   * - 传非空字符串 → 写入会话级覆盖（该会话锁定此专家）
   * - 传 `null` 或空串 → 清除会话级专家覆盖
   *
   * 与 updateSessionModel 同构；镜像同步发生在 switchSession（切回该会话时回填 useSessionConfig.agent）。
   */
  updateSessionAgent: (sessionId: string, agent: string | null) => void

  // ===== Store 访问 =====
  getStore: (sessionId: string) => ConversationStore | undefined
  getActiveStore: () => ConversationStore | undefined
  getActiveSessionId: () => string | null
  /** 通过后端 conversationId 查找前端 store 状态 (O(1)) */
  getStoreByConversationId: (conversationId: string) => ConversationStore | undefined
  /** 注册 conversationId → sessionId 反向索引 */
  registerConversationId: (conversationId: string, sessionId: string) => void
  /** 注销 conversationId 反向索引 */
  unregisterConversationId: (conversationId: string) => void

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
  /** 将静默会话切换为可见 */
  makeSessionVisible: (sessionId: string) => void

  // ===== 批量操作 =====
  getStreamingSessions: () => string[]
  interruptSession: (sessionId: string) => Promise<void>
  interruptAllBackground: () => Promise<void>

  // ===== 初始化 =====
  initialize: () => Promise<void>
}

export type SessionStoreManager = SessionManagerState & SessionManagerActions
