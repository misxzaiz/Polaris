/**
 * ComicPipeline — 分镜绘制阶段
 *
 * 使用 Agnes Image 2.1 Flash 为每个分镜生成插画。
 * 通过角色参考图 + 场景描述保持画风一致性。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig } from '../../types'
import { generateImage } from '../../adapters/image'
import type { ComicPipelineConfig, ScriptPanel, CharacterDesign, StoryboardPanel } from '../types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ComicPipeline-Storyboard')

/** 构建分镜图像生成提示词 */
function buildPanelPrompt(
  panel: ScriptPanel,
  config: ComicPipelineConfig,
  characterDesigns: CharacterDesign[],
): string {
  const styleMap: Record<string, string> = {
    japanese_manga: '日式漫画风格，黑白为主，清晰线条，网点纸质感',
    american_comic: '美式漫画风格，强烈色彩，粗轮廓线，戏剧性光影',
    korean_webtoon: '韩式条漫风格，柔和色彩，精致细节，数字绘画',
    chinese_manhua: '中式漫画风格，水墨元素，东方美学',
    european_bd: '欧式BD漫画风格，清晰线条，平涂色彩',
    realistic_cinematic: '电影级写实风格，精细材质，戏剧性打光',
    custom: '高质量数字插画',
  }

  const styleDesc = styleMap[config.comicStyle] || styleMap.custom

  // 角色参考文本
  const characterRefs = characterDesigns.length > 0
    ? `\n角色参考：${characterDesigns.map(c => `${c.name}（${c.designPrompt.substring(0, 100)}）`).join('；')}`
    : ''

  // 镜头描述
  const cameraDesc = panel.cameraAngle ? `镜头：${panel.cameraAngle}。` : ''
  const moodDesc = panel.mood ? `氛围：${panel.mood}。` : ''
  const effectsDesc = panel.effects ? `特效：${panel.effects}。` : ''

  // 对话气泡预留
  const dialogueDesc = panel.dialogue?.length
    ? `\n画面需为对话气泡预留空间。对话内容：${panel.dialogue.map(d => `${d.character}：${d.text}`).join('；')}`
    : ''

  return `漫画分镜插画。
场景：${panel.scene}。
动作：${panel.action}。
${cameraDesc}${moodDesc}${effectsDesc}
风格：${styleDesc}。${characterRefs}${dialogueDesc}
构图参考：${config.pageLayout === 'webtoon_scroll' ? '竖版长条构图' : '横版16:9构图'}。`
}

/**
 * 执行分镜绘制阶段
 */
export async function* generateStoryboards(
  agnesConfig: AgnesConfig,
  panels: { pageNumber: number; panel: ScriptPanel }[],
  characterDesigns: CharacterDesign[],
  pipelineConfig: ComicPipelineConfig,
  sessionId: string,
  taskId: string,
): AsyncIterable<AIEvent> {
  const totalPanels = panels.length
  const storyboards: StoryboardPanel[] = []

  for (let i = 0; i < totalPanels; i++) {
    const { pageNumber, panel } = panels[i]
    const prompt = buildPanelPrompt(panel, pipelineConfig, characterDesigns)

    yield {
      type: 'progress',
      sessionId,
      message: `正在绘制分镜 (${i + 1}/${totalPanels})：第${pageNumber}页 第${panel.panelNumber}格 — ${panel.scene.substring(0, 40)}...`,
      percent: Math.round((i / totalPanels) * 100),
    }

    let generatedUrl = ''

    try {
      for await (const event of generateImage(
        agnesConfig,
        prompt,
        sessionId,
        `${taskId}-panel-${pageNumber}-${panel.panelNumber}`,
      )) {
        if (event.type === 'image_generated') {
          generatedUrl = event.imageUrl
        }
        yield event
      }

      if (generatedUrl) {
        storyboards.push({
          pageNumber,
          panelNumber: panel.panelNumber,
          imageUrl: generatedUrl,
          prompt,
          dialogueOverlay: panel.dialogue,
        })
        log.info('Storyboard panel generated', {
          page: pageNumber,
          panel: panel.panelNumber,
          url: generatedUrl,
        })
      }
    } catch (error) {
      log.error(
        `Failed to generate panel ${pageNumber}-${panel.panelNumber}: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
  }

  yield {
    type: 'progress',
    sessionId,
    message: `分镜绘制完成：${storyboards.length}/${totalPanels} 格`,
    percent: 100,
  }
}
