/**
 * 需求队列类型定义
 *
 * 定义了需求生成、审核、执行的全生命周期数据结构
 * 数据存储于 {workspace}/.polaris/requirements/requirements.json
 */

/** 需求状态 */
export type RequirementStatus = 'draft' | 'pending' | 'approved' | 'rejected' | 'executing' | 'completed' | 'failed'

/** 需求优先级 */
export type RequirementPriority = 'low' | 'normal' | 'high' | 'urgent'

/** 需求生成来源 */
export type RequirementSource = 'ai' | 'user'

/** 需求执行配置 */
export interface RequirementExecuteConfig {
  /** 定时执行时间（Unix 时间戳，毫秒） */
  scheduledAt?: number
  /** 执行使用的引擎 ID */
  engineId?: string
  /** 工作目录 */
  workDir?: string
}

/** 需求项 */
export interface Requirement {
  /** 唯一标识（UUID） */
  id: string
  /** 需求标题 */
  title: string
  /** 需求详细描述 */
  description: string
  /** 当前状态 */
  status: RequirementStatus
  /** 优先级 */
  priority: RequirementPriority
  /** 标签（用于分类和筛选） */
  tags: string[]
  /** 原型 HTML 文件路径（相对于工作区） */
  prototypePath?: string
  /** 是否包含原型 */
  hasPrototype: boolean

  // 生成相关
  /** 生成来源 */
  generatedBy: RequirementSource
  /** 生成时间（Unix 时间戳，毫秒） */
  generatedAt: number
  /** 生成该需求的定时任务 ID */
  generatorTaskId?: string

  // 审核相关
  /** 审核时间（Unix 时间戳，毫秒） */
  reviewedAt?: number
  /** 审核备注 */
  reviewNote?: string

  // 执行相关
  /** 执行配置 */
  executeConfig?: RequirementExecuteConfig
  /** 执行日志 */
  executeLog?: string
  /** 开始执行时间（Unix 时间戳，毫秒） */
  executedAt?: number
  /** 完成时间（Unix 时间戳，毫秒） */
  completedAt?: number
  /** 执行使用的 AI 会话 ID */
  sessionId?: string
  /** 执行失败错误信息 */
  executeError?: string

  /** 创建时间（Unix 时间戳，毫秒） */
  createdAt: number
  /** 更新时间（Unix 时间戳，毫秒） */
  updatedAt: number
}

/** 需求查询过滤器 */
export interface RequirementFilter {
  /** 状态筛选 */
  status?: RequirementStatus | 'all'
  /** 优先级筛选 */
  priority?: RequirementPriority
  /** 标签筛选 */
  tags?: string[]
  /** 关键词搜索 */
  search?: string
  /** 生成来源筛选 */
  source?: RequirementSource | 'all'
  /** 是否有原型 */
  hasPrototype?: boolean
  /** 返回数量限制 */
  limit?: number
  /** 偏移量（分页） */
  offset?: number
}

/** 创建需求参数 */
export interface RequirementCreateParams {
  /** 需求标题 */
  title: string
  /** 需求详细描述 */
  description: string
  /** 优先级 */
  priority?: RequirementPriority
  /** 标签 */
  tags?: string[]
  /** 是否生成原型 */
  hasPrototype?: boolean
  /** 生成来源 */
  generatedBy?: RequirementSource
  /** 生成该需求的定时任务 ID */
  generatorTaskId?: string
}

/** 更新需求参数 */
export interface RequirementUpdateParams {
  /** 新标题 */
  title?: string
  /** 新描述 */
  description?: string
  /** 新状态 */
  status?: RequirementStatus
  /** 新优先级 */
  priority?: RequirementPriority
  /** 新标签 */
  tags?: string[]
  /** 原型文件路径 */
  prototypePath?: string
  /** 是否包含原型 */
  hasPrototype?: boolean
  /** 审核备注 */
  reviewNote?: string
  /** 执行配置 */
  executeConfig?: RequirementExecuteConfig
  /** 执行日志 */
  executeLog?: string
  /** 执行失败错误信息 */
  executeError?: string
  /** 来源 */
  generatedBy?: RequirementSource
}

/** 需求统计信息 */
export interface RequirementStats {
  /** 总数 */
  total: number
  /** 草稿数量 */
  draft: number
  /** 待审核数量 */
  pending: number
  /** 已批准数量（含执行中） */
  approved: number
  /** 已拒绝数量 */
  rejected: number
  /** 执行中数量 */
  executing: number
  /** 已完成数量 */
  completed: number
  /** 失败数量 */
  failed: number
}

/** 需求文件数据结构（JSON 根对象） */
export interface RequirementFileData {
  /** 数据版本 */
  version: string
  /** 最后更新时间（ISO 8601） */
  updatedAt: string
  /** 需求列表 */
  requirements: Requirement[]
}

/** 需求状态显示名称 */
export const RequirementStatusLabels: Record<RequirementStatus, string> = {
  draft: '草稿',
  pending: '待审核',
  approved: '已批准',
  rejected: '已拒绝',
  executing: '执行中',
  completed: '已完成',
  failed: '执行失败',
}

/** 需求优先级显示名称 */
export const RequirementPriorityLabels: Record<RequirementPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
}

/** 需求来源显示名称 */
export const RequirementSourceLabels: Record<RequirementSource, string> = {
  ai: 'AI 生成',
  user: '手动创建',
}

/** 允许 AI 读取的需求状态 */
export const AI_READABLE_STATUSES: RequirementStatus[] = [
  'pending', 'approved', 'executing',
]

/** 允许从队列执行的需求状态 */
export const EXECUTABLE_STATUSES: RequirementStatus[] = ['approved']

/**
 * 创建默认需求（自动填充 ID 和时间戳）
 */
export function createDefaultRequirement(params: RequirementCreateParams): Requirement {
  const now = Date.now()
  return {
    id: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    status: params.generatedBy === 'ai' ? 'pending' : 'draft',
    priority: params.priority || 'normal',
    tags: params.tags || [],
    hasPrototype: params.hasPrototype || false,
    generatedBy: params.generatedBy || 'user',
    generatedAt: now,
    generatorTaskId: params.generatorTaskId,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 计算需求统计信息
 */
export function computeRequirementStats(requirements: Requirement[]): RequirementStats {
  return {
    total: requirements.length,
    draft: requirements.filter(r => r.status === 'draft').length,
    pending: requirements.filter(r => r.status === 'pending').length,
    approved: requirements.filter(r => r.status === 'approved').length,
    rejected: requirements.filter(r => r.status === 'rejected').length,
    executing: requirements.filter(r => r.status === 'executing').length,
    completed: requirements.filter(r => r.status === 'completed').length,
    failed: requirements.filter(r => r.status === 'failed').length,
  }
}
