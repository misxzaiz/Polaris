/**
 * AI 通道基础设施（拆分自 OverlayApp.tsx）。
 * waitAssistant：订阅会话 assistant 文本直至 session_end/超时（碎碎念与对话共用）。
 * makeSpeak：cap.voice synthesize → convertFileSrc 播放（TTS，依赖 voiceOnRef）。
 * 规格：plans/pet-overlay-r2-spec.md §2.4 / §4.1
 */
import { invoke, listen } from '@/services/transport'
import { TTS_VOICE_REF } from './constants'

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
      resolve(text.replace(/<think>[\s\S]*?<\/think>/g, '').trim())
    }
    listen('chat-event', (raw: unknown) => {
      try {
        // Tauri 中继（lib.rs chat-event relay）handle.emit 推的是内层 payload 本身
        // （{ type, sessionId, content, isDelta, reason }），不是 { payload: {...} } 信封。
        // 旧代码多解了一层 env.payload → 永远 undefined → 所有事件被忽略 → 超时返回空。
        const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as
          { type?: string; sessionId?: string; content?: string; isDelta?: boolean; reason?: string } | null
        if (!p || p.sessionId !== sid) return
        if (p.type === 'assistant_message') text = p.isDelta ? text + (p.content ?? '') : (p.content ?? text)
        if (p.type === 'session_end') setTimeout(finish, 300)
      } catch { /* 忽略解析失败 */ }
    }).then((u) => { if (done) u(); else un = u }).catch(() => finish())
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
