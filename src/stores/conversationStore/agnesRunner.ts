/**
 * Agnes 主聊天运行器
 *
 * 在主聊天会话中以「输入即生图」方式运行 Agnes 引擎：
 * 用户输入直接作为图像提示词，构建 image_generate 任务，
 * 迭代前端 Agnes 引擎的事件流并桥接进 conversationStore（不经 eventRouter）。
 */

import type { AITask, AIEvent, AISession } from '@/ai-runtime'
import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import { ensureAgnesEngine } from '@/engines/agnes/ensureAgnesEngine'
import type { ConversationStore } from './types'

const log = createLogger('AgnesRunner')

/**
 * 运行 Agnes 文生图，并把事件流桥接进 conversationStore。
 *
 * @param prompt 用户输入（即图像提示词）
 * @param set conversationStore 的 set
 * @param get conversationStore 的 get
 * @param registerSession 回调：登记当前 session，供 interrupt 中止
 */
export async function runAgnesImageGeneration(
  prompt: string,
  set: (partial: Partial<ConversationStore>) => void,
  get: () => ConversationStore,
  registerSession: (session: AISession | null) => void,
): Promise<void> {
  let engine
  try {
    engine = await ensureAgnesEngine()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(msg)
    set({ error: msg, isStreaming: false, currentMessage: null })
    return
  }

  // Agnes 不经 start_chat，前端自行生成 conversationId
  const conversationId = get().conversationId || `agnes-${generateUUID()}`
  const taskId = `img-${generateUUID()}`
  set({ conversationId })

  const session = engine.createSession()
  registerSession(session)

  const task: AITask = {
    id: taskId,
    kind: 'image_generate',
    input: { prompt },
  }

  try {
    log.info('Starting Agnes image generation', { conversationId, taskId })
    for await (const event of session.run(task)) {
      // Agnes 事件不经 eventRouter，直接喂入当前会话的 handler
      get().handleAIEvent({ ...event, sessionId: conversationId } as AIEvent)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log.error(`Agnes image generation failed: ${msg}`)
    get().handleAIEvent({ type: 'error', sessionId: conversationId, error: msg } as AIEvent)
  } finally {
    registerSession(null)
    // 兜底：session_end 一般已收尾，此处确保流式状态不残留
    if (get().isStreaming) {
      set({ isStreaming: false })
      get().finishMessage()
    }
  }
}
