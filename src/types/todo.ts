/**
 * 待办事项类型定义
 *
 * 定义了 Todo 系统的所有数据结构和类型
 */

import type { AIEvent } from '../ai-runtime/event'

/**
 * 待办事项优先级
 */
export type TodoPriority = 'low' | 'normal' | 'high' | 'urgent'

/**
 * 待办事项状态
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

/**
 * 待办事项主接口
 */
export interface TodoItem {
  /** 唯一标识符 */
  id: string

  /** 待办内容描述（标题） */
  content: string

  /** 详细描述 */
  description?: string

  /** 当前状态 */
  status: TodoStatus

  /** 优先级 */
  priority: TodoPriority

  /** 标签（用于分类和筛选） */
  tags?: string[]

  /** 相关文件路径 */
  relatedFiles?: string[]

  /** 关联的 AI 会话 ID */
  sessionId?: string

  /** 工作区 ID（用于多工作区隔离，null 表示全局待办） */
  workspaceId?: string | null

  /** 子任务列表 */
  subtasks?: TodoSubtask[]

  /** 截止日期（ISO 8601 格式） */
  dueDate?: string

  /** 提醒时间（ISO 8601 格式） */
  reminderTime?: string

  /** 预估工作量（小时） */
  estimatedHours?: number

  /** 实际工作量（小时） */
  spentHours?: number

  /** 依赖的任务 */
  dependsOn?: string[]

  /** 阻塞当前任务的任务 ID 列表 */
  blockers?: string[]

  /** Git 上下文信息 */
  gitContext?: TodoGitContext

  /** 里程碑 ID */
  milestoneId?: string

  /** 复杂度标识 */
  complexity?: 'simple' | 'medium' | 'complex'

  /** 附件路径列表 */
  attachments?: string[]

  /** 创建时间 */
  createdAt: string

  /** 更新时间 */
  updatedAt: string

  /** 完成时间 */
  completedAt?: string

  /** 最后进度信息 */
  lastProgress?: string

  /** 最后错误信息 */
  lastError?: string
}

/**
 * Git 上下文信息
 */
export interface TodoGitContext {
  /** 关联的 Git 分支 */
  branch?: string

  /** 基准 commit（开始任务时的 commit） */
  baseCommit?: string

  /** 当前 commit（用于对比进度） */
  currentCommit?: string

  /** 关联的 PR URL */
  pullRequestUrl?: string

  /** 变更文件列表 */
  changedFiles?: string[]

  /** 变更统计 */
  changesStats?: {
    additions: number
    deletions: number
    files: number
  }
}

/**
 * 子任务接口
 */
export interface TodoSubtask {
  /** 子任务 ID */
  id: string

  /** 子任务内容 */
  title: string

  /** 是否完成 */
  completed: boolean

  /** 创建时间 */
  createdAt?: string
}

/**
 * 待办统计信息
 */
export interface TodoStats {
  /** 总数 */
  total: number

  /** 待处理数量 */
  pending: number

  /** 进行中数量 */
  inProgress: number

  /** 已完成数量 */
  completed: number

  /** 已取消数量 */
  cancelled: number

  /** 紧急待办数量 */
  urgent: number
}

/**
 * 待办上下文（用于注入 AI）
 */
export interface TodoContext {
  /** 当前活动待办 */
  activeTodos: TodoItem[]

  /** 最近完成的待办 */
  recentCompleted: TodoItem[]

  /** 统计信息 */
  totalStats: TodoStats
}

/**
 * 待办查询过滤器
 */
export interface TodoFilter {
  /** 状态筛选 */
  status?: TodoStatus | 'all'

  /** 优先级筛选 */
  priority?: TodoPriority

  /** 标签筛选 */
  tags?: string[]

  /** 关键词搜索 */
  search?: string

  /** 日期筛选 */
  dateFilter?: 'all' | 'overdue' | 'today' | 'week' | 'month'

  /** 工作区筛选 (null 表示全局待办) */
  workspaceId?: string | null

  /** 返回数量限制 */
  limit?: number

  /** 偏移量（分页） */
  offset?: number
}

/**
 * 创建时的子任务简化类型（只需要标题）
 */
export interface TodoCreateSubtask {
  /** 子任务标题 */
  title: string
}

/**
 * 待办创建参数
 */
export interface TodoCreateParams {
  /** 待办内容 */
  content: string

  /** 详细描述 */
  description?: string

  /** 优先级 */
  priority?: TodoPriority

  /** 标签 */
  tags?: string[]

  /** 相关文件 */
  relatedFiles?: string[]

  /** 截止日期 */
  dueDate?: string

  /** 预估工作量 */
  estimatedHours?: number

  /** 工作区 ID (null 表示全局待办) */
  workspaceId?: string | null

  /** 关联的 AI 会话 ID */
  sessionId?: string

  /** Git 上下文 */
  gitContext?: Partial<TodoGitContext>

  /** 子任务（创建时只需要提供标题） */
  subtasks?: TodoCreateSubtask[]
}

/**
 * 待办更新参数
 */
export interface TodoUpdateParams {
  /** 新内容 */
  content?: string

  /** 新详细描述 */
  description?: string

  /** 新状态 */
  status?: TodoStatus

  /** 新优先级 */
  priority?: TodoPriority

  /** 标签 */
  tags?: string[]

  /** 相关文件 */
  relatedFiles?: string[]

  /** 截止日期 */
  dueDate?: string

  /** 预估工作量 */
  estimatedHours?: number

  /** 实际工作量 */
  spentHours?: number

