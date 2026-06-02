/**
 * Agnes Image Adapter
 *
 * 处理图像生成请求（文生图 / 图生图），兼容 OpenAI Images API 格式。
 * 端点为 /v1/images/generations。
 */

import type { AIEvent } from '@/ai-runtime'
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

    const response = await fetch(`${config.baseUrl}/images/generations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }))
      throw new Error(error.error?.message || `Image API error: ${response.status}`)
    }

    yield {
      type: 'image_generation_progress',
      sessionId,
      taskId,
      progress: 70,
      message: '正在处理图像结果...',
    }

    const result: AgnesImageResponse = await response.json()

    if (!result.data?.length) {
      throw new Error('No image data returned from API')
    }

    // 发送每个生成图像的事件
    for (const imageData of result.data) {
      const imageUrl = imageData.url || imageData.b64_json
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
