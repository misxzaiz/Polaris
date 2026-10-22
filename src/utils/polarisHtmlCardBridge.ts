/**
 * HTML 卡片 Cap 桥 —— 卡片侧 SDK（内部）
 *
 * 沙箱 iframe 内的脚本通过 window.parent.postMessage 请求宿主经 RouterBus
 * 调用 cap 能力（协议见 plans/html-card-cap-bridge.md）。本模块是宿主侧
 * 配套的「发起 + 按 id 收回应」实现；演示卡片可直接内联等效实现。
 *
 * 设计约束：
 * - 零外部依赖、零副作用（仅发起与监听 message）。
 * - 请求必须带唯一 id；响应按 id resolve，8s 超时。
 * - 卡片卸载时 abort 全部 pending，避免幽灵 resolve。
 */

export interface HtmlCardCapRequest {
  __polarisCap: 1
  id: string
  target: string
  payload: Record<string, unknown>
}

export interface HtmlCardCapResponse {
  __polarisCap: 1
  id: string
  ok: boolean
  result: unknown
  error: string | null
}

const PROTOCOL = 1 as const
const REQUEST_TIMEOUT_MS = 8_000

interface PendingEntry {
  resolve: (res: HtmlCardCapResponse) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 卡片侧桥实例：dispatch 发起请求，按 id 收宿主响应。
 * 每个卡片/iframe 上下文建议单例（同一 message 事件源）。
 */
export class PolarisHtmlCardBridge {
  private pending = new Map<string, PendingEntry>()
  private started = false

  /** 注册 message 监听（幂等；重复调用不重复挂） */
  start(): void {
    if (this.started) return
    this.started = true
    window.addEventListener('message', this.onMessage)
  }

  /** 卸载时清理：移除监听 + abort 全部 pending */
  dispose(): void {
    window.removeEventListener('message', this.onMessage)
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
    }
    this.pending.clear()
    this.started = false
  }

  /** 发起一次 cap 调用，返回宿主响应（成功或失败均 resolve；超时给 ok:false） */
  dispatch(target: string, payload: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<HtmlCardCapResponse> {
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise<HtmlCardCapResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ __polarisCap: PROTOCOL, id, ok: false, result: null, error: `超时(${timeoutMs}ms): ${target}` })
      }, timeoutMs)
      this.pending.set(id, { resolve, timer })
      window.parent.postMessage(
        { __polarisCap: PROTOCOL, id, target, payload } satisfies HtmlCardCapRequest,
        '*' // 宿主与卡片为跨源文档，沙箱内无法预知宿主 origin；协议 + id 校验兜底
      )
    })
  }

  private onMessage = (event: MessageEvent): void => {
    const data = event.data
    if (!data || typeof data !== 'object' || data.__polarisCap !== PROTOCOL) return
    const entry = this.pending.get(String(data.id))
    if (!entry) return
    this.pending.delete(String(data.id))
    clearTimeout(entry.timer)
    entry.resolve(data as HtmlCardCapResponse)
  }
}

/** 默认单例（一个 iframe 上下文一个即可） */
export const polarisHtmlCardBridge = new PolarisHtmlCardBridge()