  /** 提醒时间 */
  reminderTime?: string

  /** 依赖的任务 */
  dependsOn?: string[]

  /** 关联的 AI 会话 ID */
  sessionId?: string

  /** Git 上下文 */
  gitContext?: Partial<TodoGitContext>

  /** 子任务 */
  subtasks?: TodoSubtask[]

  /** 最后进度信息 */
  lastProgress?: string

  /** 最后错误信息 */
  lastError?: string
}

/**
 * 待办执行选项
 */
export interface TodoExecutionOptions {
  /** 工作区目录 */
  workspaceDir: string

  /** 是否自动分解复杂待办 */
  autoBreakdown?: boolean

  /** 是否在执行前询问用户 */
  requireConfirmation?: boolean

  /** 执行时附加的系统提示词 */
  systemPrompt?: string
}

/**
 * 待办分解结果
 */
export interface TodoBreakdown {
  /** 子任务列表 */
  subtasks: Array<{
    content: string
    estimatedSteps: string[]
    relatedFiles: string[]
  }>

  /** 建议的执行顺序 */
  suggestedOrder: number[]
}

/**
 * 待办命令解析结果
 */
export interface ParsedTodoCommand {
  content: string
  priority?: TodoPriority
  tags?: string[]
  shouldCreate: boolean
}

/**
 * 待办模板
 * 用于快速创建常用的待办任务
 */
export interface TodoTemplate {
  /** 模板唯一标识 */
  id: string

  /** 模板名称 */
  name: string

  /** 模板描述 */
  description?: string

  /** 待办内容（支持变量占位符） */
  content: string

  /** 优先级 */
  priority?: TodoPriority

  /** 标签 */
  tags?: string[]

  /** 预估工时（小时） */
  estimatedHours?: number

  /** 预设子任务 */
  subtasks?: Array<{ title: string }>

  /** 模板图标 */
  icon?: string

  /** 创建时间 */
  createdAt: string

  /** 是否为内置模板 */
  builtin?: boolean
}

/**
 * 模板变量上下文
 * 用于填充模板中的变量占位符
 */
export interface TemplateVariableContext {
  /** 项目名称 */
  project?: string

  /** 功能名称 */
  feature?: string

  /** 文件名 */
  file?: string

  /** 组件名 */
  component?: string

  /** 自定义变量 */
  custom?: Record<string, string>
}

/**
 * 待办同步规则
 */
export interface TodoSyncRule {
  /** 监听的 AI 事件类型 */
  eventType: string

  /** 匹配条件函数 */
  condition: (event: AIEvent, todo: TodoItem) => boolean

  /** 状态转换函数 */
  transform: (event: AIEvent, todo: TodoItem) => Partial<TodoItem>
}

/**
 * Todo Store 状态接口
 */
export interface TodoState {
  /** 所有待办事项 */
  todos: TodoItem[]

  /** 当前选中的待办 ID */
  selectedTodoId: string | null

  /** 当前筛选器 */
  filter: TodoFilter

  /** 是否正在加载 */
  isLoading: boolean

  /** 错误信息 */
  error: string | null

  /** 查询缓存 */
  queryCache: Map<string, { result: TodoItem[]; timestamp: number }>

  /** 缓存过期时间(ms) */
  cacheExpiration: number

  /** 统计信息 */
  stats: TodoStats
}

/**
 * Todo Store 操作接口
 */
export interface TodoActions {
  /** 创建待办 */
  createTodo: (params: TodoCreateParams) => Promise<TodoItem>

  /** 批量创建待办 */
  batchCreateTodos: (paramsList: TodoCreateParams[]) => Promise<TodoItem[]>

  /** 更新待办 */
  updateTodo: (id: string, updates: TodoUpdateParams) => TodoItem | null

  /** 删除待办 */
  deleteTodo: (id: string) => boolean

  /** 获取所有待办 */
  getAllTodos: () => TodoItem[]

  /** 根据 ID 获取待办 */
  getTodoById: (id: string) => TodoItem | undefined

  /** 查询待办 */
  queryTodos: (filter: TodoFilter) => TodoItem[]

  /** 清空查询缓存 */
  clearQueryCache: () => void

  /** 批量更新状态 */
  batchUpdateStatus: (ids: string[], status: TodoStatus) => void

  /** 批量删除 */
  batchDelete: (ids: string[]) => void

  /** 清空已完成 */
  clearCompleted: () => void

  /** 合并待办列表（不触发事件） */
  mergeTodos: (todos: TodoItem[], options?: { skipEvents?: boolean }) => void

  /** 刷新统计 */
  refreshStats: () => void

  /** 修复损坏的待办数据 */
  repairCorruptedTodos: () => void

  /** 关联待办到会话 */
  linkToSession: (todoId: string, sessionId: string) => void

  /** 获取会话相关的待办 */
  getTodosBySession: (sessionId: string) => TodoItem[]

  /** 导出待办 */
  exportTodos: () => string

  /** 导入待办 */
  importTodos: (json: string) => void

  /** UI 操作 */
  setSelectedTodo: (id: string | null) => void

  setFilter: (filter: Partial<TodoFilter>) => void

  setSearchQuery: (query: string) => void

  /** 子任务操作 */
  addSubtask: (todoId: string, title: string) => void

  toggleSubtask: (todoId: string, subtaskId: string) => void

  deleteSubtask: (todoId: string, subtaskId: string) => void

  updateSubtask: (todoId: string, subtaskId: string, title: string) => void
}

/**
 * 完整的 Todo Store 接口
 */
export type TodoStore = TodoState & TodoActions
