/**
 * AI Event - 通用事件模型
 *
 * 定义了 AI Engine 向 UI 层传递所有事件的标准格式。
 * UI / 日志 / Tool 面板只能消费 AIEvent，禁止直接消费 CLI 原始输出。
 *
 * 所有事件都必须包含 sessionId 字段，用于多会话事件路由。
 */

/**
 * Token 事件 - 文本增量输出
 */
export interface TokenEvent {
  type: 'token'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 文本内容 */
  value: string
}

/**
 * 思考过程事件
 */
export interface ThinkingEvent {
  type: 'thinking'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 思考内容 */
  content: string
}

/**
 * 工具调用开始事件
 */
export interface ToolCallStartEvent {
  type: 'tool_call_start'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 工具调用 ID */
  callId?: string
  /** 工具名称 */
  tool: string
  /** 工具参数 */
  args: Record<string, unknown>
}

/**
 * 工具调用结束事件
 */
export interface ToolCallEndEvent {
  type: 'tool_call_end'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 工具调用 ID */
  callId?: string
  /** 工具名称 */
  tool: string
  /** 工具执行结果 */
  result?: unknown
  /** 是否成功 */
  success: boolean
}

/**
 * 进度事件 - 任务进度更新
 */
export interface ProgressEvent {
  type: 'progress'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 进度消息 */
  message?: string
  /** 进度百分比 0-100 */
  percent?: number
}

/**
 * 结果事件 - 任务完成
 */
export interface ResultEvent {
  type: 'result'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务输出结果 */
  output: unknown
}

/**
 * 错误事件 - 任务出错
 */
export interface ErrorEvent {
  type: 'error'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 错误信息 */
  error: string
  /** 错误码（可选） */
  code?: string
}

/**
 * 会话开始事件
 */
export interface SessionStartEvent {
  type: 'session_start'
  /** 会话 ID */
  sessionId: string
}

/**
 * 会话结束事件
 */
export interface SessionEndEvent {
  type: 'session_end'
  /** 会话 ID */
  sessionId: string
  /** 结束原因 */
  reason?: 'completed' | 'aborted' | 'error'
}

/**
 * 用户消息事件
 */
export interface UserMessageEvent {
  type: 'user_message'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 用户消息内容 */
  content: string
  /** 关联的文件 */
  files?: string[]
}

/**
 * AI 消息事件
 */
export interface AssistantMessageEvent {
  type: 'assistant_message'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 消息内容（可能是部分内容） */
  content: string
  /** 是否为增量更新 */
  isDelta: boolean
  /** 消息中包含的工具调用 */
  toolCalls?: ToolCallInfo[]
}

/**
 * 工具调用信息
 */
export interface ToolCallInfo {
  /** 工具唯一 ID */
  id: string
  /** 工具名称 */
  name: string
  /** 工具参数 */
  args: Record<string, unknown>
  /** 执行状态 */
  status: 'pending' | 'running' | 'completed' | 'failed'
  /** 执行结果 */
  result?: unknown
}

/**
 * Task 状态
 */
export type TaskStatus = 'pending' | 'running' | 'success' | 'error' | 'canceled'

/**
 * Task 元数据事件
 */
export interface TaskMetadataEvent {
  type: 'task_metadata'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** 任务状态 */
  status: TaskStatus
  /** 任务开始时间 */
  startTime?: number
  /** 任务结束时间 */
  endTime?: number
  /** 执行时长（毫秒） */
  duration?: number
  /** 错误信息（失败时） */
  error?: string
}

/**
 * Task 进度更新事件（继承 ProgressEvent，增加 taskId）
 */
export interface TaskProgressEvent {
  type: 'task_progress'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** 进度消息 */
  message?: string
  /** 进度百分比 0-100 */
  percent?: number
}

/**
 * Task 完成事件
 */
export interface TaskCompletedEvent {
  type: 'task_completed'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** 最终状态 */
  status: Exclude<TaskStatus, 'pending' | 'running'>
  /** 执行时长（毫秒） */
  duration?: number
  /** 错误信息（失败时） */
  error?: string
}

/**
 * Task 取消事件
 */
export interface TaskCanceledEvent {
  type: 'task_canceled'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** 取消原因 */
  reason?: string
}

// ========================================
// AgentRun 相关事件
// ========================================

/**
 * AgentRun 开始事件
 */
export interface AgentRunStartEvent {
  type: 'agent_run_start'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** Agent 类型 */
  agentType: string
  /** Agent 能力列表 */
  capabilities?: string[]
}

/**
 * AgentRun 结束事件
 */
