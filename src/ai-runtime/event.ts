/**
 * AI Event - 通用事件模型
 *
 * 定义了 AI Engine 向 UI 层传递所有事件的标准格式。
 * UI / 日志 / Tool 面板只能消费 AIEvent，禁止直接消费 CLI 原始输出。
 */

/**
 * Token 事件 - 文本增量输出
 */
export interface TokenEvent {
  type: 'token'
  /** 文本内容 */
  value: string
}

/**
 * 思考过程事件
 */
export interface ThinkingEvent {
  type: 'thinking'
  /** 思考内容 */
  content: string
}

/**
 * 工具调用开始事件
 */
export interface ToolCallStartEvent {
  type: 'tool_call_start'
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
  /** 任务输出结果 */
  output: unknown
}

/**
 * 错误事件 - 任务出错
 */
export interface ErrorEvent {
  type: 'error'
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
  /** 任务 ID */
  taskId: string
  /** 取消原因 */
  reason?: string
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
 * 问题已回答事件
 */
export interface QuestionAnsweredEvent {
  type: 'question_answered'
  /** 会话 ID */
  sessionId: string
  /** 问题 ID（tool_call 的 callId） */
  callId: string
  /** 用户答案 */
  answer: QuestionAnswerData
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
  | TodoCreatedEvent
  | TodoUpdatedEvent
  | TodoDeletedEvent
  | TodoExecutionStartedEvent
  | TodoExecutionProgressEvent
  | TodoExecutionCompletedEvent
  | QuestionAnsweredEvent
  | PlanStartEvent
  | PlanContentEvent
  | PlanStageUpdateEvent
  | PlanApprovalRequestEvent
  | PlanApprovalResultEvent
  | PlanEndEvent
  | PermissionRequestEvent

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
export function createTokenEvent(value: string): TokenEvent {
  return { type: 'token', value }
}

/**
 * 创建思考过程事件
 */
export function createThinkingEvent(content: string): ThinkingEvent {
  return { type: 'thinking', content }
}

/**
 * 创建工具调用开始事件
 */
export function createToolCallStartEvent(
  tool: string,
  args: Record<string, unknown>
): ToolCallStartEvent {
  return { type: 'tool_call_start', tool, args }
}

/**
 * 创建工具调用结束事件
 */
export function createToolCallEndEvent(
  tool: string,
  result?: unknown,
  success = true
): ToolCallEndEvent {
  return { type: 'tool_call_end', tool, result, success }
}

/**
 * 创建进度事件
 */
export function createProgressEvent(
  message?: string,
  percent?: number
): ProgressEvent {
  return { type: 'progress', message, percent }
}

/**
 * 创建错误事件
 */
export function createErrorEvent(
  error: string,
  code?: string
): ErrorEvent {
  return { type: 'error', error, code }
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
  content: string,
  files?: string[]
): UserMessageEvent {
  return { type: 'user_message', content, files }
}

/**
 * 创建 AI 消息事件
 */
export function createAssistantMessageEvent(
  content: string,
  isDelta = false,
  toolCalls?: ToolCallInfo[]
): AssistantMessageEvent {
  return { type: 'assistant_message', content, isDelta, toolCalls }
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
  taskId: string,
  status: TaskStatus,
  metadata?: Partial<Omit<TaskMetadataEvent, 'type' | 'taskId' | 'status'>>
): TaskMetadataEvent {
  return { type: 'task_metadata', taskId, status, ...metadata }
}

/**
 * 创建 Task 进度事件
 */
export function createTaskProgressEvent(
  taskId: string,
  message?: string,
  percent?: number
): TaskProgressEvent {
  return { type: 'task_progress', taskId, message, percent }
}

/**
 * 创建 Task 完成事件
 */
export function createTaskCompletedEvent(
  taskId: string,
  status: Exclude<TaskStatus, 'pending' | 'running'>,
  duration?: number,
  error?: string
): TaskCompletedEvent {
  return { type: 'task_completed', taskId, status, duration, error }
}

/**
 * 创建 Task 取消事件
 */
export function createTaskCanceledEvent(
  taskId: string,
  reason?: string
): TaskCanceledEvent {
  return { type: 'task_canceled', taskId, reason }
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
  'todo_created',
  'todo_updated',
  'todo_deleted',
  'todo_execution_started',
  'todo_execution_progress',
  'todo_execution_completed',
  'question_answered',
  'plan_start',
  'plan_content',
  'plan_stage_update',
  'plan_approval_request',
  'plan_approval_result',
  'plan_end',
  'permission_request',
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
