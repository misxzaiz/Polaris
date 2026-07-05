/**
 * Agnes 插件前端 API。
 *
 * 面板自身直接调用 Tauri command（src-tauri/src/commands/agnes.rs），
 * 与 MCP server（供 AI agent 调用）共享 `<appConfigDir>/agnes/config.json`。
 */

import { invoke } from '@/services/transport'

// ============================================================================
// 类型
// ============================================================================

export interface AgnesConfigView {
  apiBase: string
  imageModel: string
  videoModel: string
  defaultSize: string
  hasApiKey: boolean
  apiKeyMasked: string
}

export interface AgnesImageResult {
  url: string | null
  base64: string | null
  mimeType: string | null
  revisedPrompt: string | null
  size: string
  model: string
}

export interface AgnesVideoTask {
  videoId: string
  taskId: string | null
  status: string // queued | in_progress | completed | failed | unknown
  progress: number
  seconds: string | null
  size: string | null
  url: string | null
  error: string | null
  framesNormalized: boolean | null
}

// ============================================================================
// 配置
// ============================================================================

export function agnesGetConfig(): Promise<AgnesConfigView> {
  return invoke<AgnesConfigView>('agnes_get_config')
}

export interface AgnesSaveConfigInput {
  apiKey?: string
  apiBase?: string
  imageModel?: string
  videoModel?: string
  defaultSize?: string
}

export function agnesSaveConfig(input: AgnesSaveConfigInput): Promise<AgnesConfigView> {
  return invoke<AgnesConfigView>('agnes_save_config', input)
}

// ============================================================================
// 生图
// ============================================================================

export interface AgnesGenerateImageInput {
  prompt: string
  size?: string
  images?: string[]
  responseFormat?: 'url' | 'b64_json'
}

export function agnesGenerateImage(input: AgnesGenerateImageInput): Promise<AgnesImageResult> {
  return invoke<AgnesImageResult>('agnes_generate_image', input)
}

// ============================================================================
// 生视频
// ============================================================================

export interface AgnesCreateVideoInput {
  prompt: string
  width?: number
  height?: number
  numFrames?: number
  frameRate?: number
  image?: string
  images?: string[]
  mode?: 'ti2vid' | 'keyframes'
  seed?: number
  negativePrompt?: string
  numInferenceSteps?: number
}

export function agnesCreateVideo(input: AgnesCreateVideoInput): Promise<AgnesVideoTask> {
  return invoke<AgnesVideoTask>('agnes_create_video', input)
}

export function agnesQueryVideo(videoId: string): Promise<AgnesVideoTask> {
  return invoke<AgnesVideoTask>('agnes_query_video', { videoId })
}

// ============================================================================
// 工具
// ============================================================================

/** 把 base64 图片数据转为 data URL 供 <img> 直接渲染。 */
export function toDataUrl(base64: string, mimeType = 'image/png'): string {
  if (base64.startsWith('data:')) return base64
  return `data:${mimeType};base64,${base64}`
}

/** 帧数合法档位（8n+1, ≤441）。 */
export const FRAME_PRESETS: { label: string; frames: number; rate: number; seconds: string }[] = [
  { label: '约 3 秒', frames: 81, rate: 24, seconds: '3.4' },
  { label: '约 5 秒', frames: 121, rate: 24, seconds: '5.0' },
  { label: '约 10 秒', frames: 241, rate: 24, seconds: '10.0' },
  { label: '约 18 秒', frames: 441, rate: 24, seconds: '18.4' },
]

/** 常用图片尺寸预设。 */
export const IMAGE_SIZE_PRESETS = [
  '1024x1024',
  '1024x768',
  '768x1024',
  '1280x768',
  '768x1280',
]

/** 把本地 File 转 data URL（用于图生图/图生视频上传）。 */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
