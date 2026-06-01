/**
 * Agnes Chat Adapter
 *
 * 复用 OpenAI 兼容的 Chat Completions API，支持流式 SSE 和工具调用。
 * 与 OpenAIProtocolEngine 的 session 逻辑兼容但做了 Agnes 特化。
 */

import type { AIEvent } from '@/ai-runtime'
import type { AgnesConfig, AgnesMessage, AgnesTool, AgnesToolCall } from '../types'

/** SSE 流式解析状态 */
interface StreamState {
  buffer: string
  currentToolCalls: Map<number, AgnesToolCall>
  assistantContent: string
}

/**
 * 执行流式聊天完成请求
 */
export async function* streamChatCompletion(
  config: AgnesConfig,
  messages: AgnesMessage[],
  sessionId: string,
  signal?: AbortSignal,
  tools?: AgnesTool[],
  temperature?: number,
  maxTokens?: number,
): AsyncIterable<AIEvent> {
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.chatModel,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      tool_choice: tools && tools.length > 0 ? 'auto' : undefined,
      max_tokens: maxTokens ?? 4096,
      temperature: temperature ?? 0.7,
      stream: true,
    }),
    signal,
  })

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: { message: response.statusText } }))
    throw new Error(error.error?.message || `API error: ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Response body is null')
  }

  const decoder = new TextDecoder()
  const state: StreamState = {
    buffer: '',
    currentToolCalls: new Map(),
    assistantContent: '',
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      state.buffer += decoder.decode(value, { stream: true })
      const lines = state.buffer.split('\n')
      state.buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6)
          if (data === '[DONE]') continue

          try {
            const chunk = JSON.parse(data)
            const delta = chunk.choices?.[0]?.delta
            const finishReason = chunk.choices?.[0]?.finish_reason

            if (delta?.content) {
              state.assistantContent += delta.content
              yield {
                type: 'assistant_message',
                sessionId,
                content: delta.content,
                isDelta: true,
              }
            }

            // 处理工具调用增量
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const existing = state.currentToolCalls.get(tc.index)
                if (existing) {
                  if (tc.function?.arguments) {
                    existing.function.arguments += tc.function.arguments
                  }
                } else {
                  state.currentToolCalls.set(tc.index, {
                    id: tc.id || `call_${tc.index}`,
                    type: 'function',
                    function: {
                      name: tc.function?.name || '',
                      arguments: tc.function?.arguments || '',
                    },
                  })
                }
              }
            }

            // 流结束处理
            if (finishReason === 'stop' || finishReason === 'tool_calls') {
              const assistantMessage: AgnesMessage = {
                role: 'assistant',
                content: state.assistantContent || null,
              }

              if (state.currentToolCalls.size > 0) {
                assistantMessage.tool_calls = Array.from(state.currentToolCalls.values())
                for (const tc of assistantMessage.tool_calls) {
                  try {
                    yield {
                      type: 'tool_call_start',
                      sessionId,
                      callId: tc.id,
                      tool: tc.function.name,
                      args: JSON.parse(tc.function.arguments),
                    }
                  } catch {
                    yield {
                      type: 'tool_call_start',
                      sessionId,
                      callId: tc.id,
                      tool: tc.function.name,
                      args: {},
                    }
                  }
                }
              }

              // 通过 reader 外部处理消息追加（由 session 管理 messages）
              ;(assistantMessage as unknown as { _streamDone: boolean })._streamDone = true
            }
          } catch {
            // 忽略解析错误（不完整的 chunk）
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
