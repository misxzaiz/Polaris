/**
 * HTML 卡片 Cap 桥 —— 宿主侧转发（协议见 plans/html-card-cap-bridge.md）
 *
 * 沙箱 iframe 内脚本 postMessage 请求 → 本模块校验（协议版本 / 白名单）→
 * 经统一 router_dispatch 转发 → 返回响应对象（由调用方 postMessage 弹回卡片）。
 *
 * 纯逻辑、零 DOM 依赖：invoke 由调用方注入（便于单测注入 mock）。
 */

/** 协议版本：__polarisCap === 1 才响应 */
export const CARD_CAP_PROTOCOL = 1

/** 白名单：卡片内脚本可调用的 cap 目标。只读/低风险优先，扩展需审慎。 */
export const CARD_CAP_ALLOWLIST = new Set(['cap.todo', 'cap.kv'])

/** 卡片 → 宿主请求（postMessage data） */
export interface CardCapRequest {
  __polarisCap?: unknown
  id?: unknown
  target?: unknown
  payload?: unknown
}

/** 宿主 → 卡片响应（postMessage data） */
export interface CardCapResponse {
  __polarisCap: 1
  id: string
  ok: boolean
  result: unknown
  error: string | null
}

export type RouterInvoke = (
  cmd: 'router_dispatch',
  args: { req: { target: string; payload: unknown } },
) => Promise<{ ok: boolean; result: unknown; error: string | null }>

/**
 * 校验并转发一次卡片请求。
 * - 协议版本不对 / 缺 id → 返回 null（调用方忽略，不响应）
 * - 白名单外目标 → 返回 ok:false 拒绝（不调用后端，无审计副作用）
 * - 白名单内 → invoke router_dispatch，成功/失败均包装为响应对象
 */
export async function forwardCardCapRequest(
  data: CardCapRequest,
  invoke: RouterInvoke,
): Promise<CardCapResponse | null> {
  if (data.__polarisCap !== CARD_CAP_PROTOCOL) return null
  if (typeof data.id !== 'string' || !data.id) return null

  const target = typeof data.target === 'string' ? data.target : ''
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {}

  if (!CARD_CAP_ALLOWLIST.has(target)) {
    return {
      __polarisCap: CARD_CAP_PROTOCOL,
      id: data.id,
      ok: false,
      result: null,
      error: `卡片 Cap 桥：目标 ${target || '(空)'} 不在白名单，已拒绝`,
    }
  }

  try {
    const res = await invoke('router_dispatch', { req: { target, payload } })
    return {
      __polarisCap: CARD_CAP_PROTOCOL,
      id: data.id,
      ok: !!res?.ok,
      result: res?.ok ? res.result : null,
      error: res?.ok ? null : (res?.error ?? `cap ${target} 失败`),
    }
  } catch (err) {
    return {
      __polarisCap: CARD_CAP_PROTOCOL,
      id: data.id,
      ok: false,
      result: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}