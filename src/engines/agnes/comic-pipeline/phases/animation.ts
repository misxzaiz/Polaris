/**
 * ComicPipeline — 漫剧动效阶段
 *
 * 使用 Agnes Video V2.0 将关键分镜图转化为漫剧动画片段。
 * 支持单图动画和多图关键帧过渡。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig } from '../../types'
import { generateVideo } from '../../adapters/video'
import type { StoryboardPanel, AnimationClip } from '../types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ComicPipeline-Animation')

/** 构建动画提示词 */
function buildAnimationPrompt(
  panel: StoryboardPanel,
  index: number,
  total: number,
): string {
  const dialogueHint = panel.dialogueOverlay?.length
    ? `。对话：${panel.dialogueOverlay.map(d => `${d.character}说"${d.text}"`).join('，')}`
    : ''

  return `漫画分镜动画化（片段${index + 1}/${total}）。
保持漫画画面风格和角色一致。
微妙的呼吸感动画：角色轻微动作、场景元素微动（如风吹发丝、灯光闪烁）、电影级镜头微移。
${dialogueHint}
保持画面构图稳定，不要大幅改变画面内容。`
}

/**
 * 执行漫剧动效阶段
 */
export async function* generateAnimations(
  agnesConfig: AgnesConfig,
  storyboards: StoryboardPanel[],
  sessionId: string,
  taskId: string,
  signal?: AbortSignal,
): AsyncGenerator<AIEvent, AnimationClip[], void> {
  // 选取关键分镜进行动画化（跳帧策略：取第一个、每个关键转折点、最后一个）
  const keyPanels = selectKeyPanels(storyboards)
  const animationClips: AnimationClip[] = []

  for (let i = 0; i < keyPanels.length; i++) {
    const panel = keyPanels[i]
    const prompt = buildAnimationPrompt(panel, i, keyPanels.length)

    yield {
      type: 'progress',
      sessionId,
      message: `正在生成动画片段 (${i + 1}/${keyPanels.length})：分镜 ${panel.panelNumber}`,
      percent: Math.round((i / keyPanels.length) * 100),
    }

    let videoUrl = ''

    try {
      for await (const event of generateVideo(
        agnesConfig,
        prompt,
        sessionId,
        `${taskId}-anim-${panel.pageNumber}-${panel.panelNumber}`,
        {
          imageUrl: panel.imageUrl, // 图生视频
          numFrames: 81, // ~3.4s @ 24fps
          frameRate: 24,
        },
        signal,
      )) {
        if (event.type === 'video_completed') {
          videoUrl = event.videoUrl
        }
        yield event
      }

      if (videoUrl) {
        animationClips.push({
          panelNumber: panel.panelNumber,
          videoUrl,
          duration: 3.4,
          sourceImageUrl: panel.imageUrl,
        })
        log.info('Animation clip completed', { panel: panel.panelNumber, url: videoUrl })
      }
    } catch (error) {
      log.error(
        `Failed to animate panel ${panel.panelNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
      // 动画失败不中断整个管线，继续下一个
      yield {
        type: 'error',
        sessionId,
        error: `分镜 ${panel.panelNumber} 动画化失败: ${error instanceof Error ? error.message : 'Unknown error'}`,
      }
    }
  }

  yield {
    type: 'progress',
    sessionId,
    message: `漫剧动画完成：${animationClips.length}/${keyPanels.length} 片段`,
    percent: 100,
  }

  // 返回收集到的动画片段，供 session 回写 this.animationClips
  return animationClips
}

/**
 * 选取关键分镜进行动画化
 *
 * 策略：每页至少选 1-2 个关键分镜 + 首尾分镜
 * 总动画片段数控制在合理范围内（不超过总体的 40%）
 */
function selectKeyPanels(storyboards: StoryboardPanel[]): StoryboardPanel[] {
  if (storyboards.length <= 3) return [...storyboards]

  const selected: StoryboardPanel[] = []
  const maxClips = Math.ceil(storyboards.length * 0.4)

  // 按页分组
  const pages = new Map<number, StoryboardPanel[]>()
  for (const panel of storyboards) {
    if (!pages.has(panel.pageNumber)) {
      pages.set(panel.pageNumber, [])
    }
    pages.get(panel.pageNumber)!.push(panel)
  }

  for (const [, panels] of pages) {
    // 每页至少选第一个和最后一个
    if (panels.length > 0) selected.push(panels[0])
    if (panels.length > 1 && panels[panels.length - 1] !== panels[0]) {
      selected.push(panels[panels.length - 1])
    }
    // 中间再选一个（如果有的话）
    if (panels.length > 2) {
      const mid = panels[Math.floor(panels.length / 2)]
      if (!selected.includes(mid)) {
        selected.push(mid)
      }
    }
  }

  // 去重并限制数量
  const unique = [...new Map(selected.map(s => [s.panelNumber, s])).values()]
  return unique.slice(0, maxClips)
}
