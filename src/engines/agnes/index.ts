/**
 * Agnes AI Engine — 全模态引擎
 *
 * 支持聊天、图像生成、图像编辑、视频生成、图生视频。
 * 通过 OpenAI 兼容 API 格式与 Agnes AI 平台通信。
 *
 * @module engines/agnes
 */

export { AgnesMultiModalEngine } from './engine'
export { AgnesMultiModalSession } from './session'

// 类型导出
export type {
  AgnesConfig,
  AgnesMessage,
  AgnesMessageRole,
  AgnesTool,
  AgnesToolCall,
  AgnesImageRequest,
  AgnesImageResponse,
  AgnesVideoRequest,
  AgnesVideoCreateResponse,
  AgnesVideoQueryResponse,
  AgnesVideoTaskStatus,
  AgnesSessionConfig,
} from './types'

export { DEFAULT_AGNES_CONFIG } from './types'

// 配置工具
export {
  validateAgnesConfig,
  mergeAgnesConfig,
  isAgnesConfigComplete,
  validateNumFrames,
  VIDEO_FRAME_PRESETS,
} from './config'
export type { ConfigValidationResult } from './config'

// 适配器（高级用户可直接使用）
export {
  streamChatCompletion,
  generateImage,
  generateVideo,
} from './adapters'
export type { ImageAdapterOptions, VideoAdapterOptions } from './adapters'
