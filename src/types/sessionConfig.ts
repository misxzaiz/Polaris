/**
 * 会话配置相关类型定义
 *
 * 用于 CLI Agent/Model/Effort/PermissionMode 选择
 */

/**
 * CLI Agent 类型
 *
 * Agent 是 CLI 预设的"角色"，每个角色有不同的模型和人格配置
 */
export interface CLIAgent {
  /** Agent ID */
  id: string
  /** Agent 显示名称 */
  name: string
  /** Agent 描述 */
  description?: string
  /** 默认模型 */
  defaultModel?: string
  /** Agent 类型标签 */
  tags?: string[]
}

/**
 * CLI 模型类型
 */
export interface CLIModel {
  /** 模型 ID */
  id: string
  /** 模型显示名称 */
  name: string
  /** 模型描述 */
  description?: string
  /** 是否支持流式输出 */
  supportsStreaming?: boolean
  /** 上下文窗口大小 */
  contextWindow?: number
  /** 是否为默认模型 */
  isDefault?: boolean
}

/**
 * 努力级别
 *
 * 控制模型在回答时投入的努力程度
 */
export type EffortLevel = 'low' | 'medium' | 'high'

/**
 * 权限模式
 *
 * 控制如何处理敏感操作
 * - default: 需要确认敏感操作（默认）
 * - auto: 自动批准安全操作
 * - plan: 仅规划不执行
 * - acceptEdits: 自动接受编辑
 * - dontAsk: 拒绝危险操作
 * - bypassPermissions: 跳过所有检查
 */
export type PermissionMode =
  | ''
  | 'default'
  | 'auto'
  | 'plan'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'

/**
 * 会话运行时配置
 *
 * 这些配置影响 CLI 的行为，在会话级别生效
 */
export interface SessionRuntimeConfig {
  /** 选择的 Agent */
  agent?: string
  /** 选择的模型 */
  model?: string
  /** 努力级别 */
  effort?: EffortLevel
  /** 权限模式 */
  permissionMode?: PermissionMode
}

/**
 * 会话配置默认值
 */
export const DEFAULT_SESSION_CONFIG: Required<SessionRuntimeConfig> = {
  agent: '',
  model: 'sonnet',
  effort: 'medium',
  permissionMode: '',
}

/**
 * 预设 Agent 列表
 *
 * Claude CLI 内置的 Agent 类型
 */
export const PRESET_AGENTS: CLIAgent[] = [
  {
    id: '',
    name: '通用',
    description: '默认通用助手',
    defaultModel: 'sonnet',
    tags: ['general'],
  },
  {
    id: 'Explore',
    name: '探索',
    description: '快速探索代码库，查找文件和代码模式',
    defaultModel: 'haiku',
    tags: ['explore', 'search'],
  },
  {
    id: 'Plan',
    name: '规划',
    description: '架构设计，规划实现方案',
    defaultModel: 'sonnet',
    tags: ['plan', 'architect'],
  },
  {
    id: 'code-reviewer',
    name: '代码审查',
    description: '代码审查，检查代码质量和最佳实践',
    defaultModel: 'sonnet',
    tags: ['review', 'quality'],
  },
]

/**
 * 预设模型列表
 */
export const PRESET_MODELS: CLIModel[] = [
  {
    id: 'sonnet',
    name: 'Sonnet',
    description: '平衡性能和速度，适合大多数任务',
    isDefault: true,
    supportsStreaming: true,
    contextWindow: 200000,
  },
  {
    id: 'opus',
    name: 'Opus',
    description: '最强性能，适合复杂推理任务',
    supportsStreaming: true,
    contextWindow: 200000,
  },
  {
    id: 'haiku',
    name: 'Haiku',
    description: '快速响应，适合简单任务',
    supportsStreaming: true,
    contextWindow: 200000,
  },
]

/**
 * 努力级别选项
 */
export const EFFORT_OPTIONS: Array<{ value: EffortLevel; label: string; description: string }> = [
  {
    value: 'low',
    label: '低',
    description: '快速响应，适合简单问题',
  },
  {
    value: 'medium',
    label: '中',
    description: '平衡速度和质量',
  },
  {
    value: 'high',
    label: '高',
    description: '深入思考，适合复杂问题',
  },
]

/**
 * 权限模式选项
 */
export const PERMISSION_MODE_OPTIONS: Array<{ value: PermissionMode | ''; label: string; description: string }> = [
  {
    value: '',
    label: '无限制',
    description: '跳过所有权限检查（默认）',
  },
  {
    value: 'default',
    label: '默认',
    description: '敏感操作需要确认',
  },
  {
    value: 'auto',
    label: '自动',
    description: '安全操作自动批准',
  },
  {
    value: 'acceptEdits',
    label: '接受编辑',
    description: '自动接受文件编辑',
  },
  {
    value: 'plan',
    label: '规划',
    description: '仅规划不执行',
  },
  {
    value: 'dontAsk',
    label: '拒绝危险',
    description: '拒绝危险操作',
  },
  {
    value: 'bypassPermissions',
    label: '跳过权限',
    description: '跳过所有权限检查',
  },
]
