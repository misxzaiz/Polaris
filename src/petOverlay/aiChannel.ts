/**
 * AI 通道基础设施（拆分自 OverlayApp.tsx）。
 * waitAssistant：订阅会话 assistant 文本直至 session_end/超时（碎碎念与对话共用）。
 * streamChat：流式发起 start/continue（router_dispatch_stream），不占后端 blocking 池。
 * makeSpeak：cap.voice synthesize → convertFileSrc 播放（TTS，依赖 voiceOnRef）。
 * 规格：plans/pet-overlay-r2-spec.md §2.4 / §4.1
 */
import { invoke, listen } from '@/services/transport'
import { aiChatDispatchStream } from '@/services/aiChatDispatch'
import { TTS_VOICE_REF } from './constants'

/** chat-event 中继载荷（Tauri lib.rs relay 推内层 payload 本身，非 { payload } 信封） */
type ChatEventPayload = {
  type?: string
  sessionId?: string
  content?: string
  isDelta?: boolean
  reason?: string
  engineId?: string
}

/** 解析 chat-event raw（string | object）为载荷对象 */
function parseChatEvent(raw: unknown): ChatEventPayload | null {
  try {
    const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as ChatEventPayload | null
    return p ?? null
  } catch { return null }
}

/** 去 think 块并 trim（碎碎念/对话共用，think 块为推理过程不展示） */
function stripThink(s: string): string {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

/**
 * 订阅某会话的 assistant 文本直至 session_end/超时。
 * 返回：累计文本（去 think 块，trim）。
 */
export function waitAssistant(sid: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = ''
    let un: (() => void) | null = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (un) un()
      resolve(stripThink(text))
    }
    listen('chat-event', (raw: unknown) => {
      const p = parseChatEvent(raw)
      if (!p || p.sessionId !== sid) return
      if (p.type === 'assistant_message') text = p.isDelta ? text + (p.content ?? '') : (p.content ?? text)
      if (p.type === 'session_end') setTimeout(finish, 300)
    }).then((u) => { if (done) u(); else un = u }).catch(() => finish())
    setTimeout(finish, timeoutMs)
  })
}

/**
 * 流式发起 cap.ai.chat start/continue（经 router_dispatch_stream）。
 *
 * 改造背景（2026-11-04）：原同步 router_dispatch 路径在后端走 spawn_blocking +
 * block_in_place 驱动 start_chat_inner，慢启动引擎（如 codebuddy ~15s 冷启动）
 * 会独占 tokio blocking 池槽位，触发 10s 楔死告警。流式路径 invoke_stream 用
 * 独立 OS 线程驱动，ack 立即返回，不占 blocking 池。
 *
 * - start：ack 不含 sessionId（流式契约 aiChatDispatchStream 只返回 {msgId,trace}），
 *   需先订阅 chat-event，从 session_start 事件提取 sid，再累积 assistant 文本。
 * - continue：sid 已知，直接订阅过滤 + dispatch。
 *
 * 返回 { sid, text }：start 时 sid 为新会话 id；continue 时 sid 为入参原值。
 * text 为累计 assistant 文本（去 think 块，trim）；超时/失败 text 为空串。
 */
export function streamChat(params: {
  action: 'start' | 'continue'
  message: string
  sessionId?: string
  options?: Record<string, unknown>
  timeoutMs: number
}): Promise<{ sid: string; text: string }> {
  const { action, message, sessionId, options, timeoutMs } = params
  return new Promise((resolve) => {
    let text = ''
    let sid = sessionId ?? ''
    let un: (() => void) | null = null
    let done = false
    const finish = () => {
      if (done) return
      done = true
      if (un) un()
      resolve({ sid, text: stripThink(text) })
    }
    // 先订阅，避免 session_start 早于 listen 注册而丢失（ack 返回前事件极少早到，但保险）
    listen('chat-event', (raw: unknown) => {
      const p = parseChatEvent(raw)
      if (!p) return
      // start：捕获 session_start 拿 sid（continue 已有 sid，跳过）
      if (!sid && p.type === 'session_start' && p.sessionId) {
        sid = p.sessionId
        return
      }
      if (!sid || p.sessionId !== sid) return
      if (p.type === 'assistant_message') text = p.isDelta ? text + (p.content ?? '') : (p.content ?? text)
      if (p.type === 'session_end') setTimeout(finish, 300)
    }).then((u) => { if (done) u(); else un = u }).catch(() => finish())

    // 发起流式 dispatch（ack 仅表示后端已接收，真正结果走事件流）
    aiChatDispatchStream({
      action,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(options ? { options } : {}),
    }).catch(() => finish())

    setTimeout(finish, timeoutMs)
  })
}

/**
 * TTS 工厂：voiceOnRef 是开关 ref（组件自持）。返回 speak(text)。
 * cap.voice synthesize → file 绝对路径 → convertFileSrc 播放（引擎未就绪/手势未解锁均静默）。
 */
export function makeSpeak(voiceOnRef: React.RefObject<boolean>) {
  return (text: string) => {
    if (!voiceOnRef.current || !text || !('__TAURI_INTERNALS__' in window)) return
    void (async () => {
      try {
        const r = await invoke('router_dispatch', { req: { target: 'cap.voice', payload: { action: 'synthesize', text, voiceRef: TTS_VOICE_REF } } }) as { result?: { file?: string } }
        const file = r?.result?.file
        if (!file) return
        const { convertFileSrc } = await import('@tauri-apps/api/core')
        const audio = new Audio(convertFileSrc(file))
        void audio.play().catch(() => { /* 静默 */ })
      } catch { /* 静默 */ }
    })()
  }
}
