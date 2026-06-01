/**
 * ComicPipeline — 剧本生成阶段
 *
 * 使用 Agnes 2.0 Flash 将用户想法转化为结构化漫画剧本（JSON 格式）。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig } from '../../types'
import { streamChatCompletion } from '../../adapters/chat'
import type { ComicScript } from '../types'
import type { ComicPipelineConfig } from '../types'

/** 剧本生成的系统提示词 */
function buildScriptSystemPrompt(config: ComicPipelineConfig): string {
  return `你是一位专业的漫画/漫剧编剧。根据用户的创作想法，生成一份结构化的漫画剧本。

## 输出格式要求
请严格按照以下 JSON 格式输出，不要包含其他内容：

\`\`\`json
{
  "title": "漫画标题",
  "tagline": "副标题/标语",
  "synopsis": "故事摘要（2-3句话）",
  "styleNotes": "画面风格建议",
  "characters": [
    {
      "name": "角色名",
      "description": "角色背景描述",
      "appearance": "详细的外貌特征描述（用于AI图像生成）",
      "personality": "性格特点",
      "role": "protagonist|antagonist|supporting|cameo",
      "tags": ["标签1", "标签2"]
    }
  ],
  "pages": [
    {
      "pageNumber": 1,
      "pageNotes": "页面整体说明",
      "panels": [
        {
          "panelNumber": 1,
          "scene": "详细的场景描述（包括环境、光线、氛围）",
          "action": "角色动作描述",
          "cameraAngle": "镜头角度（如：中景平视、特写仰角）",
          "mood": "情绪氛围",
          "effects": "特效说明",
          "dialogue": [
            { "character": "角色名", "text": "对话内容", "type": "speech|thought|narration|sfx" }
          ]
        }
      ]
    }
  ]
}
\`\`\`

## 风格要求
- 漫画风格：${config.comicStyle}
- 每页分镜数：${config.panelsPerPage}
${config.includeAnimation ? '- 需要考虑后期动画制作，分镜描述中应包含动态元素说明' : ''}

## 创作要求
1. 故事要有起承转合，节奏紧凑
2. 角色性格鲜明，外貌描述要足够详细
3. 分镜描述要视觉化，适合图像生成模型理解
4. 对话自然有趣，推动剧情发展
5. 每页至少 ${config.panelsPerPage} 个分镜`
}

/**
 * 执行剧本生成阶段
 */
export async function* generateScript(
  agnesConfig: AgnesConfig,
  storyIdea: string,
  pipelineConfig: ComicPipelineConfig,
  sessionId: string,
  signal?: AbortSignal,
): AsyncIterable<AIEvent> {
  const systemPrompt = buildScriptSystemPrompt(pipelineConfig)

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: `请根据以下创作想法生成漫画剧本：\n\n${storyIdea}` },
  ]

  let rawContent = ''

  for await (const event of streamChatCompletion(
    agnesConfig,
    messages,
    sessionId,
    signal,
    undefined,
    0.8, // 较高温度增加创造性
    8192,
  )) {
    if (event.type === 'assistant_message') {
      rawContent += event.content
    }
    yield event
  }

  // 提取 JSON 剧本
  try {
    const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/)
    const jsonStr = jsonMatch ? jsonMatch[1] : rawContent
    const script: ComicScript = JSON.parse(jsonStr)

    // 验证基本结构
    if (!script.title || !script.pages?.length) {
      throw new Error('Generated script missing required fields')
    }

    // 通过 extra 传递回 session
    yield {
      type: 'progress',
      sessionId,
      message: `剧本生成完成：${script.title}，${script.pages.length} 页，${script.characters?.length || 0} 个角色`,
      percent: 100,
    }
  } catch {
    throw new Error('Failed to parse generated script JSON')
  }
}

/**
 * 从 raw 事件流中提取并解析 ComicScript
 */
export function extractScriptFromContent(rawContent: string): ComicScript {
  const jsonMatch = rawContent.match(/```json\s*([\s\S]*?)\s*```/)
  const jsonStr = jsonMatch ? jsonMatch[1] : rawContent

  // 清理可能的 markdown 残留
  const cleaned = jsonStr
    .replace(/^```\s*/, '')
    .replace(/\s*```$/, '')
    .trim()

  return JSON.parse(cleaned) as ComicScript
}
