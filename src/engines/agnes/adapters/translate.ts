/**
 * Agnes Prompt Translate Adapter
 *
 * Agnes 的图像/视频生成对英文提示词更稳定（官方建议）。
 * 本模块在调用图像/视频接口前，自动检测非英文提示词并用 agnes-2.0-flash 翻译为英文。
 *
 * 设计要点：
 * - 仅当提示词包含非 ASCII 字符且配置开启（默认开启）时才翻译。
 * - 翻译失败时静默回退到原始提示词，绝不阻断生成流程。
 * - 使用非流式 chat completion（temperature=0）保证翻译稳定。
 */

import type { AgnesConfig } from '../types'
import { createLogger } from '@/utils/logger'

const log = createLogger('AgnesTranslate')

/** 翻译系统提示词 */
const TRANSLATE_SYSTEM_PROMPT =
  'You are a prompt translator for an AI image/video generation model. ' +
  "Translate the user's image/video generation prompt into fluent, natural English. " +
  'Preserve all visual details, subject, style, lighting, composition, camera motion and special effects. ' +
  'Do not add, remove or explain anything. Return ONLY the translated English prompt, with no quotes or extra text.'

/**
 * 检测文本是否包含非 ASCII 字符（如中文、日文等）。
 */
export function containsNonAscii(text: string): boolean {
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 127) {
      return true
    }
  }
  return false
}

/**
 * 调用 Agnes chat 接口将提示词翻译为英文（非流式，temperature=0）。
 *
 * @throws 当 API 出错或返回空翻译时抛出
 */
export async function translatePromptToEnglish(
  config: AgnesConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.chatModel,
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
      stream: false,
    }),
    signal,
  })

  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ error: { message: response.statusText } }))
    throw new Error(error.error?.message || `Translate API error: ${response.status}`)
  }

  const data = await response.json()
  const translated: string = data.choices?.[0]?.message?.content?.trim() ?? ''

  if (!translated) {
    throw new Error('Prompt translation failed: empty translated prompt')
  }

  return translated
}

/**
 * 按需翻译提示词：
 * - 配置关闭（translatePrompt === false）→ 原样返回
 * - 全 ASCII（已是英文）→ 原样返回
 * - 否则尝试翻译，失败时回退原文（不阻断生成）
 */
export async function maybeTranslatePrompt(
  config: AgnesConfig,
  prompt: string,
  signal?: AbortSignal,
): Promise<string> {
  if (config.translatePrompt === false) {
    return prompt
  }
  if (!containsNonAscii(prompt)) {
    return prompt
  }

  try {
    const translated = await translatePromptToEnglish(config, prompt, signal)
    log.info('Prompt translated to English', {
      original: prompt.substring(0, 40),
      translated: translated.substring(0, 40),
    })
    return translated
  } catch (error) {
    // 翻译失败不阻断生成，回退到原始提示词
    log.warn('Prompt translation failed, falling back to original prompt', {
      error: error instanceof Error ? error.message : String(error),
    })
    return prompt
  }
}
