/**
 * 失焦系统通知 hook（拆分自 OverlayApp.tsx）。
 * 独立监听 chat-event：主会话一轮结束且焦点不在 Polaris 时 plugin:notification。
 * 60s 限频；排除碎碎念/宠物对话会话（它们是本页自己的会话，不应触发"AI 回话啦"）。
 * 规格：plans/pet-overlay-r2-spec.md §2.4 / §3.2 / §4.1
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, listen } from '@/services/transport'
import { kvGet, kvSet } from './assetResolver'
import { KV_NOTIFY_KEY } from './constants'

const NOTIFY_COOLDOWN_MS = 60000
const NOTIFY_TITLE = 'ds大肥鱼'
const NOTIFY_BODY = '主人～AI 回话啦，回来看看吧！'

export interface NotifyExcluded {
  /** 碎碎念会话 id ref（当前值即排除对象） */
  whisperSessionRef: React.RefObject<string | null>
  /** 宠物对话会话 id ref（当前值即排除对象） */
  chatSessionRef: React.RefObject<string | null>
}

export function useSystemNotify(excluded: NotifyExcluded) {
  const [notifyOn, setNotifyOn] = useState(true)
  const notifyOnRef = useRef(true)
  const lastNotifyRef = useRef(0)
  const sessionFlowRef = useRef<Map<string, number>>(new Map())
  const listenReady = useRef(false)

  /** 从 KV 恢复开关偏好（初始化 effect 调用一次）。 */
  const restoreNotifyPref = useCallback(async () => {
    const pref = await kvGet(KV_NOTIFY_KEY)
    if (typeof pref === 'boolean') { notifyOnRef.current = pref; setNotifyOn(pref) }
  }, [])

  /** 右键菜单切换 + 持久化。 */
  const toggleNotify = useCallback(() => {
    const next = !notifyOnRef.current
    notifyOnRef.current = next
    setNotifyOn(next)
    void kvSet(KV_NOTIFY_KEY, next)
  }, [])

  // 独立监听 chat-event（与主组件的 lastEvtAt/setEvtCount 监听并存，Tauri 同事件多监听允许）。
  useEffect(() => {
    if (listenReady.current) return
    if (!('__TAURI_INTERNALS__' in window)) return
    listenReady.current = true
    let un: (() => void) | null = null
    void listen('chat-event', (raw: unknown) => {
      try {
        const env = (typeof raw === 'string' ? JSON.parse(raw) : raw) as { payload?: { type?: string; sessionId?: string; reason?: string } }
        const p = env?.payload
        if (!p?.sessionId) return
        if (p.type === 'assistant_message') {
          sessionFlowRef.current.set(p.sessionId, Date.now())
          return
        }
        if (p.type === 'session_end' && p.reason === 'completed'
          && p.sessionId !== excluded.whisperSessionRef.current
          && p.sessionId !== excluded.chatSessionRef.current
          && notifyOnRef.current && !document.hasFocus()
          && Date.now() - lastNotifyRef.current > NOTIFY_COOLDOWN_MS) {
          lastNotifyRef.current = Date.now()
          sessionFlowRef.current.delete(p.sessionId)
          void invoke('plugin:notification|notify', { options: { title: NOTIFY_TITLE, body: NOTIFY_BODY } }).catch(() => { /* 通知失败静默 */ })
        }
      } catch { /* 通知路径失败不影响播放 */ }
    }).then((f) => { un = f }).catch(() => {})
    return () => { if (un) un() }
  }, [excluded.whisperSessionRef, excluded.chatSessionRef])

  return { notifyOn, toggleNotify, restoreNotifyPref }
}
