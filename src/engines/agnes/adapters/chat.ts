/**
 * Agnes Chat Adapter
 *
 * 通过后端 `agnes_chat_completion`（reqwest 代理）发起 **非流式** Chat Completion，
 * 规避浏览器对 `apihub.agnes-ai.com` 的 CORS 限制（dev/打包态行为一致）。
 *
 * Phase 1 仅需完整文本（漫剧剧本累积 / 提示词翻译），故一次性返回单条 assistant
 * 消息即可满足下游 `rawContent` 累积逻辑。真流式打字机与工具调用闭环留 Phase 2
 * 升级为「后端 SSE + 事件桥接」。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig, AgnesMessage, AgnesTool } from '../types'
import { invoke } from '@/services/transport'

/**
 * 执行聊天完成请求（经后端代理，非流式）
 *
 * `_tools` 暂不透传：Phase 1 不含工具调用闭环（`agnesTools` 为空壳）。保留参数
 * 签名以兼容主会话 `runChat` 调用方，Phase 2 实现后端 SSE 时恢复流式与工具。
 */
export async function* streamChatCompletion(
  config: AgnesConfig,
  messages: AgnesMessage[],
  sessionId: string,
  signal?: AbortSignal,
  _tools?: AgnesTool[],
  temperature?: number,
  maxTokens?: number,
): AsyncIterable<AIEvent> {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  const content = await invoke<string>('agnes_chat_completion', {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.chatModel,
    messages,
    temperature: temperature ?? 0.7,
    maxTokens: maxTokens ?? 4096,
  })

  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError')
  }

  yield {
    type: 'assistant_message',
    sessionId,
    content,
    isDelta: false,
  }
}
