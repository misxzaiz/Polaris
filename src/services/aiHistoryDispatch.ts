/**
 * cap.history 统一调用助手（第七步阶段 B2）
 *
 * 会话历史命令层已摘除：list/get/delete + Claude Code 会话树全部经
 * RouterBus dispatch（同步动作）。Web 模式自动映射 /api/router-dispatch。
 */
import { invoke } from '@/services/transport'

/** router_dispatch 返回形态（与 commands/router.rs RouterDispatchResponse 对应） */
export interface HistoryDispatchResponse {
  msgId: string
  ok: boolean
  result: unknown
  error: string | null
  trace: string
}

export async function aiHistoryDispatch<T = unknown>(payload: Record<string, unknown>): Promise<T> {
  const res = await invoke<HistoryDispatchResponse>('router_dispatch', {
    req: { target: 'cap.history', payload },
  })
  if (!res.ok) {
    throw new Error(res.error || ('cap.history ' + String(payload.action ?? '') + ' 失败'))
  }
  return res.result as T
}
