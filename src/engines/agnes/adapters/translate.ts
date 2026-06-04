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
import { invoke } from '@/services/transport'
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
  // 已取消则直接中止（invoke 不透传 AbortSignal，此处做请求前检查）
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  // 通过 Rust 后端代理翻译请求（非流式 chat completion），规避浏览器 CORS
  const translated = await invoke<string>('agnes_chat_completion', {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.chatModel,
    messages: [
      { role: 'system', content: TRANSLATE_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
  })

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
