/**
 * OverlayApp —— ds大肥鱼桌面悬浮窗页（R1 spike，plans/pet-overlay-spike.md）。
 *
 * 由 main.tsx 桥以独立透明窗口打开（index.html?petOverlay=1，label pet-overlay）。
 * 本页是宿主前端的一部分（同源、有完整 Tauri IPC），不走面板 16 命令白名单。
 *
 * spike 职责：
 * - 经 plugin_service_list 解析 whale-pet 资源服务端口（兜底 9863，同面板逻辑）
 * - direct 通道加载 webm（悬浮窗只在桌面 Tauri 存在，无需 viaCap/移动通道）
 * - idle 循环 + 点击回应（muted 规避自动播放策略；声音开关留 R2）
 * - 拖拽：>6px 位移阈值区分点击；OS 级 startDragging
 * - 位置记忆：cap.kv（key whale-pet.overlay.pos，物理像素；onMoved 防抖保存/启动还原）
 * - 事件通道预研：listen('chat-event') 计数（R2 AI 联动走同一通道）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, listen } from '@/services/transport'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { PhysicalPosition } from '@tauri-apps/api/dpi'

const FALLBACK_PORT = 9863
const KV_POS_KEY = 'whale-pet.overlay.pos'
const DRAG_THRESHOLD_PX = 6
const VERSION_TAG = 'v0.4.0-spike'

const IDLE = ['待机呼吸休闲']
const CLICKS = [
  '点击回应-开心跃动',
  '点击回应-害羞惊讶',
  '点击回应-傲娇生气',
  '点击回应-挠痒咯咯笑',
  '点击回应-元气挥手',
]

function pick<T>(arr: T[], avoid?: T): T {
  if (arr.length === 1) return arr[0]
  const pool = avoid ? arr.filter((x) => x !== avoid) : arr
  return (pool.length ? pool : arr)[Math.floor(Math.random() * (pool.length || arr.length))]
}

/** 服务端口解析：plugin_service_list 查 whale-pet-assets 分配端口，兜底 manifest 声明值。 */
async function resolvePort(): Promise<number> {
  try {
    const res = await invoke('plugin_service_list', {})
    const wrapped = res as {
      result?: { services?: Array<{ pluginId: string; serviceId: string; port?: number }> }
      services?: Array<{ pluginId: string; serviceId: string; port?: number }>
    }
    const services = wrapped?.result?.services ?? wrapped?.services ?? []
    const svc = services.find((s) => s.pluginId === 'whale-pet' && s.serviceId === 'whale-pet-assets' && s.port)
    if (svc?.port) return svc.port
  } catch { /* 兜底端口 */ }
  return FALLBACK_PORT
}

/** 健康检查选 base：localhost 优先（Chromium 内置直连规则，v0.3.2 代理坑的结论），失败换 127.0.0.1。 */
async function pickBase(): Promise<string | null> {
  const port = await resolvePort()
  for (const host of ['localhost', '127.0.0.1']) {
    const base = `http://${host}:${port}`
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 2500)
      const r = await fetch(`${base}/__health`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (r.ok) return base
    } catch { /* 下一个候选 */ }
  }
  return null
}

type KvEnvelope = { ok?: boolean; result?: { value?: unknown } | unknown; error?: unknown }

async function kvGet(key: string): Promise<unknown | null> {
  try {
    const res = await invoke('router_dispatch', { req: { target: 'cap.kv', payload: { action: 'get', key } } }) as KvEnvelope
    const result = res?.result as { value?: unknown } | undefined
    if (result && 'value' in result) return result.value ?? null
    return null
  } catch { return null }
}

async function kvSet(key: string, value: unknown): Promise<void> {
  try {
    await invoke('router_dispatch', { req: { target: 'cap.kv', payload: { action: 'set', key, value } } })
  } catch { /* 位置记忆失败不影响播放 */ }
}

