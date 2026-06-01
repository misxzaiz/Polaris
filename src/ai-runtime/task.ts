import { generateUUID } from '@/utils/uuid';
/**
 * AI Task - 通用任务模型
 *
 * 定义了所有 AI Engine 必须支持的任务格式。
 * UI 层通过 AITask 向 AI Engine 提交任务请求。
 */

/**
 * 工作区信息
 */
export interface WorkspaceInfo {
  /** 工作区名称 */
  name: string
  /** 工作区路径 */
  path: string
  /** 引用语法（如 @/path 或 @workspace:path） */
  referenceSyntax: string
}

/**
 * 工作区上下文（用于 AITaskInput.extra）
 *
 * 包含当前工作区和所有关联工作区的信息
 */
export interface WorkspaceContextExtra {
  /** 当前工作区 */
  currentWorkspace: WorkspaceInfo
  /** 关联的工作区列表 */
  contextWorkspaces: WorkspaceInfo[]
}

/**
 * 任务类型
 */
export type AITaskKind =
  | 'chat'
  | 'refactor'
  | 'analyze'
  | 'generate'
  // 多模态任务类型
  | 'image_generate'    // 文生图
  | 'image_edit'        // 图生图/图片编辑
  | 'video_generate'    // 文生视频
  | 'image_to_video'    // 图生视频
  | 'comic_generate'    // 漫画/漫剧管线生成

/**
 * 任务输入
 */
export interface AITaskInput {
  /** 用户提示词 */
  prompt: string
  /** 关联的文件列表（路径） */
  files?: string[]
  /** 额外参数，不同 Engine 可自定义 */
  extra?: Record<string, unknown>
}

/**
 * AI 任务
 *
 * 这是 AI Runtime 的通用任务模型，所有 Engine 都必须能处理此格式。
 * 禁止在此出现 Claude / CLI / Tool 等具体实现名称。
 */
export interface AITask {
  /** 任务唯一标识 */
  id: string
  /** 任务类型 */
  kind: AITaskKind
  /** 任务输入 */
  input: AITaskInput
  /** 指定执行的 Engine ID（可选，不传则使用默认 Engine） */
  engineId?: string
}

/**
 * 创建任务时的选项
 */
export interface CreateTaskOptions {
  /** 任务 ID（可选，不传则自动生成） */
  id?: string
  /** 指定执行的 Engine ID（可选，不传则使用默认 Engine） */
  engineId?: string
}

/**
 * 创建新的 AI 任务
 */
export function createTask(
  kind: AITaskKind,
  input: AITaskInput,
  options?: CreateTaskOptions
): AITask {
  return {
    id: options?.id || generateUUID(),
    kind,
    input,
    engineId: options?.engineId,
  }
}

/**
 * 任务状态
 */
export type AITaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

/**
 * 任务元数据
 */
export interface AITaskMetadata {
  /** 任务 ID */
  taskId: string
  /** 所属会话 ID */
  sessionId: string
  /** 任务状态 */
  status: AITaskStatus
  /** 开始时间 */
  startTime?: number
  /** 结束时间 */
  endTime?: number
  /** 错误信息（失败时） */
  error?: string
}