export interface AgentRunEndEvent {
  type: 'agent_run_end'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 任务 ID */
  taskId: string
  /** 是否成功 */
  success: boolean
  /** 结果摘要 */
  result?: string
}

// ========================================
// Question 相关事件
// ========================================

/**
 * Question 选项
 */
export interface QuestionOption {
  /** 选项值 */
  value: string
  /** 选项标签 */
  label?: string
  /** 选项描述 */
  description?: string
  /** 选项预览 */
  preview?: string
}

/**
 * Question 事件 - AI 询问用户问题
 */
export interface QuestionEvent {
  type: 'question'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 问题 ID */
  questionId: string
  /** 问题标题 */
  header: string
  /** 选项列表 */
  options: QuestionOption[]
  /** 是否多选 */
  multiSelect?: boolean
  /** 是否允许自定义输入 */
  allowCustomInput?: boolean
  /** 分类标签 */
  categoryLabel?: string
}

/**
 * QuestionAnswered 事件 - 用户回答问题
 */
export interface QuestionAnsweredEvent {
  type: 'question_answered'
  /** 会话 ID - 用于事件路由 */
  sessionId: string
  /** 问题 ID */
  questionId: string
  /** 用户选择的选项 */
  selected: string[]
  /** 用户自定义输入 */
  customInput?: string
}

// ========================================
// Todo 相关事件
// ========================================

/**
 * 待办创建事件
 */
export interface TodoCreatedEvent {
  type: 'todo_created'
  /** 待办 ID */
  todoId: string
  /** 待办内容 */
  content: string
  /** 优先级 */
  priority: string
  /** 创建来源（用户/AI） */
  source: 'user' | 'ai'
}

/**
 * 待办更新事件
 */
export interface TodoUpdatedEvent {
  type: 'todo_updated'
  /** 待办 ID */
  todoId: string
  /** 更新字段 */
  changes: {
    status?: string
    content?: string
    priority?: string
  }
}

/**
 * 待办删除事件
 */
export interface TodoDeletedEvent {
  type: 'todo_deleted'
  /** 待办 ID */
  todoId: string
}

/**
 * 待办执行开始事件
 */
export interface TodoExecutionStartedEvent {
  type: 'todo_execution_started'
  /** 待办 ID */
  todoId: string
  /** 关联的会话 ID */
  sessionId: string
}

/**
 * 待办执行进度事件
 */
export interface TodoExecutionProgressEvent {
  type: 'todo_execution_progress'
  /** 待办 ID */
  todoId: string
  /** 进度消息 */
  message: string
  /** 进度百分比 */
  percent?: number
}

/**
 * 待办执行完成事件
 */
export interface TodoExecutionCompletedEvent {
  type: 'todo_execution_completed'
  /** 待办 ID */
  todoId: string
  /** 完成状态 */
  status: 'success' | 'failed' | 'aborted'
  /** 错误信息（失败时） */
  error?: string
}

// ========================================
// Question 相关事件
// ========================================

/**
 * 问题答案
 */
export interface QuestionAnswerData {
  /** 选中的选项值 */
  selected: string[]
  /** 自定义输入 */
  customInput?: string
}

// ========================================
// PlanMode 相关事件
// ========================================

/** PlanMode 状态 */
export type PlanStatus = 
  | 'drafting'      // 正在起草计划
  | 'pending_approval' // 等待审批
  | 'approved'      // 已批准
  | 'rejected'      // 已拒绝
  | 'executing'     // 正在执行
  | 'completed'     // 已完成
  | 'canceled'      // 已取消

