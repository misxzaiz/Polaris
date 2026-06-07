/**
 * Agnes Video Adapter
 *
 * 处理视频生成请求（文生视频 / 图生视频 / 多图视频 / 关键帧动画）。
 * 采用异步任务模型：创建任务 → 轮询进度 → 获取结果。
 * 端点为 /v1/videos。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig, AgnesVideoRequest, AgnesVideoCreateResponse, AgnesVideoQueryResponse } from '../types'
import { validateNumFrames, VIDEO_FRAME_PRESETS } from '../config'
import { maybeTranslatePrompt } from './translate'
import { invoke } from '@/services/transport'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgnesVideo')

/** 视频适配器选项 */
export interface VideoAdapterOptions {
  /** 输入图像 URL（图生视频） */
  imageUrl?: string
  /** 多图输入（多图引导视频 / 关键帧） */
  imageUrls?: string[]
  /** 关键帧模式 */
  keyframeMode?: boolean
  /** 视频尺寸 */
  width?: number
  height?: number
  /** 帧数 */
  numFrames?: number
  /** 帧率 */
  frameRate?: number
  /** 随机种子 */
  seed?: number
}

/** 视频轮询配置 */
const POLL_CONFIG = {
  /** 最大轮询次数 */
  maxAttempts: 200,
  /** 最大等待时间（毫秒） */
  maxWaitTime: 600000, // 10 分钟
}

/**
 * 延迟等待。abort 时立即拒绝并清理 timer；正常 resolve 时移除 abort 监听，
 * 避免在轮询循环中反复 addEventListener 造成监听器累积。
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    // 用 holder 持有 timer，使 onAbort 无需前向引用 timer 即可清理它（规避 prefer-const / use-before-define）
    const handle: { timer?: ReturnType<typeof setTimeout> } = {}
    const onAbort = () => {
      if (handle.timer) clearTimeout(handle.timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    handle.timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 执行视频生成（异步任务 + 轮询）
 */
export async function* generateVideo(
  config: AgnesConfig,
  prompt: string,
  sessionId: string,
  taskId: string,
  options: VideoAdapterOptions = {},
  signal?: AbortSignal,
): AsyncIterable<AIEvent> {
  const pollInterval = config.videoPollInterval ?? 3000
  const numFrames = options.numFrames ?? VIDEO_FRAME_PRESETS.medium

  // 验证帧数
  const frameCheck = validateNumFrames(numFrames)
  const adjustedFrames = frameCheck.adjusted

  // 1. 创建视频任务
  yield {
    type: 'progress',
    sessionId,
    message: '正在创建视频生成任务...',
    percent: 5,
  }

  // 按需将非英文提示词翻译为英文（Agnes 视频对英文提示词更稳定）
  const finalPrompt = await maybeTranslatePrompt(config, prompt, signal)

  const createRequest: AgnesVideoRequest = {
    model: config.videoModel,
    prompt: finalPrompt,
    width: options.width ?? 1152,
    height: options.height ?? 768,
    num_frames: adjustedFrames,
    frame_rate: options.frameRate ?? 24,
  }

  if (options.seed) {
    createRequest.seed = options.seed
  }

  // 图生视频模式
  if (options.imageUrl) {
    createRequest.image = options.imageUrl
  }

  // 多图 / 关键帧模式
  if (options.imageUrls?.length) {
    createRequest.extra_body = {
      image: options.imageUrls,
    }
    if (options.keyframeMode) {
      createRequest.extra_body.mode = 'keyframes'
    }
  }

  // 提升到 try 外：abort/error 时 catch 仍能拿到真实 videoTaskId 以关联前端任务
  let videoTaskId = ''

  try {
    const taskResult = await invoke<AgnesVideoCreateResponse>('agnes_create_video', {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      body: createRequest,
    })
    videoTaskId = taskResult.id

    // 发送任务创建事件
    yield {
      type: 'video_task_created',
      sessionId,
      taskId,
      videoTaskId,
      status: 'queued',
      prompt,
    }

    log.info('Video task created', { videoTaskId, prompt: prompt.substring(0, 50) })

    // 2. 轮询任务进度
    let attempts = 0
    const startTime = Date.now()

    while (attempts < POLL_CONFIG.maxAttempts) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }

      if (Date.now() - startTime > POLL_CONFIG.maxWaitTime) {
        throw new Error('Video generation timed out after 10 minutes')
      }

      await delay(pollInterval, signal)
      attempts++

      // 经后端代理查询任务状态；404 由后端转为 { status: 'queued' } 继续轮询
      const queryResult = await invoke<AgnesVideoQueryResponse>('agnes_query_video', {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        videoTaskId,
      })

      // 发送进度事件
      yield {
        type: 'video_task_progress',
        sessionId,
        taskId,
        videoTaskId,
        progress: queryResult.progress,
        status: queryResult.status,
        message: queryResult.status === 'in_progress'
          ? `视频生成中... ${queryResult.progress}%`
          : `状态: ${queryResult.status}`,
      }

      // 任务完成 — 视频地址可能出现在 video_url / url / remixed_from_video_id 任一字段
      const resolvedVideoUrl =
        queryResult.video_url || queryResult.url || queryResult.remixed_from_video_id
      if (queryResult.status === 'completed' && resolvedVideoUrl) {
        yield {
          type: 'video_completed',
          sessionId,
          taskId,
          videoTaskId,
          videoUrl: resolvedVideoUrl,
          duration: queryResult.seconds ? parseFloat(queryResult.seconds) : undefined,
          size: queryResult.size,
          usage: queryResult.usage ? {
            durationSeconds: queryResult.usage.duration_seconds,
          } : undefined,
        }
        log.info('Video generation completed', { videoTaskId, url: resolvedVideoUrl })
        return
      }

      // 任务失败
      if (queryResult.status === 'failed') {
        const errorMsg = queryResult.error || 'Video generation failed'
        yield {
          type: 'video_task_failed',
          sessionId,
          taskId,
          videoTaskId,
          error: errorMsg,
        }
        throw new Error(errorMsg)
      }
    }

    throw new Error(`Video generation exceeded max polling attempts (${POLL_CONFIG.maxAttempts})`)
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      yield {
        type: 'video_task_failed',
        sessionId,
        taskId,
        videoTaskId,
        error: 'Task was aborted',
      }
      return
    }
    yield {
      type: 'video_task_failed',
      sessionId,
      taskId,
      videoTaskId,
      error: error instanceof Error ? error.message : 'Unknown error',
    }
    throw error
  }
}
