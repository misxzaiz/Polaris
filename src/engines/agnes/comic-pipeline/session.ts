/**
 * ComicPipeline Session — 漫画/漫剧全管线编排
 *
 * 完整流程：剧本 → 角色设计 → 分镜绘制 → 漫剧动效 → 合成输出
 * 通过管线状态机驱动各阶段执行，每个阶段独立上报进度和产物。
 */

import type { AISession, AISessionStatus, AITask, AIEvent } from '@/ai-runtime'
import { EventEmitter } from '@/ai-runtime'
import type { AgnesConfig } from '../types'
import type {
  ComicPipelineConfig,
  ComicScript,
  CharacterDesign,
  StoryboardPanel,
  AnimationClip,
  PipelineArtifact,
} from './types'
import {
  createInitialState,
  startPhase,
  updatePhaseProgress,
  completePhase,
  failPhase,
  completePipeline,
  abortPipeline,
} from './pipeline-state'
import type { PipelineState } from './pipeline-state'
import { generateScript, extractScriptFromContent, designCharacters, generateStoryboards, generateAnimations } from './phases'
import { createLogger } from '@/utils/logger'

const log = createLogger('ComicPipeline')

/** 默认管线配置 */
export const DEFAULT_COMIC_PIPELINE_CONFIG: ComicPipelineConfig = {
  comicStyle: 'japanese_manga',
  pageLayout: 'manga_flow',
  panelsPerPage: 4,
  outputFormat: 'both',
  includeAnimation: true,
  animationDuration: 3,
}

/**
 * 漫画/漫剧管线会话
 */
export class ComicPipelineSession extends EventEmitter implements AISession {
  readonly id: string
  status: AISessionStatus = 'idle'

  private agnesConfig: AgnesConfig
  private pipelineConfig: ComicPipelineConfig
  private state: PipelineState
  private abortController: AbortController | null = null

  // 阶段产物
  private script: ComicScript | null = null
  private characterDesigns: CharacterDesign[] = []
  private storyboards: StoryboardPanel[] = []
  private animationClips: AnimationClip[] = []
  private artifacts: PipelineArtifact[] = []

  constructor(
    id: string,
    agnesConfig: AgnesConfig,
    pipelineConfig: Partial<ComicPipelineConfig> = {},
  ) {
    super()
    this.id = id
    this.agnesConfig = agnesConfig
    this.pipelineConfig = { ...DEFAULT_COMIC_PIPELINE_CONFIG, ...pipelineConfig }
    this.state = createInitialState()
  }