export function PetOverlayApp() {
  const videoA = useRef<HTMLVideoElement>(null)
  const videoB = useRef<HTMLVideoElement>(null)
  const front = useRef<'a' | 'b'>('a')
  const gen = useRef(0)
  const idleUrl = useRef<string>('')
  const drag = useRef<{ startX: number; startY: number; moved: boolean } | null>(null)

  const [status, setStatus] = useState<'boot' | 'ready' | 'error'>('boot')
  const [statusText, setStatusText] = useState('')
  const [evtCount, setEvtCount] = useState(0)
  const [hoverClose, setHoverClose] = useState(false)
  const posReady = useRef(false)

  /** 双缓冲换源：后台 video 预载 → 就绪后切前台；世代号丢弃迟到加载。 */
  const switchTo = useCallback(async (url: string, loop: boolean, onEnded?: () => void) => {
    const myGen = ++gen.current
    const frontEl = front.current === 'a' ? videoA.current : videoB.current
    const backEl = front.current === 'a' ? videoB.current : videoA.current
    if (!frontEl || !backEl) return
    backEl.onended = onEnded ?? null
    backEl.loop = loop
    backEl.src = url
    try { await backEl.play() } catch { /* muted 下仍可能被策略拒绝，loadeddata 后可见 */ }
    await new Promise<void>((resolve) => {
      if (backEl.readyState >= 2) return resolve()
      const h = () => { backEl.removeEventListener('loadeddata', h); resolve() }
      backEl.addEventListener('loadeddata', h)
      setTimeout(resolve, 5000) // 兜底：网络慢时仍允许切换（世代号保证不串）
    })
    if (myGen !== gen.current) return
    frontEl.pause()
    frontEl.style.display = 'none'
    backEl.style.display = 'block'
    front.current = front.current === 'a' ? 'b' : 'a'
  }, [])

  // 初始化：资源 base → idle 播放；位置还原；事件计数。
  useEffect(() => {
    let disposed = false
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'

    // R2 预研：悬浮窗内能否收到宿主事件广播（AI 联动通道）。
    const unlisten = listen('chat-event', () => setEvtCount((c) => c + 1)).catch(() => () => {})

    ;(async () => {
      const base = await pickBase()
      if (disposed) return
      if (!base) {
        setStatus('error')
        setStatusText('资源服务未就绪（whale-pet server 未启动）；点击此提示重试')
        return
      }
      idleUrl.current = `${base}/asset/webm/${encodeURIComponent(IDLE[0])}.webm`
      setStatus('ready')
      await switchTo(idleUrl.current, true)
      // 位置还原（播放起来之后，避免遮挡加载过程）
      const pos = await kvGet(KV_POS_KEY)
      if (disposed) return
      if (pos && typeof pos === 'object') {
        const { x, y } = pos as { x?: number; y?: number }
        if (typeof x === 'number' && typeof y === 'number') {
          try { await getCurrentWebviewWindow().setPosition(new PhysicalPosition(x, y)) } catch { /* 还原失败用默认位 */ }
        }
      }
      posReady.current = true
    })()

    return () => {
      disposed = true
      posReady.current = false
      void unlisten.then((f) => f())
    }
  }, [switchTo])

  // 位置记忆：onMoved 防抖保存（拖拽高频触发）。
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = { x: 0, y: 0 }
    const un = getCurrentWebviewWindow()
      .onMoved((evt) => {
        if (!posReady.current) return
        last = evt.payload
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => { void kvSet(KV_POS_KEY, { x: Math.round(last.x), y: Math.round(last.y) }) }, 400)
      })
      .catch(() => () => {})
    return () => {
      if (timer) clearTimeout(timer)
      void un.then((f) => f())
    }
  }, [])

  // 指针：>6px 位移 → OS 级拖拽；否则 pointerup 判定为点击 → 随机回应动画。
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    drag.current = { startX: e.clientX, startY: e.clientY, moved: false }
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current || drag.current.moved) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      drag.current.moved = true
      void getCurrentWebviewWindow().startDragging()
    }
  }, [])
  const onPointerUp = useCallback(() => {
    const wasClick = drag.current && !drag.current.moved
    drag.current = null
    if (wasClick && status === 'ready' && idleUrl.current) {
      const clickUrl = `${idleUrl.current.replace(/\/asset\/webm\/.*$/, '')}/asset/webm/${encodeURIComponent(pick(CLICKS))}.webm`
      void switchTo(clickUrl, false, () => { void switchTo(idleUrl.current, true) })
    }
  }, [status, switchTo])

  const retry = useCallback(() => {
    setStatus('boot')
    setStatusText('')
    // 复用初始化逻辑：最简做法是整页重载（本页无其他运行态）。
    window.location.reload()
  }, [])

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'transparent', overflow: 'hidden',
        cursor: status === 'ready' ? 'grab' : 'default', userSelect: 'none', touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onMouseEnter={() => setHoverClose(true)}
      onMouseLeave={() => setHoverClose(false)}
    >
      <video ref={videoA} muted playsInline preload="auto"
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
      <video ref={videoB} muted playsInline preload="auto"
        style={{ display: 'none', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />

      {hoverClose && (
        <button
          onClick={(e) => { e.stopPropagation(); void getCurrentWebviewWindow().close() }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 4, right: 6, width: 22, height: 22, borderRadius: 11,
            border: 'none', background: 'rgba(0,0,0,0.45)', color: '#fff', fontSize: 13,
            lineHeight: '22px', cursor: 'pointer', padding: 0,
          }}
          title="关闭悬浮窗"
        >✕</button>
      )}

      {status !== 'ready' && (
        <div
          onClick={status === 'error' ? retry : undefined}
          style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: status === 'error' ? '#ffb86b' : '#9fb8d8', fontSize: 12, textAlign: 'center',
            padding: 12, cursor: status === 'error' ? 'pointer' : 'default',
            textShadow: '0 1px 2px rgba(0,0,0,0.6)',
          }}
        >
          {status === 'boot' ? '大肥鱼正在游过来…' : statusText}
        </div>
      )}

      <div style={{
        position: 'absolute', left: 6, bottom: 4, fontSize: 10, color: 'rgba(255,255,255,0.45)',
        textShadow: '0 1px 2px rgba(0,0,0,0.6)', pointerEvents: 'none',
      }}>
        {VERSION_TAG} · 事件:{evtCount}
      </div>
    </div>
  )
}

export default PetOverlayApp
