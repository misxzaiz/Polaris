/**
 * cap.ai.chat 统一调用助手（第七步阶段 A3）
 *
 * chat 命令层已摘除：所有 AI 会话操作经 RouterBus dispatch
 * （同步动作 router_dispatch；流式动作 router_dispatch_stream，
 *   事件经既有 chat-event 通道推送，前端 EventRouter 零改动）。
 */
import { invoke } from '@/services/transport'

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
export interface AiDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

export interface AiStreamAck {
  msgId: string
  trace: string
}

const TARGET = 'cap.ai.chat'

/** 同步动作：interrupt / send_input / approve_plan / reject_plan / answer_question 等 */
export async function aiChatDispatch<T = unknown>(payload: Record<string, unknown>): Promise<T> {
  const res = await invoke<AiDispatchResponse>('router_dispatch', {
    req: { target: TARGET, payload },
  })
  if (!res.ok) {
    throw new Error(res.error || ('cap.ai.chat ' + String(payload.action ?? '') + ' 失败'))
  }
  return res.result as T
}

/** 流式动作：start / continue（返回 ack；内容经 chat-event 事件流推送） */
export async function aiChatDispatchStream(payload: Record<string, unknown>): Promise<AiStreamAck> {
  return invoke<AiStreamAck>('router_dispatch_stream', {
    req: { target: TARGET, payload },
  })
}