  /**
   * 执行漫画/漫剧管线
   */
  async *run(task: AITask): AsyncIterable<AIEvent> {
    this.status = 'running'
    this.abortController = new AbortController()
    const signal = this.abortController.signal
    const sessionId = this.id

    // 计算需要执行的阶段
    const phasesToExecute = this.pipelineConfig.includeAnimation
      ? ['script', 'character', 'storyboard', 'animation', 'finalize'] as const
      : ['script', 'character', 'storyboard', 'finalize'] as const

    // 发送管线开始事件
    yield {
      type: 'pipeline_start',
      sessionId,
      taskId: task.id,
      pipelineType: this.pipelineConfig.outputFormat,
      phases: phasesToExecute.map(phase => ({
        phase,
        status: 'pending' as const,
        progress: 0,
      })),
    }

    try {
      for (const phase of phasesToExecute) {
        // 检查中断信号
        if (signal.aborted) {
          abortPipeline(this.state)
          return
        }

        // 更新阶段状态
        const phaseInfo = startPhase(this.state, phase, `开始${phase}阶段...`)

        yield {
          type: 'pipeline_phase',
          sessionId,
          taskId: task.id,
          phase: phaseInfo,
        }

        try {
          switch (phase) {
            case 'script':
              yield* this.executeScriptPhase(task.input.prompt, sessionId, signal)
              break
            case 'character':
              yield* this.executeCharacterPhase(sessionId, task.id, signal)
              break
            case 'storyboard':
              yield* this.executeStoryboardPhase(sessionId, task.id, signal)
              break
            case 'animation':
              yield* this.executeAnimationPhase(sessionId, task.id, signal)
              break
            case 'finalize':
              yield* this.executeFinalizePhase(sessionId, task.id)
              break
          }

          // 标记阶段完成
          const completedInfo = completePhase(this.state, phase, this.getPhaseArtifacts(phase))
          yield {
            type: 'pipeline_phase',
            sessionId,
            taskId: task.id,
            phase: completedInfo,
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : 'Unknown error'
          failPhase(this.state, phase, errorMsg)
          throw error
        }
      }

      // 管线完成
      completePipeline(this.state)

      yield {
        type: 'pipeline_completed',
        sessionId,
        taskId: task.id,
        artifacts: this.artifacts.filter(a => a.type !== 'script').map(a => ({
          type: a.type as 'image' | 'video' | 'document',
          url: a.url,
          label: a.label,
        })),
        totalDuration: 0, // 由外部计算
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }

      const errorMsg = error instanceof Error ? error.message : 'Unknown error'
      log.error(`Pipeline failed: ${errorMsg}`)

      yield {
        type: 'pipeline_failed',
        sessionId,
        taskId: task.id,
        error: errorMsg,
        failedPhase: this.state.activePhase || 'script',
      }

      yield {
        type: 'error',
        sessionId,
        error: errorMsg,
      }
    } finally {
      this.status = 'idle'
      this.abortController = null
    }

    yield {
      type: 'session_end',
      sessionId,
      reason: 'completed',
    }
  }

  /** 执行剧本生成阶段 */
  private async *executeScriptPhase(
    storyIdea: string,
    sessionId: string,
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    let rawContent = ''
    const progressMessages = ['正在构思故事框架...', '正在设计角色...', '正在安排分镜...', '正在润色对话...']
    let msgIndex = 0

    for await (const event of generateScript(
      this.agnesConfig,
      storyIdea,
      this.pipelineConfig,
      sessionId,
      signal,
    )) {
      if (event.type === 'assistant_message') {
        rawContent += event.content
      }
      yield event

      // 每收到一定内容后更新进度
      if (event.type === 'assistant_message' && msgIndex < progressMessages.length) {
        const info = updatePhaseProgress(
          this.state,
          'script',
          Math.min(90, 20 + msgIndex * 20),
          progressMessages[msgIndex],
        )
        yield {
          type: 'pipeline_phase',
          sessionId,
          taskId: this.id,
          phase: info,
        }
        msgIndex++
      }
    }

    // 提取剧本
    try {
      this.script = extractScriptFromContent(rawContent)

      updatePhaseProgress(this.state, 'script', 100, `剧本完成：${this.script.title}`)
    } catch {
      throw new Error('无法解析生成的剧本 JSON，请重试')
    }
  }

  /** 执行角色设计阶段 */
  private async *executeCharacterPhase(
    sessionId: string,
    taskId: string,
    _signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    if (!this.script?.characters?.length) {
      throw new Error('No characters defined in script')
    }

    const characters = this.script.characters

    this.characterDesigns = yield* designCharacters(
      this.agnesConfig,
      characters,
      this.pipelineConfig,
      sessionId,
      taskId,
    )
  }

  /** 执行分镜绘制阶段 */
  private async *executeStoryboardPhase(
    sessionId: string,
    taskId: string,
    _signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    if (!this.script?.pages?.length) {
      throw new Error('No pages defined in script')
    }

    // 展平所有分镜
    const flatPanels = this.script.pages.flatMap(page =>
      page.panels.map(panel => ({
        pageNumber: page.pageNumber,
        panel,
      })),
    )

    this.storyboards = yield* generateStoryboards(
      this.agnesConfig,
      flatPanels,
      this.characterDesigns,
      this.pipelineConfig,
      sessionId,
      taskId,
    )
  }

  /** 执行漫剧动效阶段 */
  private async *executeAnimationPhase(
    sessionId: string,
    taskId: string,
    signal: AbortSignal,
  ): AsyncIterable<AIEvent> {
    if (this.storyboards.length === 0) {
      yield {
        type: 'progress',
        sessionId,
        message: '跳过分镜动画 — 没有可动画化的分镜',
        percent: 100,
      }
      return
    }

    this.animationClips = yield* generateAnimations(
      this.agnesConfig,
      this.storyboards,
      sessionId,
      taskId,
      signal,
    )
  }

  /** 执行合成输出阶段 */
  private async *executeFinalizePhase(
    sessionId: string,
    _taskId: string,
  ): AsyncIterable<AIEvent> {
    yield {
      type: 'progress',
      sessionId,
      message: '正在整理输出产物...',
      percent: 50,
    }

    // 收集所有产物
    this.artifacts = []

    if (this.script) {
      this.artifacts.push({
        type: 'document',
        label: `剧本：${this.script.title}`,
        url: '', // 剧本作为内联 JSON
      })
    }

    for (const design of this.characterDesigns) {
      this.artifacts.push({
        type: 'image',
        label: `角色：${design.name}`,
        url: design.designImageUrl,
      })
    }

    for (const panel of this.storyboards) {
      this.artifacts.push({
        type: 'image',
        label: `分镜：第${panel.pageNumber}页 第${panel.panelNumber}格`,
        url: panel.imageUrl,
      })
    }

    for (const clip of this.animationClips) {
      this.artifacts.push({
        type: 'video',
        label: `动画片段：分镜 ${clip.panelNumber}`,
        url: clip.videoUrl,
      })
    }

    yield {
      type: 'progress',
      sessionId,
      message: `合成完成：${this.artifacts.length} 个产物`,
      percent: 100,
    }
  }

  /** 获取阶段的产物 URL 列表 */
  private getPhaseArtifacts(phase: string): string[] {
    switch (phase) {
      case 'character':
        return this.characterDesigns.map(d => d.designImageUrl)
      case 'storyboard':
        return this.storyboards.map(s => s.imageUrl)
      case 'animation':
        return this.animationClips.map(c => c.videoUrl)
      default:
        return []
    }
  }

  /** 中断执行 */
  abort(): void {
    this.abortController?.abort()
    abortPipeline(this.state)
    this.status = 'idle'
    log.info('Pipeline aborted')
  }

  /** 销毁会话 */
  dispose(): void {
    this.abort()
    this.removeAllListeners()
    this.script = null
    this.characterDesigns = []
    this.storyboards = []
    this.animationClips = []
    this.artifacts = []
  }

  /** 获取当前状态 */
  getState(): PipelineState {
    return this.state
  }

  /** 获取管线配置 */
  getConfig(): ComicPipelineConfig {
    return { ...this.pipelineConfig }
  }

  /** 获取结果 */
  getResults() {
    return {
      script: this.script,
      characterDesigns: this.characterDesigns,
      storyboards: this.storyboards,
      animationClips: this.animationClips,
      artifacts: this.artifacts,
    }
  }
}
