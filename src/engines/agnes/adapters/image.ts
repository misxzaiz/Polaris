/**
 * Agnes Image Adapter
 *
 * 处理图像生成请求（文生图 / 图生图），兼容 OpenAI Images API 格式。
 * 端点为 /v1/images/generations。
 */

import type { AIEvent } from '@/ai-runtime'
import { invoke } from '@/services/transport'
import type { AgnesConfig, AgnesImageRequest, AgnesImageResponse } from '../types'
import { maybeTranslatePrompt } from './translate'

/** 图像适配器选项 */
export interface ImageAdapterOptions {
  /** 是否为图生图模式 */
  isImageEdit?: boolean
  /** 参考图像 URL（图生图） */
  referenceImageUrls?: string[]
  /** 输出图像尺寸（如 1024x768 / 768x1024 / 1024x1024），默认 1024x768 */
  size?: string
}

/**
 * 将单条图像数据解析为可直接用于 `<img src>` 的地址。
 * - `url`：直接返回
 * - `b64_json`：裸 base64（无 data URI 前缀），包装为 data URL（默认 image/png）
 * - 两者皆无：返回 undefined（调用方跳过）
 *
 * 部分图像模型（如 gpt-image-1 系）只返回 b64_json，且文生图请求未强制
 * response_format；旧代码直接把裸 base64 当 imageUrl 会导致内联图像裂图。
 */
export function resolveImageDataUrl(imageData: { url?: string; b64_json?: string }): string | undefined {
  if (imageData.url) return imageData.url
  if (imageData.b64_json) return `data:image/png;base64,${imageData.b64_json}`
  return undefined
}

/**
 * 执行图像生成
 */
export async function* generateImage(
  config: AgnesConfig,
  prompt: string,
  sessionId: string,
  taskId: string,
  options: ImageAdapterOptions = {},
): AsyncIterable<AIEvent> {
  // 发送开始事件
  yield {
    type: 'image_generation_start',
    sessionId,
    taskId,
    prompt,
    isImageEdit: options.isImageEdit,
  }

  yield {
    type: 'image_generation_progress',
    sessionId,
    taskId,
    progress: 10,
    message: '正在连接 Agnes Image API...',
  }

  try {
    // 按需将非英文提示词翻译为英文（提升生成质量与稳定性）
    const finalPrompt = await maybeTranslatePrompt(config, prompt)

    const request: AgnesImageRequest = {
      model: config.imageModel,
      prompt: finalPrompt,
      size: options.size || '1024x768',
    }

    // 图生图模式
    if (options.isImageEdit && options.referenceImageUrls?.length) {
      request.extra_body = {
        image: options.referenceImageUrls,
        response_format: 'url',
      }
    }

    yield {
      type: 'image_generation_progress',
      sessionId,
      taskId,
      progress: 40,
      message: '正在生成图像...',
    }

    // 通过 Rust 后端代理图像生成请求，规避浏览器 CORS（dev/打包态行为一致）
    const result = await invoke<AgnesImageResponse>('agnes_generate_image', {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.imageModel,
      prompt: finalPrompt,
      size: request.size,
      referenceImageUrls:
        options.isImageEdit && options.referenceImageUrls?.length
          ? options.referenceImageUrls
          : undefined,
    })

    yield {
      type: 'image_generation_progress',
      sessionId,
      taskId,
      progress: 70,
      message: '正在处理图像结果...',
    }

    if (!result.data?.length) {
      throw new Error('No image data returned from API')
    }

    // 发送每个生成图像的事件
    for (const imageData of result.data) {
      const imageUrl = resolveImageDataUrl(imageData)
      if (!imageUrl) continue

      yield {
        type: 'image_generated',
        sessionId,
        taskId,
        imageUrl,
        prompt,
        size: request.size,
        metadata: {
          model: config.imageModel,
          revisedPrompt: imageData.revised_prompt,
        },
      }
    }
  } catch (error) {
    yield {
      type: 'image_generation_error',
      sessionId,
      taskId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    throw error
  }
}
