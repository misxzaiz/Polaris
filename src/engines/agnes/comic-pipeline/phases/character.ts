/**
 * ComicPipeline — 角色设计阶段
 *
 * 使用 Agnes Image 2.1 Flash 为每个角色生成设定图。
 * 支持主设定图 + 关键表情变体。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig } from '../../types'
import { generateImage } from '../../adapters/image'
import type { ComicPipelineConfig, ScriptCharacter, CharacterDesign } from '../types'
import { createLogger } from '@/utils/logger'

const log = createLogger('ComicPipeline-Character')

/** 角色设计系统提示词模板 */
function buildCharacterPrompt(
  character: ScriptCharacter,
  pipelineConfig: ComicPipelineConfig,
): string {
  const styleDescriptions: Record<string, string> = {
    japanese_manga: '日式漫画风格，清晰线条，夸张表情，黑白灰为主配网点纸质感',
    american_comic: '美式超级英雄漫画风格，强色彩对比，粗轮廓线，半色调网点',
    korean_webtoon: '韩式条漫风格，柔和色彩，精致面部，干净背景，数字绘画质感',
    chinese_manhua: '中式漫画风格，水墨渲染元素，东方美学，细腻线条',
    european_bd: '欧式BD漫画风格，清晰线条（ligne claire），平涂色彩',
    realistic_cinematic: '电影级写实风格，精细材质，戏剧性打光，摄影级质感',
    custom: '高质量数字插画风格',
  }

  const styleDesc = styleDescriptions[pipelineConfig.comicStyle] || styleDescriptions.custom

  return `角色设定图，${character.name}，${character.appearance}。
角色定位：${character.role === 'protagonist' ? '主角' : character.role === 'antagonist' ? '反派' : character.role === 'supporting' ? '配角' : '客串'}。
性格特点：${character.personality}。
风格：${styleDesc}。
角色设定图格式：全身站立姿态，展示正面视角，角色居中构图，纯色简洁背景。
高质量，细节丰富，角色设计表风格（character design sheet）。`
}

/**
 * 执行角色设计阶段
 */
export async function* designCharacters(
  agnesConfig: AgnesConfig,
  characters: ScriptCharacter[],
  pipelineConfig: ComicPipelineConfig,
  sessionId: string,
  taskId: string,
): AsyncGenerator<AIEvent, CharacterDesign[], void> {
  const designs: CharacterDesign[] = []

  for (let i = 0; i < characters.length; i++) {
    const character = characters[i]
    const prompt = buildCharacterPrompt(character, pipelineConfig)

    yield {
      type: 'progress',
      sessionId,
      message: `正在设计角色 (${i + 1}/${characters.length})：${character.name}`,
      percent: Math.round((i / characters.length) * 100),
    }

    let generatedUrl = ''

    try {
      for await (const event of generateImage(
        agnesConfig,
        prompt,
        sessionId,
        `${taskId}-char-${i}`,
      )) {
        if (event.type === 'image_generated') {
          generatedUrl = event.imageUrl
        }
        yield event
      }

      if (generatedUrl) {
        designs.push({
          name: character.name,
          designImageUrl: generatedUrl,
          designPrompt: prompt,
        })
        log.info('Character design completed', { name: character.name, url: generatedUrl })
      }
    } catch (error) {
      log.error(`Failed to design character: ${character.name} — ${error instanceof Error ? error.message : String(error)}`)
      throw error
    }
  }

  yield {
    type: 'progress',
    sessionId,
    message: `角色设计完成：${designs.length} 个角色`,
    percent: 100,
  }

  // 返回收集到的角色设计，供 session 回写 this.characterDesigns
  return designs
}
