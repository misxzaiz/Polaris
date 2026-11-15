/**
 * 会话续接（Session Handoff）— 宿主反向桥薄壳（P6 插件化后）
 *
 * 内置 Chat 已整体出仓为 chat-desk 插件；续接（handoff）实现随域迁入插件。
 * 本文件仅保留 chrome（QuickSwitchPanel）需要的两个入口，全部纯委托：
 * 经 __POLARIS_APP_CORE__.services.sessionHandoff 调用插件内实现。
 * 未就绪（插件未挂载）时返回不可续接/失败，不在此复刻任何业务逻辑。
 */

import i18n from 'i18next'
// 插件侧 sessionHandoff 服务（反向桥）：未就绪时视为不可续接
function handoffService(): {
  getHandoffEligibility: (sessionId: string) => { enabled: boolean; reasonKey: string }
  handoffSessionToNewSession: (sessionId: string, targetEngineId?: string) => Promise<{ ok: boolean; newSessionId?: string; error?: string }>
} | undefined {
  return (window as unknown as {
    __POLARIS_APP_CORE__?: { services?: { sessionHandoff?: unknown } }
  }).__POLARIS_APP_CORE__?.services?.sessionHandoff as {
    getHandoffEligibility: (sessionId: string) => { enabled: boolean; reasonKey: string }
    handoffSessionToNewSession: (sessionId: string, targetEngineId?: string) => Promise<{ ok: boolean; newSessionId?: string; error?: string }>
  } | undefined
}
import type { EngineId } from '@/types'

export interface HandoffEligibility {
  enabled: boolean
  /** 不可用原因的 i18n key（chat 命名空间，用于 tooltip 提示） */
  reasonKey?: string
}

/**
 * 判断某会话是否可执行续接
 *
 * 条件：会话存在 + 已关联工作区 + 有可加载内容（conversationId 或内存消息）。
 * 不再限制引擎 —— 任意引擎的会话都可续接（跨引擎时走内容快照路径）。
 */
export function getHandoffEligibility(sessionId: string): HandoffEligibility {
  const svc = handoffService() as { getHandoffEligibility: (id: string) => { enabled: boolean; reasonKey: string } } | undefined
  if (svc) return svc.getHandoffEligibility(sessionId)
  return { enabled: false, reasonKey: 'handoff.reasonNoSession' }
}

export interface HandoffResult {
  ok: boolean
  newSessionId?: string
  /** 失败原因（用户可见消息） */
  error?: string
}

/**
 * 将会话续接到一个新会话（可指定目标引擎，默认沿用源引擎）。
 * P6：实现随对话域迁入 chat-desk 插件；宿主此函数为纯委托（经反向桥服务）。
 */
export async function handoffSessionToNewSession(
  sessionId: string,
  targetEngineId?: EngineId,
): Promise<HandoffResult> {
  const svc = handoffService() as {
    handoffSessionToNewSession: (sessionId: string, targetEngineId?: string) => Promise<HandoffResult>
  } | undefined
  if (svc) return svc.handoffSessionToNewSession(sessionId, targetEngineId)
  return { ok: false, error: i18n.t('chat:handoff.reasonNoSession') }
}