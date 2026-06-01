/**
 * Agnes AI Engine — 类型定义
 *
 * 定义 Agnes 全模态引擎的专用类型，包括聊天、图像生成、视频生成和管线编排。
 */

// ========================================
// 基础配置
// ========================================

/** Agnes API 配置 */
export interface AgnesConfig {
  /** API Base URL */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 默认聊天模型 */
  chatModel: string
  /** 默认图像模型 */
  imageModel: string
  /** 默认视频模型 */
  videoModel: string
  /** 请求超时（毫秒） */
  timeout?: number
  /** 视频轮询间隔（毫秒） */
  videoPollInterval?: number
}

/** 默认配置 */
export const DEFAULT_AGNES_CONFIG: Partial<AgnesConfig> = {
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  chatModel: 'agnes-2.0-flash',
  imageModel: 'agnes-image-2.1-flash',
  videoModel: 'agnes-video-v2.0',
  timeout: 120000,
  videoPollInterval: 3000,
}

// ========================================
// 聊天相关类型（兼容 OpenAI 格式）
// ========================================

/** 消息角色 */
export type AgnesMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** 聊天消息 */
export interface AgnesMessage {
  role: AgnesMessageRole
  content: string | null
  tool_calls?: AgnesToolCall[]
  tool_call_id?: string
  name?: string
}

/** 工具调用 */
export interface AgnesToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** 工具定义 */
export interface AgnesTool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

// ========================================
// 图像生成类型
// ========================================

/** 图像生成请求 */
export interface AgnesImageRequest {
  model: string
  prompt: string
  size?: string
  /** 图生图模式下的额外参数 */
  extra_body?: {
    /** 输入图像 URL 列表（图生图） */
    image?: string[]
    /** 响应格式 */
    response_format?: 'url' | 'b64_json'
  }
}

/** 图像生成响应 */
export interface AgnesImageResponse {
  created: number
  data: Array<{
    url?: string
    b64_json?: string
    revised_prompt?: string
  }>
}

// ========================================
// 视频生成类型（异步任务模型）
// ========================================

/** 视频任务状态 */
export type AgnesVideoTaskStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/** 视频生成请求 */
export interface AgnesVideoRequest {
  model: string
  prompt: string
  /** 输入图像 URL（图生视频） */
  image?: string
  /** 视频宽度 */
  width?: number
  /** 视频高度 */
  height?: number
  /** 帧数（8n+1，≤441） */
  num_frames?: number
  /** 帧率 */
  frame_rate?: number
  /** 随机种子 */
  seed?: number
  /** 额外参数 */
  extra_body?: {
    /** 多图输入 */
    image?: string[]
    /** 关键帧模式 */
    mode?: 'keyframes'
  }
}

/** 视频任务创建响应 */
export interface AgnesVideoCreateResponse {
  id: string
  object: 'video'
  model: string
  status: AgnesVideoTaskStatus
  progress: number
  created_at: number
}

/** 视频任务查询响应 */
export interface AgnesVideoQueryResponse {
  id: string
  object: 'video'
  model: string
  status: AgnesVideoTaskStatus
  progress: number
  created_at: number
  completed_at?: number
  video_url?: string
  size?: string
  seconds?: string
  usage?: {
    duration_seconds: number
  }
  error?: string
}

// ========================================
// 会话配置
// ========================================

/** Agnes 会话配置 */
export interface AgnesSessionConfig {
  /** 系统提示词 */
  systemPrompt?: string
  /** 初始消息历史 */
  initialMessages?: AgnesMessage[]
  /** 可用工具 */
  tools?: AgnesTool[]
  /** 会话温度 */
  temperature?: number
  /** 最大 Token */
  maxTokens?: number
}