/** 计划任务 */
export interface PlanTask {
  /** 任务 ID */
  taskId: string
  /** 任务描述 */
  description: string
  /** 任务状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped'
}

/** 计划阶段 */
export interface PlanStage {
  /** 阶段 ID */
  stageId: string
  /** 阶段名称 */
  name: string
  /** 阶段描述 */
  description?: string
  /** 阶段状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  /** 阶段内的任务列表 */
  tasks: PlanTask[]
}

/**
 * Plan 开始事件
 */
export interface PlanStartEvent {
  type: 'plan_start'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
}

/**
 * Plan 内容事件 - 发送完整的计划内容
 */
export interface PlanContentEvent {
  type: 'plan_content'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
  /** 计划标题 */
  title?: string
  /** 计划描述 */
  description?: string
  /** 阶段列表 */
  stages: PlanStage[]
  /** 当前计划状态 */
  status: PlanStatus
}

/**
 * Plan 阶段更新事件
 */
export interface PlanStageUpdateEvent {
  type: 'plan_stage_update'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
  /** 阶段 ID */
  stageId: string
  /** 阶段状态 */
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  /** 更新的任务列表（可选） */
  tasks?: PlanTask[]
}

/**
 * Plan 审批请求事件
 */
export interface PlanApprovalRequestEvent {
  type: 'plan_approval_request'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
  /** 请求消息 */
  message?: string
}

/**
 * Plan 审批结果事件
 */
export interface PlanApprovalResultEvent {
  type: 'plan_approval_result'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
  /** 审批结果 */
  approved: boolean
  /** 修改建议（拒绝时可能有） */
  feedback?: string
}

/**
 * Plan 结束事件
 */
export interface PlanEndEvent {
  type: 'plan_end'
  /** 会话 ID */
  sessionId: string
  /** 计划 ID */
  planId: string
  /** 结束状态 */
  status: 'completed' | 'canceled' | 'rejected'
  /** 结束原因 */
  reason?: string
}

// ========================================
// Image Generation 相关事件
// ========================================

/** 图像生成状态 */
export type ImageGenerationStatus = 'generating' | 'completed' | 'failed'

/**
 * 图像生成开始事件
 */
export interface ImageGenerationStartEvent {
  type: 'image_generation_start'
  sessionId: string
  taskId: string
  /** 生成提示词 */
  prompt: string
  /** 图像尺寸 */
  size?: string
  /** 是否为图生图模式 */
  isImageEdit?: boolean
}

/**
 * 图像生成进度事件
 */
export interface ImageGenerationProgressEvent {
  type: 'image_generation_progress'
  sessionId: string
  taskId: string
  progress: number
  message?: string
}

/**
 * 图像生成完成事件
 */
export interface ImageGeneratedEvent {
  type: 'image_generated'
  sessionId: string
  taskId: string
  /** 生成图像的 URL */
  imageUrl: string
  /** 原始提示词 */
  prompt: string
  /** 图像尺寸 */
  size?: string
  /** 元数据 */
  metadata?: {
    model?: string
    revisedPrompt?: string
    seed?: number
  }
}

/**
 * 图像生成错误事件
 */
export interface ImageGenerationErrorEvent {
  type: 'image_generation_error'
  sessionId: string
  taskId: string
  error: string
  code?: string
}

// ========================================
// Video Generation 相关事件 (异步任务模型)
// ========================================

/** 视频任务状态 */
export type VideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/**
 * 视频任务创建事件
 */
export interface VideoTaskCreatedEvent {
  type: 'video_task_created'
  sessionId: string
  taskId: string
  /** Agnes Video API 返回的远程 task_id */
  videoTaskId: string
  status: 'queued'
  /** 原始提示词 */
  prompt: string
}

/**
 * 视频任务进度事件
 */
export interface VideoTaskProgressEvent {
  type: 'video_task_progress'
  sessionId: string
  taskId: string
  videoTaskId: string
  progress: number
  status: VideoTaskStatus
  message?: string
}

/**
 * 视频生成完成事件
 */
export interface VideoCompletedEvent {
  type: 'video_completed'
  sessionId: string
  taskId: string
  videoTaskId: string
  /** 生成视频的 URL */
  videoUrl: string
  /** 视频时长（秒） */
  duration?: number
  /** 视频分辨率 */
  size?: string
  /** 使用统计 */
  usage?: {
    durationSeconds?: number
  }
}

/**
 * 视频任务失败事件
 */
export interface VideoTaskFailedEvent {
  type: 'video_task_failed'
  sessionId: string
  taskId: string
  videoTaskId: string
  error: string
  code?: string
}

// ========================================
// Pipeline (漫画/漫剧) 相关事件
// ========================================

/** 管线阶段 */
export type PipelinePhase =
  | 'script'       // 剧本生成
  | 'character'    // 角色设计
  | 'storyboard'   // 分镜图生成
  | 'animation'    // 漫剧动效
  | 'finalize'     // 合成输出

/** 管线阶段状态 */
export interface PipelinePhaseInfo {
  phase: PipelinePhase
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  progress: number
  message?: string
  /** 阶段产物 */
  artifacts?: string[]
}

/**
 * 管线开始事件
 */
export interface PipelineStartEvent {
  type: 'pipeline_start'
  sessionId: string
  taskId: string
  /** 管线类型 */
  pipelineType: 'comic' | 'motion_comic' | 'both'
  /** 各阶段计划 */
  phases: PipelinePhaseInfo[]
}

/**
 * 管线阶段变更事件
 */
export interface PipelinePhaseEvent {
  type: 'pipeline_phase'
  sessionId: string
  taskId: string
  phase: PipelinePhaseInfo
}

/**
 * 管线进度事件
 */
export interface PipelineProgressEvent {
  type: 'pipeline_progress'
  sessionId: string
  taskId: string
  overallProgress: number
  currentPhase: PipelinePhase
  message: string
}

/**
 * 管线完成事件
 */
export interface PipelineCompletedEvent {
  type: 'pipeline_completed'
  sessionId: string
  taskId: string
  /** 最终产物列表 */
  artifacts: Array<{
    type: 'image' | 'video' | 'document'
    url: string
    label: string
  }>
  /** 总耗时（毫秒） */
  totalDuration?: number
}

/**
 * 管线失败事件
 */
export interface PipelineFailedEvent {
  type: 'pipeline_failed'
  sessionId: string
  taskId: string
  error: string
  failedPhase: PipelinePhase
}

// ========================================
// PermissionRequest 相关事件
// ========================================

/**
 * 权限拒绝详情
 */
export interface PermissionDenial {
  /** 工具名称 */
  toolName: string
  /** 拒绝原因 */
  reason: string
  /** 额外信息 */
  extra?: Record<string, unknown>
}

/**
 * 权限请求事件 - 工具调用被拒绝，需要用户确认
 */
export interface PermissionRequestEvent {
  type: 'permission_request'
  /** 会话 ID */
  sessionId: string
  /** 拒绝详情列表 */
  denials: PermissionDenial[]
}

/**
 * AI Event - 所有事件的联合类型
 *
 * UI 层只能消费此类型的事件，禁止直接解析 CLI 输出。
 * Engine 必须将原始输出转换为 AIEvent 后再传递给 UI。
 */
export type AIEvent =
  | TokenEvent
  | ThinkingEvent
  | ToolCallStartEvent
  | ToolCallEndEvent
  | ProgressEvent
  | ResultEvent
  | ErrorEvent
  | SessionStartEvent
  | SessionEndEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | TaskMetadataEvent
  | TaskProgressEvent
  | TaskCompletedEvent
  | TaskCanceledEvent
  | AgentRunStartEvent
  | AgentRunEndEvent
  | QuestionEvent
  | QuestionAnsweredEvent
  | TodoCreatedEvent
  | TodoUpdatedEvent
  | TodoDeletedEvent
  | TodoExecutionStartedEvent
  | TodoExecutionProgressEvent
  | TodoExecutionCompletedEvent
  | PlanStartEvent
  | PlanContentEvent
  | PlanStageUpdateEvent
  | PlanApprovalRequestEvent
  | PlanApprovalResultEvent
  | PlanEndEvent
  | PermissionRequestEvent
  // 多模态事件
  | ImageGenerationStartEvent
  | ImageGenerationProgressEvent
  | ImageGeneratedEvent
  | ImageGenerationErrorEvent
  | VideoTaskCreatedEvent
  | VideoTaskProgressEvent
  | VideoCompletedEvent
  | VideoTaskFailedEvent
  // 管线事件
  | PipelineStartEvent
  | PipelinePhaseEvent
  | PipelineProgressEvent
  | PipelineCompletedEvent
  | PipelineFailedEvent

/**
 * 事件监听器类型
 */
export type AIEventListener = (event: AIEvent) => void

/**
 * 事件过滤器类型
 */
export type AIEventFilter = (event: AIEvent) => boolean

/**
 * 创建 Token 事件
 */
export function createTokenEvent(sessionId: string, value: string): TokenEvent {
  return { type: 'token', sessionId, value }
}

/**
 * 创建思考过程事件
 */
export function createThinkingEvent(sessionId: string, content: string): ThinkingEvent {
  return { type: 'thinking', sessionId, content }
}

/**
 * 创建工具调用开始事件
 */
export function createToolCallStartEvent(
  sessionId: string,
  tool: string,
  args: Record<string, unknown>
): ToolCallStartEvent {
  return { type: 'tool_call_start', sessionId, tool, args }
}

/**
 * 创建工具调用结束事件
 */
export function createToolCallEndEvent(
  sessionId: string,
  tool: string,
  result?: unknown,
  success = true
): ToolCallEndEvent {
  return { type: 'tool_call_end', sessionId, tool, result, success }
}

/**
 * 创建进度事件
 */
export function createProgressEvent(
  sessionId: string,
  message?: string,
  percent?: number
): ProgressEvent {
  return { type: 'progress', sessionId, message, percent }
}

/**
 * 创建错误事件
 */
export function createErrorEvent(
  sessionId: string,
  error: string,
  code?: string
): ErrorEvent {
  return { type: 'error', sessionId, error, code }
}

/**
 * 创建会话开始事件
 */
export function createSessionStartEvent(sessionId: string): SessionStartEvent {
  return { type: 'session_start', sessionId }
}

/**
 * 创建会话结束事件
 */
export function createSessionEndEvent(
  sessionId: string,
  reason?: SessionEndReason
): SessionEndEvent {
  return { type: 'session_end', sessionId, reason }
}

/**
 * 会话结束原因
 */
export type SessionEndReason = 'completed' | 'aborted' | 'error'

/**
 * 创建用户消息事件
 */
export function createUserMessageEvent(
  sessionId: string,
  content: string,
  files?: string[]
): UserMessageEvent {
  return { type: 'user_message', sessionId, content, files }
}

/**
 * 创建 AI 消息事件
 */
export function createAssistantMessageEvent(
  sessionId: string,
  content: string,
  isDelta = false,
  toolCalls?: ToolCallInfo[]
): AssistantMessageEvent {
  return { type: 'assistant_message', sessionId, content, isDelta, toolCalls }
}

/**
 * 判断事件类型
 */
export function isTokenEvent(event: AIEvent): event is TokenEvent {
  return event.type === 'token'
}

export function isThinkingEvent(event: AIEvent): event is ThinkingEvent {
  return event.type === 'thinking'
}

export function isToolCallStartEvent(event: AIEvent): event is ToolCallStartEvent {
  return event.type === 'tool_call_start'
}

export function isToolCallEndEvent(event: AIEvent): event is ToolCallEndEvent {
  return event.type === 'tool_call_end'
}

export function isProgressEvent(event: AIEvent): event is ProgressEvent {
  return event.type === 'progress'
}

export function isErrorEvent(event: AIEvent): event is ErrorEvent {
  return event.type === 'error'
}

export function isResultEvent(event: AIEvent): event is ResultEvent {
  return event.type === 'result'
}

export function isSessionStartEvent(event: AIEvent): event is SessionStartEvent {
  return event.type === 'session_start'
}

export function isSessionEndEvent(event: AIEvent): event is SessionEndEvent {
  return event.type === 'session_end'
}

export function isUserMessageEvent(event: AIEvent): event is UserMessageEvent {
  return event.type === 'user_message'
}

export function isAssistantMessageEvent(event: AIEvent): event is AssistantMessageEvent {
  return event.type === 'assistant_message'
}

/**
 * 创建 Task 元数据事件
 */
export function createTaskMetadataEvent(
  sessionId: string,
  taskId: string,
  status: TaskStatus,
  metadata?: Partial<Omit<TaskMetadataEvent, 'type' | 'sessionId' | 'taskId' | 'status'>>
): TaskMetadataEvent {
  return { type: 'task_metadata', sessionId, taskId, status, ...metadata }
}

/**
 * 创建 Task 进度事件
 */
export function createTaskProgressEvent(
  sessionId: string,
  taskId: string,
  message?: string,
  percent?: number
): TaskProgressEvent {
  return { type: 'task_progress', sessionId, taskId, message, percent }
}

/**
 * 创建 Task 完成事件
 */
export function createTaskCompletedEvent(
  sessionId: string,
  taskId: string,
  status: Exclude<TaskStatus, 'pending' | 'running'>,
  duration?: number,
  error?: string
): TaskCompletedEvent {
  return { type: 'task_completed', sessionId, taskId, status, duration, error }
}

/**
 * 创建 Task 取消事件
 */
export function createTaskCanceledEvent(
  sessionId: string,
  taskId: string,
  reason?: string
): TaskCanceledEvent {
  return { type: 'task_canceled', sessionId, taskId, reason }
}

/**
 * Task 事件类型守卫
 */
export function isTaskMetadataEvent(event: AIEvent): event is TaskMetadataEvent {
  return event.type === 'task_metadata'
}

export function isTaskProgressEvent(event: AIEvent): event is TaskProgressEvent {
  return event.type === 'task_progress'
}

export function isTaskCompletedEvent(event: AIEvent): event is TaskCompletedEvent {
  return event.type === 'task_completed'
}

export function isTaskCanceledEvent(event: AIEvent): event is TaskCanceledEvent {
  return event.type === 'task_canceled'
}

// ========================================
// Todo 事件创建函数
// ========================================

/**
 * 创建待办创建事件
 */
export function createTodoCreatedEvent(
  todoId: string,
  content: string,
  priority: string,
  source: 'user' | 'ai' = 'user'
): TodoCreatedEvent {
  return { type: 'todo_created', todoId, content, priority, source }
}

/**
 * 创建待办更新事件
 */
export function createTodoUpdatedEvent(
  todoId: string,
  changes: {
    status?: string
    content?: string
    priority?: string
  }
): TodoUpdatedEvent {
  return { type: 'todo_updated', todoId, changes }
}

/**
 * 创建待办删除事件
 */
export function createTodoDeletedEvent(todoId: string): TodoDeletedEvent {
  return { type: 'todo_deleted', todoId }
}

/**
 * 创建待办执行开始事件
 */
export function createTodoExecutionStartedEvent(
  todoId: string,
  sessionId: string
): TodoExecutionStartedEvent {
  return { type: 'todo_execution_started', todoId, sessionId }
}

/**
 * 创建待办执行进度事件
 */
export function createTodoExecutionProgressEvent(
  todoId: string,
  message: string,
  percent?: number
): TodoExecutionProgressEvent {
  return { type: 'todo_execution_progress', todoId, message, percent }
}

/**
 * 创建待办执行完成事件
 */
export function createTodoExecutionCompletedEvent(
  todoId: string,
  status: 'success' | 'failed' | 'aborted',
  error?: string
): TodoExecutionCompletedEvent {
  return { type: 'todo_execution_completed', todoId, status, error }
}

// ========================================
// Todo 事件类型守卫
// ========================================

export function isTodoCreatedEvent(event: AIEvent): event is TodoCreatedEvent {
  return event.type === 'todo_created'
}

export function isTodoUpdatedEvent(event: AIEvent): event is TodoUpdatedEvent {
  return event.type === 'todo_updated'
}

export function isTodoDeletedEvent(event: AIEvent): event is TodoDeletedEvent {
  return event.type === 'todo_deleted'
}

export function isTodoExecutionStartedEvent(event: AIEvent): event is TodoExecutionStartedEvent {
  return event.type === 'todo_execution_started'
}

export function isTodoExecutionProgressEvent(event: AIEvent): event is TodoExecutionProgressEvent {
  return event.type === 'todo_execution_progress'
}

export function isTodoExecutionCompletedEvent(event: AIEvent): event is TodoExecutionCompletedEvent {
  return event.type === 'todo_execution_completed'
}

// ========================================
// 通用类型守卫
// ========================================

/** AIEvent 类型列表 */
const AI_EVENT_TYPES = new Set([
  'token',
  'thinking',
  'tool_call_start',
  'tool_call_end',
  'progress',
  'result',
  'error',
  'session_start',
  'session_end',
  'user_message',
  'assistant_message',
  'task_metadata',
  'task_progress',
  'task_completed',
  'task_canceled',
  'agent_run_start',
  'agent_run_end',
  'question',
  'question_answered',
  'todo_created',
  'todo_updated',
  'todo_deleted',
  'todo_execution_started',
  'todo_execution_progress',
  'todo_execution_completed',
  'plan_start',
  'plan_content',
  'plan_stage_update',
  'plan_approval_request',
  'plan_approval_result',
  'plan_end',
  'permission_request',
  // 多模态事件
  'image_generation_start',
  'image_generation_progress',
  'image_generated',
  'image_generation_error',
  'video_task_created',
  'video_task_progress',
  'video_completed',
  'video_task_failed',
  // 管线事件
  'pipeline_start',
  'pipeline_phase',
  'pipeline_progress',
  'pipeline_completed',
  'pipeline_failed',
])

/**
 * 检查 unknown 对象是否是有效的 AIEvent
 * 用于事件路由器等场景，安全地将 unknown 转换为 AIEvent
 */
export function isAIEvent(value: unknown): value is AIEvent {
  if (!value || typeof value !== 'object') {
    return false
  }
  const event = value as Record<string, unknown>
  return typeof event.type === 'string' && AI_EVENT_TYPES.has(event.type)
}

// ========================================
// Question 事件类型守卫
// ========================================

export function isQuestionAnsweredEvent(event: AIEvent): event is QuestionAnsweredEvent {
  return event.type === 'question_answered'
}

// ========================================
// PlanMode 事件类型守卫
// ========================================

export function isPlanStartEvent(event: AIEvent): event is PlanStartEvent {
  return event.type === 'plan_start'
}

export function isPlanContentEvent(event: AIEvent): event is PlanContentEvent {
  return event.type === 'plan_content'
}

export function isPlanStageUpdateEvent(event: AIEvent): event is PlanStageUpdateEvent {
  return event.type === 'plan_stage_update'
}

export function isPlanApprovalRequestEvent(event: AIEvent): event is PlanApprovalRequestEvent {
  return event.type === 'plan_approval_request'
}

export function isPlanApprovalResultEvent(event: AIEvent): event is PlanApprovalResultEvent {
  return event.type === 'plan_approval_result'
}

export function isPlanEndEvent(event: AIEvent): event is PlanEndEvent {
  return event.type === 'plan_end'
}

/** 判断是否为任意 PlanMode 事件 */
export function isPlanEvent(event: AIEvent): event is PlanStartEvent | PlanContentEvent | PlanStageUpdateEvent | PlanApprovalRequestEvent | PlanApprovalResultEvent | PlanEndEvent {
  return event.type.startsWith('plan_')
}

// ========================================
// PermissionRequest 事件类型守卫
// ========================================

export function isPermissionRequestEvent(event: AIEvent): event is PermissionRequestEvent {
  return event.type === 'permission_request'
}

// ========================================
// AgentRun 事件类型守卫
// ========================================

export function isAgentRunStartEvent(event: AIEvent): event is AgentRunStartEvent {
  return event.type === 'agent_run_start'
}

export function isAgentRunEndEvent(event: AIEvent): event is AgentRunEndEvent {
  return event.type === 'agent_run_end'
}

/** 判断是否为任意 AgentRun 事件 */
export function isAgentRunEvent(event: AIEvent): event is AgentRunStartEvent | AgentRunEndEvent {
  return event.type.startsWith('agent_run_')
}

// ========================================
// Question 事件类型守卫
// ========================================

export function isQuestionEvent(event: AIEvent): event is QuestionEvent {
  return event.type === 'question'
}

// ========================================
// SessionId 提取
// ========================================

/**
 * 从事件中提取 sessionId
 * 返回 null 如果事件没有 sessionId 字段
 */
export function getEventSessionId(event: AIEvent): string | null {
  if ('sessionId' in event && typeof (event as AIEvent & { sessionId?: string }).sessionId === 'string') {
    return (event as AIEvent & { sessionId: string }).sessionId
  }
  return null
}

/**
 * 检查事件是否有 sessionId 字段
 * 用于兼容旧代码的运行时检查
 */
export function hasSessionId(event: AIEvent): event is AIEvent & { sessionId: string } {
  return 'sessionId' in event && typeof (event as AIEvent & { sessionId?: string }).sessionId === 'string'
}

// ========================================
// Image Generation 事件工厂函数
// ========================================

export function createImageGenerationStartEvent(
  sessionId: string,
  taskId: string,
  prompt: string,
  size?: string,
  isImageEdit?: boolean
): ImageGenerationStartEvent {
  return { type: 'image_generation_start', sessionId, taskId, prompt, size, isImageEdit }
}

export function createImageGenerationProgressEvent(
  sessionId: string,
  taskId: string,
  progress: number,
  message?: string
): ImageGenerationProgressEvent {
  return { type: 'image_generation_progress', sessionId, taskId, progress, message }
}

export function createImageGeneratedEvent(
  sessionId: string,
  taskId: string,
  imageUrl: string,
  prompt: string,
  size?: string,
  metadata?: ImageGeneratedEvent['metadata']
): ImageGeneratedEvent {
  return { type: 'image_generated', sessionId, taskId, imageUrl, prompt, size, metadata }
}

export function createImageGenerationErrorEvent(
  sessionId: string,
  taskId: string,
  error: string,
  code?: string
): ImageGenerationErrorEvent {
  return { type: 'image_generation_error', sessionId, taskId, error, code }
}

// ========================================
// Video Generation 事件工厂函数
// ========================================

export function createVideoTaskCreatedEvent(
  sessionId: string,
  taskId: string,
  videoTaskId: string,
  prompt: string
): VideoTaskCreatedEvent {
  return { type: 'video_task_created', sessionId, taskId, videoTaskId, status: 'queued', prompt }
}

export function createVideoTaskProgressEvent(
  sessionId: string,
  taskId: string,
  videoTaskId: string,
  progress: number,
  status: VideoTaskStatus,
  message?: string
): VideoTaskProgressEvent {
  return { type: 'video_task_progress', sessionId, taskId, videoTaskId, progress, status, message }
}

export function createVideoCompletedEvent(
  sessionId: string,
  taskId: string,
  videoTaskId: string,
  videoUrl: string,
  duration?: number,
  size?: string,
  usage?: VideoCompletedEvent['usage']
): VideoCompletedEvent {
  return { type: 'video_completed', sessionId, taskId, videoTaskId, videoUrl, duration, size, usage }
}

export function createVideoTaskFailedEvent(
  sessionId: string,
  taskId: string,
  videoTaskId: string,
  error: string,
  code?: string
): VideoTaskFailedEvent {
  return { type: 'video_task_failed', sessionId, taskId, videoTaskId, error, code }
}

// ========================================
// Pipeline 事件工厂函数
// ========================================

export function createPipelineStartEvent(
  sessionId: string,
  taskId: string,
  pipelineType: PipelineStartEvent['pipelineType'],
  phases: PipelinePhaseInfo[]
): PipelineStartEvent {
  return { type: 'pipeline_start', sessionId, taskId, pipelineType, phases }
}

export function createPipelinePhaseEvent(
  sessionId: string,
  taskId: string,
  phase: PipelinePhaseInfo
): PipelinePhaseEvent {
  return { type: 'pipeline_phase', sessionId, taskId, phase }
}

export function createPipelineProgressEvent(
  sessionId: string,
  taskId: string,
  overallProgress: number,
  currentPhase: PipelinePhase,
  message: string
): PipelineProgressEvent {
  return { type: 'pipeline_progress', sessionId, taskId, overallProgress, currentPhase, message }
}

export function createPipelineCompletedEvent(
  sessionId: string,
  taskId: string,
  artifacts: PipelineCompletedEvent['artifacts'],
  totalDuration?: number
): PipelineCompletedEvent {
  return { type: 'pipeline_completed', sessionId, taskId, artifacts, totalDuration }
}

export function createPipelineFailedEvent(
  sessionId: string,
  taskId: string,
  error: string,
  failedPhase: PipelinePhase
): PipelineFailedEvent {
  return { type: 'pipeline_failed', sessionId, taskId, error, failedPhase }
}

// ========================================
// Image Generation 事件类型守卫
// ========================================

export function isImageGenerationStartEvent(event: AIEvent): event is ImageGenerationStartEvent {
  return event.type === 'image_generation_start'
}

export function isImageGenerationProgressEvent(event: AIEvent): event is ImageGenerationProgressEvent {
  return event.type === 'image_generation_progress'
}

export function isImageGeneratedEvent(event: AIEvent): event is ImageGeneratedEvent {
  return event.type === 'image_generated'
}

export function isImageGenerationErrorEvent(event: AIEvent): event is ImageGenerationErrorEvent {
  return event.type === 'image_generation_error'
}

/** 判断是否为任意 Image Generation 事件 */
export function isImageGenerationEvent(event: AIEvent): event is ImageGenerationStartEvent | ImageGenerationProgressEvent | ImageGeneratedEvent | ImageGenerationErrorEvent {
  return event.type.startsWith('image_generation') || event.type === 'image_generated'
}

// ========================================
// Video Generation 事件类型守卫
// ========================================

export function isVideoTaskCreatedEvent(event: AIEvent): event is VideoTaskCreatedEvent {
  return event.type === 'video_task_created'
}

export function isVideoTaskProgressEvent(event: AIEvent): event is VideoTaskProgressEvent {
  return event.type === 'video_task_progress'
}

export function isVideoCompletedEvent(event: AIEvent): event is VideoCompletedEvent {
  return event.type === 'video_completed'
}

export function isVideoTaskFailedEvent(event: AIEvent): event is VideoTaskFailedEvent {
  return event.type === 'video_task_failed'
}

/** 判断是否为任意 Video Generation 事件 */
export function isVideoGenerationEvent(event: AIEvent): event is VideoTaskCreatedEvent | VideoTaskProgressEvent | VideoCompletedEvent | VideoTaskFailedEvent {
  return event.type.startsWith('video_task') || event.type === 'video_completed'
}

// ========================================
// Pipeline 事件类型守卫
// ========================================

export function isPipelineStartEvent(event: AIEvent): event is PipelineStartEvent {
  return event.type === 'pipeline_start'
}

export function isPipelinePhaseEvent(event: AIEvent): event is PipelinePhaseEvent {
  return event.type === 'pipeline_phase'
}

export function isPipelineProgressEvent(event: AIEvent): event is PipelineProgressEvent {
  return event.type === 'pipeline_progress'
}

export function isPipelineCompletedEvent(event: AIEvent): event is PipelineCompletedEvent {
  return event.type === 'pipeline_completed'
}

export function isPipelineFailedEvent(event: AIEvent): event is PipelineFailedEvent {
  return event.type === 'pipeline_failed'
}

/** 判断是否为任意 Pipeline 事件 */
export function isPipelineEvent(event: AIEvent): event is PipelineStartEvent | PipelinePhaseEvent | PipelineProgressEvent | PipelineCompletedEvent | PipelineFailedEvent {
  return event.type.startsWith('pipeline_')
}
