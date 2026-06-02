/**
 * useComicPipeline — 漫画/漫剧管线执行 Hook
 *
 * 桥接 ComicStudioPanel UI 与 Agnes 引擎的 ComicPipelineSession。
 * 负责：懒注册引擎（如未注册）、创建管线会话、启动执行、将事件流转发到 ComicStudio Store。
 */

import { useCallback } from 'react'
import { getEngineRegistry } from '@/ai-runtime'
import type { AITask } from '@/ai-runtime'
import { AgnesMultiModalEngine } from '@/engines/agnes'
import { ComicPipelineSession } from '@/engines/agnes/comic-pipeline'
import { registerEngineLazy } from '@/core/engine-bootstrap'
import { useComicStudioStore } from '@/stores/comicStudioStore'
import { useConfigStore } from '@/stores'
import type { ComicPipelineConfig } from '@/engines/agnes/comic-pipeline'
import { createLogger } from '@/utils/logger'

const log = createLogger('useComicPipeline')

/** 引擎未注册 / API Key 缺失时抛出的错误 */
export class AgnesEngineNotAvailableError extends Error {
  constructor(reason: 'no_key' | 'register_failed') {
    const messages = {
      no_key: 'Agnes API Key 未配置。请在 设置 → AI 引擎 → Agnes AI 全模态 中输入你的 API Key 后重试。',
      register_failed: 'Agnes 引擎注册失败，请检查 API Key 是否正确。',
    }
    super(messages[reason])
    this.name = 'AgnesEngineNotAvailableError'
  }
}

export function useComicPipeline() {
  const storyIdea = useComicStudioStore((s) => s.storyIdea)
  const config = useComicStudioStore((s) => s.config)
  const startPipeline = useComicStudioStore((s) => s.startPipeline)
  const updatePhase = useComicStudioStore((s) => s.updatePhase)
  const updateProgress = useComicStudioStore((s) => s.updateProgress)
  const completePipeline = useComicStudioStore((s) => s.completePipeline)
  const failPipeline = useComicStudioStore((s) => s.failPipeline)
  const setScript = useComicStudioStore((s) => s.setScript)
  const addCharacterDesign = useComicStudioStore((s) => s.addCharacterDesign)
  const addStoryboard = useComicStudioStore((s) => s.addStoryboard)
  const addAnimationClip = useComicStudioStore((s) => s.addAnimationClip)

  /** 确保 Agnes 引擎已注册（运行时懒注册） */
  const ensureEngine = useCallback(async (): Promise<AgnesMultiModalEngine> => {
    const registry = getEngineRegistry()
    let engine = registry.get('agnes')

    if (engine instanceof AgnesMultiModalEngine) {
      return engine
    }

    // 引擎未注册，尝试从 config 读取 API Key 进行懒注册
    const appConfig = useConfigStore.getState().config
    const apiKey = appConfig?.agnesApiKey

    if (!apiKey) {
      throw new AgnesEngineNotAvailableError('no_key')
    }

    log.info('Lazy-registering Agnes engine from stored config')
    await registerEngineLazy('agnes', { apiKey })

    engine = registry.get('agnes')
    if (!(engine instanceof AgnesMultiModalEngine)) {
      throw new AgnesEngineNotAvailableError('register_failed')
    }

    return engine
  }, [])

  const run = useCallback(async () => {
    if (!storyIdea.trim()) {
      log.warn('No story idea provided')
      return
    }

    let engine: AgnesMultiModalEngine
    try {
      engine = await ensureEngine()
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error(errorMsg)
      // 将错误信息传递到管线状态中展示给用户
      startPipeline('', '')
      failPipeline(errorMsg, 'script')
      return
    }

    const sessionId = `comic-${Date.now()}`
    const taskId = `task-${Date.now()}`

    // 初始化管线 store
    startPipeline(sessionId, taskId)

    // 构建管线配置
    const pipelineConfig: Partial<ComicPipelineConfig> = {
      comicStyle: config.comicStyle,
      pageLayout: config.pageLayout,
      panelsPerPage: config.panelsPerPage,
      outputFormat: config.outputFormat,
      includeAnimation: config.includeAnimation,
    }

    // 创建管线会话
    const agnesConfig = engine.getConfig()
    const session = new ComicPipelineSession(sessionId, agnesConfig, pipelineConfig)

    const task: AITask = {
      id: taskId,
      kind: 'comic_generate',
      input: {
        prompt: storyIdea,
      },
    }

    try {
      log.info('Starting comic pipeline', { sessionId, taskId, storyIdea: storyIdea.substring(0, 60) })

      for await (const event of session.run(task)) {
        switch (event.type) {
          case 'pipeline_start':
            log.info('Pipeline started', { phases: event.phases.length })
            break

          case 'pipeline_phase':
            updatePhase(event.phase)
            break

          case 'pipeline_progress':
            updateProgress(
              event.overallProgress,
              event.currentPhase,
              event.message,
            )
            break

          case 'pipeline_completed':
            completePipeline(
              event.artifacts.map((a) => ({
                type: a.type,
                label: a.label,
                url: a.url,
              }))
            )
            log.info('Pipeline completed', { artifactCount: event.artifacts.length })
            break

          case 'pipeline_failed':
            failPipeline(event.error, event.failedPhase)
            log.error(`Pipeline failed: ${event.error} (phase: ${event.failedPhase})`)
            break

          case 'image_generated':
            // 管线中间产物：记录图像（可能来自角色设计或分镜）
            log.info('Image generated during pipeline', { url: event.imageUrl.substring(0, 40) })
            break

          case 'video_completed':
            // 管线中间产物：记录视频
            log.info('Video completed during pipeline', { url: event.videoUrl.substring(0, 40) })
            break

          case 'video_task_progress':
          case 'image_generation_progress':
          case 'progress':
          case 'assistant_message':
            // 进度事件由 pipeline_phase/pipeline_progress 处理
            break

          case 'error':
            log.error(`Pipeline error event: ${event.error}`)
            break

          case 'session_end':
            log.info('Pipeline session ended')
            break

          default:
            // 其他事件忽略
            break
        }
      }

      // 管线结束后提取产物并回填到 ComicStudio Store
      // 阶段产物在 ComicPipelineSession 内部已通过 yield* 返回值收集，
      // 这里统一回填，确保角色画廊 / 分镜网格 / 动画播放器有数据展示。
      const results = session.getResults()
      if (results.script) {
        setScript(results.script)
      }
      for (const design of results.characterDesigns) {
        addCharacterDesign(design)
      }
      for (const panel of results.storyboards) {
        addStoryboard(panel)
      }
      for (const clip of results.animationClips) {
        addAnimationClip(clip)
      }
      log.info('Pipeline artifacts backfilled', {
        characters: results.characterDesigns.length,
        storyboards: results.storyboards.length,
        animations: results.animationClips.length,
      })

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      log.error(`Pipeline execution error: ${errorMsg}`)
      failPipeline(errorMsg, 'script')
    }
  }, [
    storyIdea,
    config,
    startPipeline,
    updatePhase,
    updateProgress,
    completePipeline,
    failPipeline,
    setScript,
    addCharacterDesign,
    addStoryboard,
    addAnimationClip,
  ])

  return { run }
}
