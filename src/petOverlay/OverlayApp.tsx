/**
 * OverlayApp —— ds大肥鱼桌面悬浮窗页（R1.5 原版效果对标，plans: Polaris-plugin/docs/whale-overlay-r15-spec.md）。
 *
 * 由 main.tsx 桥以独立透明窗口打开（index.html?petOverlay=1，label pet-overlay）。
 * 本页是宿主前端的一部分（同源、有完整 Tauri IPC），不走面板 16 命令白名单。
 *
 * 交互面（对标 dsh-pet 0.4.0，全部本地素材）：
 * - 完整随机链：idle/turn/80 类动作（权重同步自 dsh config.jsonc）
 * - 点击：随机回应 + 手速积分飘字 + click-duck.wav 音效（可开关）
 * - 拖拽：越阈值播「被鼠标拖拽悬空反馈」循环，位置由 OS 拖拽承担
 * - 松手结算：低速=落地 squash；高速=抛飞（重力/边缘反弹/地面摩擦/落定挤压）
 * - 自主走位：moves 池按视频播放时间轴平移窗口，越界退回原地动作
 * - 睡觉：23:00–07:00 三段链，点击唤醒，睡着说梦话
 * - 碎碎念气泡：离线文案池每 5min 一句（R2 换 AI）
 * - 右键菜单：声音开关 / 回屏幕中央 / 关闭
 *
 * 边界不变量（照抄原版纪律，见 spec）：
 * 1. 同一时刻最多一条 rAF 运动（flight/walk 互斥），新运动取消旧运动
 * 2. 位置恢复/走位目标/抛飞落点全部 clamp 在工作区内
 * 3. window 级 pointerup/blur 兜底收尾，指针捕获丢失不残留拖拽态
 * 4. 非 idle 动画加载失败 → 跳过回链；idle 失败才进错误态
 * 5. 拖拽轨迹采样估初速；kv 位置在拖拽/运动结束时写一次
 * 6. 循环段收到 ended = 前台被顶 → 重新点名 loop 而非重播
 */
import React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke, listen } from '@/services/transport'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { PhysicalPosition } from '@tauri-apps/api/dpi'
import { pick, rollChain } from './animationChain'
import { resolvePort, pickBase, assetUrl, kvGet, kvSet } from './assetResolver'
import {
  KV_POS_KEY, KV_SOUND_KEY, KV_AI_WHISPER_KEY, KV_WHISPER_SESSION_KEY,
  KV_VOICE_KEY, KV_CHAT_SESSION_KEY, DRAG_THRESHOLD_PX, VERSION_TAG,
  IDLE, DRAG, CLICKS, MOVES, SLEEP,
  WORK_BUSY, WORK_CELEBRATE, BUSY_ACTIVE_MS, BUSY_QUIET_MS, BALANCE_TIERS, BALANCE_POLL_MS,
  WHISPER_PROMPT, AI_WHISPER_TIMEOUT_MS, PET_PERSONA, CHAT_TIMEOUT_MS, AI_ENGINE_ID,
  WHISPERS, SLEEP_TALK, SLEEP_START_TEXT,
  GRAVITY, RESTITUTION, GROUND_FRICTION, THROW_MIN_SPEED, TRAJ_WINDOW_MS,
} from './constants'

import { StatusPill, OverlayErrorBoundary } from './OverlayRender'
import { resolveSlot } from './useMultiSlot'
import { useSystemNotify } from './useSystemNotify'
import { streamChat, makeSpeak } from './aiChannel'

interface WorkArea { x: number; y: number; w: number; h: number }

function PetOverlayInner() {
  const videoA = useRef<HTMLVideoElement>(null)
  const videoB = useRef<HTMLVideoElement>(null)
  const front = useRef<'a' | 'b'>('a')
  const videoGen = useRef(0)
  const baseRef = useRef<string>('')
  const rootRef = useRef<HTMLDivElement>(null)
  const chatLogRef = useRef<HTMLDivElement>(null)

  // —— 状态机 refs（避免闭包过期）——
  const modeRef = useRef<'chain' | 'drag' | 'flight' | 'walk' | 'sleep'>('chain')
  const currentAnimRef = useRef<string>(IDLE[0])
  const sleepingRef = useRef(false)
  const motionRafRef = useRef<number | null>(null)
  const motionGenRef = useRef(0)
  const workAreaRef = useRef<WorkArea | null>(null)
  const winSizeRef = useRef<{ w: number; h: number }>({ w: 450, h: 450 })
  const trajRef = useRef<Array<{ t: number; x: number; y: number }>>([])
  const posReady = useRef(false)
  const drag = useRef<{ startX: number; startY: number; moved: boolean; downT: number } | null>(null)
  const soundOnRef = useRef(true)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const sleepTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const sleepCheckerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const whisperTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastEvtAtRef = useRef(0)
  const busyRef = useRef(false)
  const aiWhisperOnRef = useRef(true)
  const whisperSessionRef = useRef<string | null>(null)
  const voiceOnRef = useRef(false)
  const chatSessionRef = useRef<string | null>(null)
  const slotRef = useRef(0)
  const posKeyRef = useRef(KV_POS_KEY)
  const lastInteractRef = useRef(Date.now())

  // —— UI state ——
  const [status, setStatus] = useState<'boot' | 'ready' | 'error'>('boot')
  const [statusText, setStatusText] = useState('')
  const [evtCount, setEvtCount] = useState(0)
  const [hoverClose, setHoverClose] = useState(false)
  const [bubble, setBubble] = useState<{ text: string; key: number } | null>(null)
  const [pops, setPops] = useState<Array<{ id: number; text: string; x: number; y: number }>>([])
  const [menuOpen, setMenuOpen] = useState(false)
  const [soundOn, setSoundOn] = useState(true)
  const [aiWhisperOn, setAiWhisperOn] = useState(true)
  const [voiceOn, setVoiceOn] = useState(false)
  const [chatOpen, setChatOpen] = useState(false)
  const [chatLog, setChatLog] = useState<Array<{ role: 'user' | 'pet'; text: string }>>([])
  const [chatBusy, setChatBusy] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const bubbleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // —— 系统通知（失焦 AI 回话；60s 限频；排除本页会话）——
  const { notifyOn, toggleNotify, restoreNotifyPref } = useSystemNotify({ whisperSessionRef, chatSessionRef })

  // 运行时诊断钩子（验收用只读快照 + 强制触发；window 上以双下划线命名空间挂载）
  const initDoneRef = useRef(false)
  const lastSleepCheckRef = useRef<{ at: number; h: number; mode: string; idleMs: number; fired: boolean } | null>(null)
  const enterSleepRef = useRef<() => void>(() => {})
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__petOverlayDebug = {
      get state() {
        return {
          mode: modeRef.current, sleeping: sleepingRef.current, busy: busyRef.current,
          anim: currentAnimRef.current, evtAt: lastEvtAtRef.current,
          initDone: initDoneRef.current,
          lastSleepCheck: lastSleepCheckRef.current,
          timers: { roll: !!chainRollTimer.current, sleepChecker: !!sleepCheckerRef.current, whisper: !!whisperTimerRef.current },
        }
      },
      forceSleep() { enterSleepRef.current() },
      forceWalk() { planWalkRef.current() },
    }
  }, [])

  const showBubble = useCallback((text: string, ms = 4200) => {
    if (bubbleTimer.current) clearTimeout(bubbleTimer.current)
    setBubble({ text, key: Date.now() })
    bubbleTimer.current = setTimeout(() => setBubble(null), ms)
  }, [])

  const showPop = useCallback((text: string, x: number, y: number) => {
    const id = Date.now() + Math.random()
    setPops((p) => [...p.slice(-4), { id, text, x, y }])
    setTimeout(() => setPops((p) => p.filter((i) => i.id !== id)), 900)
  }, [])

  const speak = makeSpeak(voiceOnRef)

  const playSound = useCallback(() => {
    if (!soundOnRef.current || !baseRef.current) return
    try {
      if (!audioRef.current) audioRef.current = new Audio(`${baseRef.current}/asset/sound/click-duck.wav`)
      audioRef.current.currentTime = 0
      void audioRef.current.play().catch(() => { /* 静默：没有声音也不该有报错 */ })
    } catch { /* 同上 */ }
  }, [])

  /** Q 弹挤压：贴地压扁回弹（transform，零素材）；尊重系统减少动效。 */
  const squash = useCallback(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const el = front.current === 'a' ? videoA.current : videoB.current
    if (!el) return
    const myGen = ++motionGenRef.current
    if (motionRafRef.current) cancelAnimationFrame(motionRafRef.current)
    const t0 = performance.now()
    const tick = (now: number) => {
      if (myGen !== motionGenRef.current) { el.style.transform = ''; return }
      const t = (now - t0) / 1000
      if (t >= 0.42) { el.style.transform = ''; motionRafRef.current = null; return }
      const s = Math.sin(t / 0.42 * Math.PI) * 0.12 * (1 - t / 0.42)
      el.style.transform = `scale(${1 + s}, ${1 - s})`
      el.style.transformOrigin = '50% 96%'
      motionRafRef.current = requestAnimationFrame(tick)
    }
    motionRafRef.current = requestAnimationFrame(tick)
  }, [])

  /** 屏幕钳制：任意落点必须保持窗口完整可见（原版 clampReachableBox）。 */
  const clampPos = useCallback((x: number, y: number): { x: number; y: number } => {
    const wa = workAreaRef.current
    if (!wa) return { x, y }
    const { w, h } = winSizeRef.current
    const cx = Math.min(Math.max(x, wa.x), wa.x + wa.w - w)
    const cy = Math.min(Math.max(y, wa.y), wa.y + wa.h - h)
    return { x: cx, y: cy }
  }, [])

  const savePos = useCallback((x: number, y: number) => {
    void kvSet(posKeyRef.current, { x: Math.round(x), y: Math.round(y) })
  }, [])

  /** 双缓冲换源。once=false 表示循环段：ended=前台被顶 → 重新点名 loop（原版不变量）。 */
  const switchTo = useCallback(async (anim: string, opts: { loop?: boolean; onEnded?: () => void } = {}) => {
    const myGen = ++videoGen.current
    const frontEl = front.current === 'a' ? videoA.current : videoB.current
    const backEl = front.current === 'a' ? videoB.current : videoA.current
    if (!frontEl || !backEl) return
    currentAnimRef.current = anim
    backEl.onended = opts.onEnded ?? null
    backEl.loop = !!opts.loop
    backEl.src = assetUrl(baseRef.current, anim)
    try { await backEl.play() } catch { /* muted 下仍可能被策略拒绝 */ }
    await new Promise<void>((resolve) => {
      if (backEl.readyState >= 2) return resolve()
      const h = () => { backEl.removeEventListener('loadeddata', h); resolve() }
      backEl.addEventListener('loadeddata', h)
      setTimeout(resolve, 5000)
    })
    if (myGen !== videoGen.current) return
    frontEl.pause()
    frontEl.style.display = 'none'
    backEl.style.display = 'block'
    front.current = front.current === 'a' ? 'b' : 'a'
    // 自动播放策略拒绝 play() 后视频会停在 0 帧（paused=true），ended 永不触发，
    // 整条随机链死锁——换源后立即复查播放态（看门狗兜底见下）。
    if (backEl.paused) void backEl.play().catch(() => { /* 看门狗与手势解锁兜底 */ })
  }, [])

  const stopMotion = useCallback(() => {
    if (motionRafRef.current) { cancelAnimationFrame(motionRafRef.current); motionRafRef.current = null }
    motionGenRef.current++
  }, [])

  // ---------- 随机链（定时掷骰推进，原版 next-animation 语义） ----------
  // idle/turn 是循环段：ended 永不触发 → 链必须靠定时器推进，否则永远停在待机
  // （v0.5.0 修的真 bug：onEnded 驱动链在循环段上死锁，类别动作/走位全被堵死）。
  // chain ↔ planWalk 互递归经 ref 解开。
  const chainRef = useRef<() => void>(() => {})
  const planWalkRef = useRef<() => void>(() => {})
  const chainRollTimer = useRef<number | null>(null)
  const clearRollTimer = useCallback(() => {
    if (chainRollTimer.current) { clearTimeout(chainRollTimer.current); chainRollTimer.current = null }
  }, [])

  const beginLoop = useCallback((anim: string) => {
    if (modeRef.current !== 'chain' || sleepingRef.current) return
    currentAnimRef.current = anim
    void switchTo(anim, { loop: true, onEnded: () => { void switchTo(anim, { loop: true, onEnded: () => beginLoopRef.current(anim) }) } })
    clearRollTimer()
    chainRollTimer.current = window.setTimeout(() => {
      if (modeRef.current !== 'chain' || sleepingRef.current) return
      const roll = rollChain(currentAnimRef.current)
      if (roll.move) { planWalkRef.current(); return }
      if (roll.once) {
        void switchTo(roll.anim, { onEnded: () => beginLoopRef.current(pick(IDLE)) })
      } else {
        beginLoopRef.current(roll.anim)  // 循环段之间也换着来（idle↔turn）
      }
    }, 8000 + Math.random() * 9000)
  }, [switchTo, clearRollTimer])
  const beginLoopRef = useRef<(anim: string) => void>(() => {})

  const chain = useCallback(() => {
    if (modeRef.current !== 'chain' || sleepingRef.current) return
    clearRollTimer()
    const roll = rollChain(currentAnimRef.current)
    if (roll.move) { planWalkRef.current(); return }
    if (roll.once) {
      void switchTo(roll.anim, { onEnded: () => beginLoopRef.current(pick(IDLE)) })
    } else {
      beginLoopRef.current(roll.anim)
    }
  }, [switchTo, clearRollTimer])

  useEffect(() => {
    chainRef.current = chain
    planWalkRef.current = planWalk
    beginLoopRef.current = beginLoop
    enterSleepRef.current = enterSleep
  })

  // ---------- 自主走位 ----------
  const planWalk = useCallback(() => {
    if (motionRafRef.current) { chain(); return }   // 单一运动不变量：有运动在跑就退回原地动作
    const move = pick(MOVES)
    const wa = workAreaRef.current
    if (!wa) { chain(); return }
    const dpr = window.devicePixelRatio || 1
    const scale = winSizeRef.current.w / (462 * dpr) || 1   // 原版基准宽度 462 CSS px
    const dist = (move.minDist + Math.random() * (move.maxDist - move.minDist)) * dpr * Math.max(scale, 0.6)
    const dir = Math.random() < 0.5 ? -1 : 1
    void (async () => {
      const win = getCurrentWebviewWindow()
      const cur = await win.outerPosition().catch(() => null)
      if (!cur) { chain(); return }
      const from = { x: cur.x, y: cur.y }
      // 目标越界 → 收缩距离；贴边无可走 → 退回原地动作（原版 move-action 语义）
      let target = clampPos(from.x + dir * dist, from.y)
      if (Math.abs(target.x - from.x) < 24) target = clampPos(from.x - dir * dist, from.y)
      if (Math.abs(target.x - from.x) < 24) { chain(); return }
      modeRef.current = 'walk'
      const myGen = ++motionGenRef.current
      if (motionRafRef.current) cancelAnimationFrame(motionRafRef.current)
      await switchTo(move.name, {})
      const el = front.current === 'a' ? videoA.current : videoB.current
      const duration = el && isFinite(el.duration) && el.duration > 0 ? el.duration : 4
      const t0 = performance.now()
      const lead = Math.min(move.leadSec, duration * 0.3)
      const tail = Math.min(move.tailSec, duration * 0.3)
      const tick = () => {
        if (myGen !== motionGenRef.current || modeRef.current !== 'walk') return
        const el2 = front.current === 'a' ? videoA.current : videoB.current
        const t = el2 && el2.duration ? el2.currentTime : (performance.now() - t0) / 1000
        const p = Math.min(Math.max((t - lead) / Math.max(duration - lead - tail, 0.5), 0), 1)
        const x = from.x + (target.x - from.x) * p
        void win.setPosition(new PhysicalPosition(Math.round(x), Math.round(from.y))).catch(() => {})
        if (p >= 1 || t >= duration) {
          motionRafRef.current = null
          modeRef.current = 'chain'
          savePos(target.x, target.y)
          chain()
          return
        }
        motionRafRef.current = requestAnimationFrame(tick)
      }
      motionRafRef.current = requestAnimationFrame(tick)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, switchTo, clampPos, savePos, squash])

  // ---------- 抛飞（flight） ----------
  const startFlight = useCallback((vx: number, vy: number) => {
    const wa = workAreaRef.current
    if (!wa) { squash(); chain(); return }
    modeRef.current = 'flight'
    const myGen = ++motionGenRef.current
    if (motionRafRef.current) cancelAnimationFrame(motionRafRef.current)
    const dpr = window.devicePixelRatio || 1
    const g = GRAVITY * dpr
    void (async () => {
      const win = getCurrentWebviewWindow()
      const cur = await win.outerPosition().catch(() => null)
      if (!cur) { modeRef.current = 'chain'; squash(); chain(); return }
      let { x, y } = cur
      let velX = vx, velY = vy
      const { w, h } = winSizeRef.current
      const floor = wa.y + wa.h - h
      const ceiling = wa.y
      const left = wa.x
      const right = wa.x + wa.w - w
      let last = performance.now()
      const tick = (now: number) => {
        if (myGen !== motionGenRef.current || modeRef.current !== 'flight') return
        const dt = Math.min((now - last) / 1000, 0.05)
        last = now
        velY += g * dt
        x += velX * dt
        y += velY * dt
        let bounced = false
        if (y >= floor) { y = floor; velY = -velY * RESTITUTION; bounced = velY < -50 }
        if (y <= ceiling && velY < 0) { y = ceiling; velY = -velY * RESTITUTION }
        if (x <= left && velX < 0) { x = left; velX = -velX * RESTITUTION }
        if (x >= right && velX > 0) { x = right; velX = -velX * RESTITUTION }
        if (y >= floor - 0.5) velX *= Math.exp(-GROUND_FRICTION * dt)
        void win.setPosition(new PhysicalPosition(Math.round(x), Math.round(y))).catch(() => {})
        if (y >= floor - 0.5 && !bounced && Math.abs(velX) < 30 * dpr && Math.abs(velY) < 50 * dpr) {
          motionRafRef.current = null
          modeRef.current = 'chain'
          savePos(x, y)
          squash()
          chain()
          return
        }
        motionRafRef.current = requestAnimationFrame(tick)
      }
      motionRafRef.current = requestAnimationFrame(tick)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain, squash, clampPos, savePos])

  // ---------- 睡觉机 ----------
  const enterSleep = useCallback(() => {
    if (sleepingRef.current || modeRef.current !== 'chain') return
    sleepingRef.current = true
    modeRef.current = 'sleep'
    clearRollTimer()
    showBubble(SLEEP_START_TEXT, 3600)
    void switchTo(SLEEP.start[0], { onEnded: () => {
      // 循环段：ended=前台被顶 → 重新点名 loop（原版不变量）
      void switchTo(SLEEP.loop[0], { loop: true, onEnded: () => { void switchTo(SLEEP.loop[0], { loop: true, onEnded: () => { void switchTo(SLEEP.loop[0], { loop: true }) } }) } })
    } })
    if (sleepTimerRef.current) clearInterval(sleepTimerRef.current)
    sleepTimerRef.current = setInterval(() => { if (sleepingRef.current) showBubble(pick(SLEEP_TALK), 3600) }, 60000)
  }, [switchTo, showBubble, clearRollTimer])

  const wakeFromSleep = useCallback(() => {
    if (!sleepingRef.current) return false
    sleepingRef.current = false
    if (sleepTimerRef.current) { clearInterval(sleepTimerRef.current); sleepTimerRef.current = null }
    modeRef.current = 'chain'
    void switchTo(SLEEP.end[0], { onEnded: () => chain() })
    return true
  }, [switchTo, chain])

  // ---------- 指针交互 ----------
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return
    // 用户手势是自动播放的解锁点：顺带恢复可能被策略暂停的画面
    const el = front.current === 'a' ? videoA.current : videoB.current
    if (el && el.paused && !el.ended) void el.play().catch(() => {})
    setMenuOpen(false)
    lastInteractRef.current = Date.now()
    if (sleepingRef.current) { wakeFromSleep(); return }
    if (modeRef.current === 'walk') { stopMotion(); modeRef.current = 'chain' }  // 点按打断走位（原版停走语义）
    drag.current = { startX: e.clientX, startY: e.clientY, moved: false, downT: performance.now() }
  }, [wakeFromSleep, stopMotion])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!drag.current || drag.current.moved) return
    const dx = e.clientX - drag.current.startX
    const dy = e.clientY - drag.current.startY
    if (dx * dx + dy * dy > DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) {
      drag.current.moved = true
      modeRef.current = 'drag'
      stopMotion()
      // 抓起挣扎动画（循环段；ended=被顶 → 重新点名）
      void switchTo(DRAG[0], { loop: true, onEnded: () => { if (modeRef.current === 'drag') void switchTo(DRAG[0], { loop: true, onEnded: () => { if (modeRef.current === 'drag') void switchTo(DRAG[0], { loop: true }) } }) } })
      if ('__TAURI_INTERNALS__' in window) {
        try { void getCurrentWebviewWindow().startDragging() } catch { /* 环境缺失则忽略 */ }
      }
    }
  }, [switchTo, stopMotion])

  /** 松手结算：低速=原地落地；高速=抛飞。速度取自 onMoved 轨迹（OS 拖拽期指针事件不可得）。 */
  const settleDrag = useCallback(() => {
    modeRef.current = 'chain'
    const traj = trajRef.current
    trajRef.current = []
    let vx = 0, vy = 0
    if (traj.length >= 2) {
      const first = traj[0]
      const last = traj[traj.length - 1]
      const dt = last.t - first.t
      if (dt > 8) {
        vx = (last.x - first.x) / dt
        vy = (last.y - first.y) / dt
      }
    }
    if (Math.hypot(vx, vy) > THROW_MIN_SPEED) {
      startFlight(vx, vy)
    } else {
      void (async () => {
        if ('__TAURI_INTERNALS__' in window) {
          const cur = await getCurrentWebviewWindow().outerPosition().catch(() => null)
          if (cur) savePos(cur.x, cur.y)
        }
        squash()
        chain()
      })()
    }
  }, [startFlight, squash, chain, savePos])

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    lastInteractRef.current = Date.now()
    if (modeRef.current === 'drag') { settleDrag(); return }
    if (modeRef.current !== 'chain' && modeRef.current !== 'sleep') return
    if (d.moved) return
    // —— 点击：回应 + 手速积分 + 音效 ——
    playSound()
    const dt = performance.now() - d.downT
    const score = dt < 140 ? 3 : dt < 260 ? 2 : 1
    showPop(`+${score}`, e.clientX - 10, e.clientY - 46)
    if (sleepingRef.current) { wakeFromSleep(); return }
    void switchTo(pick(CLICKS), { onEnded: () => chain() })
  }, [switchTo, chain, playSound, showPop, settleDrag, wakeFromSleep])

  // —— 兜底：指针捕获被浏览器丢掉时，window 级收尾（原版 drag 不变量） ——
  useEffect(() => {
    const up = () => { if (drag.current) { drag.current = null; if (modeRef.current === 'drag') settleDrag() } }
    const blur = () => { drag.current = null }
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      window.removeEventListener('blur', blur)
    }
  }, [settleDrag])

  // ---------- 播放看门狗：任何原因的暂停（自动播放策略/解码打嗝）5s 内自动恢复 ----------
  useEffect(() => {
    const iv = setInterval(() => {
      if (status !== 'ready') return
      const el = front.current === 'a' ? videoA.current : videoB.current
      if (el && el.paused && !el.ended && el.readyState >= 2) void el.play().catch(() => { /* 下一轮再试 */ })
    }, 5000)
    return () => clearInterval(iv)
  }, [status])

  // 聊天记录自动滚底
  useEffect(() => {
    const el = chatLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatLog, chatBusy, chatOpen])

  // ---------- onMoved：轨迹采样（初速估计） ----------
  useEffect(() => {
    if (!('__TAURI_INTERNALS__' in window)) return
    let win: ReturnType<typeof getCurrentWebviewWindow>
    try { win = getCurrentWebviewWindow() } catch { return }
    const un = win.onMoved((evt) => {
      const now = performance.now()
      const t = trajRef.current
      t.push({ t: now, x: evt.payload.x, y: evt.payload.y })
      while (t.length && now - t[0].t > TRAJ_WINDOW_MS) t.shift()
      if (modeRef.current === 'chain' && posReady.current) {
        // 非运动态的窗口移动（用户手动/其他来源）不写 kv，避免抖动
      }
    }).catch(() => () => {})
    return () => { void un.then((f) => f()) }
  }, [])

  // ---------- R2a 工作状态联动：chat-event 有流动=AI 在忙 → 忙碌循环；安静 → 雀跃庆祝 ----------
  useEffect(() => {
    const iv = setInterval(() => {
      if (modeRef.current !== 'chain' || sleepingRef.current) return
      const now = Date.now()
      if (!busyRef.current && lastEvtAtRef.current > 0 && now - lastEvtAtRef.current < BUSY_ACTIVE_MS) {
        busyRef.current = true
        showBubble('主人忙起来了，大肥鱼陪着你～', 3000)
        const loopBusy = () => {
          if (!busyRef.current) return
          // 循环段不变量：ended=前台被顶 → 重新点名 loop
          void switchTo(pick(WORK_BUSY), { loop: true, onEnded: () => loopBusy() })
        }
        loopBusy()
      } else if (busyRef.current && now - lastEvtAtRef.current > BUSY_QUIET_MS) {
        busyRef.current = false
        void switchTo(pick(WORK_CELEBRATE), { onEnded: () => chain() })
      }
    }, 5000)
    return () => clearInterval(iv)
  }, [switchTo, chain, showBubble])

  // ---------- R2b 余额联动：今日花费 → 六档钱袋动画 + 气泡（原版 eventsRefreshSec.balance=1800s） ----------
  useEffect(() => {
    const check = async () => {
      if (modeRef.current !== 'chain' || sleepingRef.current || !('__TAURI_INTERNALS__' in window)) return
      try {
        const startOfDay = Math.floor(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate()).getTime() / 1000)
        const res = await invoke('get_usage_summary', { startDate: startOfDay })
        const wrapped = res as { totalCostUsd?: number; result?: { totalCostUsd?: number } }
        const cost = typeof wrapped?.totalCostUsd === 'number' ? wrapped.totalCostUsd : wrapped?.result?.totalCostUsd
        if (typeof cost !== 'number' || !isFinite(cost)) return
        const tier = BALANCE_TIERS.find((t) => cost >= t.min) ?? BALANCE_TIERS[BALANCE_TIERS.length - 1]
        showBubble(`今日 AI 花费 $${cost.toFixed(2)}`, 4500)
        void switchTo(pick(tier.anims), { onEnded: () => chain() })
      } catch { /* 用量库未初始化等：静默跳过（原版 playback-report 纪律：失败不抛） */ }
    }
    const t0 = setTimeout(check, 25000)
    const iv = setInterval(check, BALANCE_POLL_MS)
    return () => { clearTimeout(t0); clearInterval(iv) }
  }, [switchTo, chain, showBubble])

  // ---------- 初始化 ----------
  useEffect(() => {
    let disposed = false
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'

    // 注入飘分动画样式（一次性）
    if (!document.getElementById('pet-pop-style')) {
      const st = document.createElement('style')
      st.id = 'pet-pop-style'
      st.textContent = '@keyframes petPopUp{0%{opacity:1;transform:translateY(0)}100%{opacity:0;transform:translateY(-34px)}}'
      document.head.appendChild(st)
    }

    let unlisten: Promise<() => void> | null = null
    if ('__TAURI_INTERNALS__' in window) {
      unlisten = listen('chat-event', () => {
        lastEvtAtRef.current = Date.now()
        setEvtCount((c) => c + 1)
      }).catch(() => () => {})
    }

    ;(async () => {
      // 工作区与窗口物理尺寸（钳制基准）；多开槽位（label→位置记忆 key 隔离）
      if ('__TAURI_INTERNALS__' in window) {
        try {
          const { slot, posKey } = await resolveSlot()
          slotRef.current = slot
          posKeyRef.current = posKey
        } catch { /* 单开形态 */ }
        try {
          const mon = await currentMonitor()
          if (mon) workAreaRef.current = { x: mon.position.x, y: mon.position.y, w: mon.size.width, h: mon.size.height }
        } catch { /* 无监视器信息则不钳制 */ }
        try {
          const s = await getCurrentWebviewWindow().outerSize()
          winSizeRef.current = { w: s.width, h: s.height }
        } catch { /* 用默认 450×450 */ }
      }
      const base = await pickBase()
      if (disposed) return
      if (!base) {
        setStatus('error')
        setStatusText(`资源服务未就绪（端口 ${await resolvePort()}）；点击此提示重试`)
        return
      }
      baseRef.current = base
      setStatus('ready')

      // 声音开关偏好
      const pref = await kvGet(KV_SOUND_KEY)
      if (typeof pref === 'boolean') { soundOnRef.current = pref; setSoundOn(pref) }
      // AI 碎碎念开关偏好 + 会话续接
      const aiPref = await kvGet(KV_AI_WHISPER_KEY)
      if (typeof aiPref === 'boolean') { aiWhisperOnRef.current = aiPref; setAiWhisperOn(aiPref) }
      const savedSession = await kvGet(KV_WHISPER_SESSION_KEY)
      if (typeof savedSession === 'string' && savedSession) whisperSessionRef.current = savedSession
      // 语音开关 + 宠物对话会话续接
      const voicePref = await kvGet(KV_VOICE_KEY)
      if (typeof voicePref === 'boolean') { voiceOnRef.current = voicePref; setVoiceOn(voicePref) }
      const savedChat = await kvGet(KV_CHAT_SESSION_KEY)
      if (typeof savedChat === 'string' && savedChat) chatSessionRef.current = savedChat
      // 通知开关
      await restoreNotifyPref()

      // 位置还原（钳制后）→ 播 idle → 开链
      const pos = await kvGet(posKeyRef.current)
      if (disposed) return
      if (pos && typeof pos === 'object' && '__TAURI_INTERNALS__' in window) {
        const { x, y } = pos as { x?: number; y?: number }
        if (typeof x === 'number' && typeof y === 'number') {
          const c = clampPos(x, y)
          try { await getCurrentWebviewWindow().setPosition(new PhysicalPosition(Math.round(c.x), Math.round(c.y))) } catch { /* 还原失败用默认位 */ }
        }
      }
      posReady.current = true
      if (disposed) return
      // 起随机链（idle 段 + 定时掷骰推进）——直接 switchTo 会让链永远停在待机
      modeRef.current = 'chain'
      chainRef.current()

      // 夜间睡觉检查（每分钟）；碎碎念每 5min
      const sleepCheck = () => {
        const h = new Date().getHours()
        const idleMs = Date.now() - lastInteractRef.current
        const fired = (h >= 23 || h < 7) && modeRef.current === 'chain' && !sleepingRef.current && idleMs > 30000
        lastSleepCheckRef.current = { at: Date.now(), h, mode: modeRef.current, idleMs, fired }
        if (fired) enterSleep()
      }
      sleepCheck()
      sleepCheckerRef.current = setInterval(sleepCheck, 60000)
      whisperTimerRef.current = setInterval(() => {
        if (modeRef.current === 'chain' && !sleepingRef.current) {
          void aiWhisper().then((ok) => { if (!ok) showBubble(pick(WHISPERS), 4500) })
        }
      }, 300000)
      setTimeout(() => { if (modeRef.current === 'chain' && !sleepingRef.current) showBubble(pick(WHISPERS), 4500) }, 6000)
      initDoneRef.current = true
    })()

    return () => {
      disposed = true
      posReady.current = false
      stopMotion()
      clearRollTimer()
      if (sleepTimerRef.current) clearInterval(sleepTimerRef.current)
      if (sleepCheckerRef.current) clearInterval(sleepCheckerRef.current)
      if (whisperTimerRef.current) clearInterval(whisperTimerRef.current)
      if (unlisten) void unlisten.then((f) => f())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- video 解码失败：idle 失败进错误态，其余跳过回链 ----------
  const onVideoError = useCallback((e: React.SyntheticEvent<HTMLVideoElement>) => {
    const src = String(e.currentTarget.src || '')
    const anim = decodeURIComponent(src.split('/').pop() || '').replace(/\.webm$/, '')
    if (!anim || IDLE.includes(anim)) {
      setStatus('error')
      setStatusText(`待机动画加载失败：${anim || '未知资源'}；点击此提示重试`)
      return
    }
    // 单文件失败跳过：直接回随机链（原版鲁棒性）
    if (modeRef.current === 'drag') return
    modeRef.current = 'chain'
    chain()
  }, [chain])

  const retry = useCallback(() => { setStatus('boot'); setStatusText(''); window.location.reload() }, [])

  const centerWindow = useCallback(() => {
    const wa = workAreaRef.current
    if (!wa || !('__TAURI_INTERNALS__' in window)) return
    const { w, h } = winSizeRef.current
    const x = wa.x + Math.round((wa.w - w) / 2)
    const y = wa.y + Math.round((wa.h - h) / 2)
    void getCurrentWebviewWindow().setPosition(new PhysicalPosition(x, y)).then(() => savePos(x, y)).catch(() => {})
  }, [savePos])

  const toggleSound = useCallback(() => {
    const next = !soundOnRef.current
    soundOnRef.current = next
    setSoundOn(next)
    void kvSet(KV_SOUND_KEY, next)
    setMenuOpen(false)
  }, [])

  const toggleAiWhisper = useCallback(() => {
    const next = !aiWhisperOnRef.current
    aiWhisperOnRef.current = next
    setAiWhisperOn(next)
    void kvSet(KV_AI_WHISPER_KEY, next)
    setMenuOpen(false)
  }, [])

  // ---------- R2c AI 碎碎念：单一宠物会话复用（方案③），30s 超时/失败回退离线文案 ----------
  const aiWhisper = useCallback(async (): Promise<boolean> => {
    if (!aiWhisperOnRef.current || !('__TAURI_INTERNALS__' in window)) return false
    try {
      // 流式路径（2026-11-04 改造，方案 A）：start/continue 改走 router_dispatch_stream，
      // 不占后端 spawn_blocking 池（原同步 router_dispatch 在慢启动引擎下触发 10s 楔死告警）。
      // start 时 sessionId 不在 ack 内，由 streamChat 从 chat-event 的 session_start 事件提取；
      // continue 时 sid 由调用方持有，streamChat 直接订阅过滤。
      const hasSession = !!whisperSessionRef.current
      const { sid, text } = await streamChat({
        action: hasSession ? 'continue' : 'start',
        message: WHISPER_PROMPT,
        ...(hasSession ? { sessionId: whisperSessionRef.current! } : {}),
        options: { engineId: AI_ENGINE_ID },
        timeoutMs: AI_WHISPER_TIMEOUT_MS,
      })
      // start 才落 sid；continue 沿用 ref（sid 为入参原值）
      if (!hasSession && sid) {
        whisperSessionRef.current = sid
        void kvSet(KV_WHISPER_SESSION_KEY, sid)
      }
      if (text) { showBubble(text.slice(0, 60), 5200); speak(text.slice(0, 60)); return true }
      return false
    } catch { return false }
  }, [showBubble, speak])

  // ---------- R2d 宠物对话：独立会话 + 人设 systemPrompt（原版 chatModel 等价） ----------
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim()
    if (!msg || chatBusy || !('__TAURI_INTERNALS__' in window)) return
    setChatBusy(true)
    setChatLog((l) => [...l, { role: 'user', text: msg }])
    setChatInput('')
    try {
      // 流式路径（2026-11-04 改造，方案 A）：start/continue 改走 router_dispatch_stream，
      // 不占后端 spawn_blocking 池（原同步 router_dispatch 在慢启动引擎下触发 10s 楔死告警）。
      // start 时 sessionId 由 streamChat 从 chat-event 的 session_start 事件提取；
      // continue 时 sid 由调用方持有。
      const first = chatSessionRef.current === null
      const { sid, text } = await streamChat({
        action: first ? 'start' : 'continue',
        message: msg,
        ...(!first ? { sessionId: chatSessionRef.current! } : {}),
        options: { systemPrompt: PET_PERSONA, enableMcpTools: false, engineId: AI_ENGINE_ID },
        timeoutMs: CHAT_TIMEOUT_MS,
      })
      if (first) {
        if (!sid) throw new Error('会话创建失败')
        chatSessionRef.current = sid
        void kvSet(KV_CHAT_SESSION_KEY, sid)
      }
      if (text) { setChatLog((l) => [...l, { role: 'pet', text: text }]); speak(text) }
      else { setChatLog((l) => [...l, { role: 'pet', text: '（鱼脑子转了一圈，什么也没说…再试试？）' }]) }
    } catch (e) {
      setChatLog((l) => [...l, { role: 'pet', text: `（游不动了：${String(e instanceof Error ? e.message : e).slice(0, 60)}）` }])
    } finally {
      setChatBusy(false)
    }
  }, [chatInput, chatBusy, speak])

  const toggleVoice = useCallback(() => {
    const next = !voiceOnRef.current
    voiceOnRef.current = next
    setVoiceOn(next)
    void kvSet(KV_VOICE_KEY, next)
    setMenuOpen(false)
  }, [])

  const openAnother = useCallback(() => {
    setMenuOpen(false)
    const api = (window as unknown as { __POLARIS_PET_OVERLAY__?: { openNext(): Promise<string> } }).__POLARIS_PET_OVERLAY__
    if (api) void api.openNext().then((r) => { if (String(r) === 'full') window.alert('最多同时养 9 只（8 个副位都满了）') }).catch(() => {})
  }, [])

  return (
    <div
      ref={rootRef}
      style={{
        position: 'fixed', inset: 0, background: 'transparent', overflow: 'hidden',
        cursor: status === 'ready' ? 'grab' : 'default', userSelect: 'none', touchAction: 'none',
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onContextMenu={(e) => { e.preventDefault(); if (status === 'ready') setMenuOpen(true) }}
      onMouseEnter={() => setHoverClose(true)}
      onMouseLeave={() => { setHoverClose(false); setMenuOpen(false) }}
    >
      <video ref={videoA} muted playsInline preload="auto" onError={onVideoError}
        style={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />
      <video ref={videoB} muted playsInline preload="auto" onError={onVideoError}
        style={{ display: 'none', width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }} />

      {bubble && (
        <div key={bubble.key} style={{
          position: 'absolute', left: '50%', top: 6, transform: 'translateX(-50%)',
          maxWidth: '86%', boxSizing: 'border-box', zIndex: 20,
          background: 'rgba(240, 246, 255, 0.94)', color: '#0b2545',
          border: '1px solid #9fc3ea', borderRadius: 10, borderBottomLeftRadius: 2,
          padding: '5px 10px', fontSize: 12, lineHeight: 1.5,
          boxShadow: '0 2px 8px rgba(0,0,0,0.25)', whiteSpace: 'pre-wrap',
          pointerEvents: 'none',
        }}>{bubble.text}</div>
      )}

      {pops.map((p) => (
        <div key={p.id} style={{
          position: 'absolute', left: p.x, top: p.y, zIndex: 25, pointerEvents: 'none',
          color: '#ffd66b', fontWeight: 700, fontSize: 15, textShadow: '0 1px 3px rgba(0,0,0,0.6)',
          animation: 'petPopUp 0.9s ease-out forwards',
        }}>{p.text}</div>
      ))}

      {hoverClose && (
        <button
          onClick={(e) => { e.stopPropagation(); if ('__TAURI_INTERNALS__' in window) { void getCurrentWebviewWindow().close().catch(() => {}) } }}
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', top: 4, right: 6, width: 22, height: 22, borderRadius: 11, zIndex: 40,
            border: 'none', background: 'rgba(8, 15, 30, 0.85)', color: '#fff', fontSize: 13,
            lineHeight: '22px', cursor: 'pointer', padding: 0,
          }}
          title="关闭悬浮窗"
        >✕</button>
      )}

      {menuOpen && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', right: 8, top: 30, zIndex: 50, minWidth: 128,
            background: 'rgba(13, 22, 38, 0.96)', border: '1px solid #2b4a7a', borderRadius: 8,
            padding: 4, boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
          }}
        >
          {[
            { label: soundOn ? '🔊 音效：开' : '🔇 音效：关', act: toggleSound },
            { label: aiWhisperOn ? '🤖 AI 碎碎念：开' : '🤖 AI 碎碎念：关', act: toggleAiWhisper },
            { label: voiceOn ? '🗣 语音：开' : '🗣 语音：关', act: toggleVoice },
            { label: notifyOn ? '🔔 通知：开' : '🔔 通知：关', act: () => { toggleNotify(); setMenuOpen(false) } },
            { label: '➕ 再养一只', act: openAnother },
            { label: '💬 和它聊聊', act: () => { setMenuOpen(false); setChatOpen(true) } },
            { label: '🎯 回屏幕中央', act: () => { setMenuOpen(false); centerWindow() } },
            { label: '✕ 关闭悬浮窗', act: () => { setMenuOpen(false); if ('__TAURI_INTERNALS__' in window) void getCurrentWebviewWindow().close().catch(() => {}) } },
          ].map((it) => (
            <div key={it.label}
              onClick={it.act}
              style={{ padding: '6px 10px', fontSize: 12, color: '#cfe3ff', cursor: 'pointer', borderRadius: 5 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'rgba(59,130,246,0.25)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
            >{it.label}</div>
          ))}
        </div>
      )}

      {chatOpen && (
        <div
          onPointerDown={(e) => e.stopPropagation()}
          onPointerUp={(e) => e.stopPropagation()}
          onPointerMove={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.stopPropagation()}
          style={{
            position: 'absolute', left: 8, right: 8, top: '34%', bottom: 22, zIndex: 60,
            background: 'rgba(10, 18, 34, 0.96)', border: '1px solid #2b4a7a', borderRadius: 12,
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            boxShadow: '0 6px 20px rgba(0,0,0,0.45)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid #1f3355' }}>
            <span style={{ fontSize: 12, color: '#9fd0ff', fontWeight: 600 }}>💬 和大肥鱼聊聊</span>
            <button
              onClick={() => setChatOpen(false)}
              onPointerDown={(e) => e.stopPropagation()}
              style={{ marginLeft: 'auto', border: 'none', background: 'transparent', color: '#7d8590', cursor: 'pointer', fontSize: 13 }}
            >✕</button>
          </div>
          <div ref={chatLogRef} style={{ flex: 1, overflowY: 'auto', padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {chatLog.length === 0 && (
              <div style={{ fontSize: 11, color: '#7d8590' }}>跟它说句话吧——它记得住你们聊过的内容（原版 chatModel 同款记忆会话）</div>
            )}
            {chatLog.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%', fontSize: 12, lineHeight: 1.5, padding: '4px 8px', borderRadius: 8,
                background: m.role === 'user' ? 'rgba(59,130,246,0.35)' : 'rgba(240,246,255,0.12)',
                color: m.role === 'user' ? '#dbeafe' : '#e6edf3', whiteSpace: 'pre-wrap',
              }}>{m.text}</div>
            ))}
            {chatBusy && <div style={{ fontSize: 11, color: '#7d8590' }}>大肥鱼在想…</div>}
          </div>
          <div style={{ display: 'flex', gap: 6, padding: 6, borderTop: '1px solid #1f3355' }}>
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) void sendChat() }}
              placeholder="说点什么…"
              style={{
                flex: 1, fontSize: 12, padding: '5px 8px', borderRadius: 6, border: '1px solid #2b4a7a',
                background: 'rgba(8,15,30,0.8)', color: '#e6edf3', outline: 'none', minWidth: 0,
              }}
            />
            <button
              onClick={() => void sendChat()}
              disabled={chatBusy || !chatInput.trim()}
              style={{
                fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #3b82f6',
                background: 'rgba(59,130,246,0.25)', color: '#dbeafe', cursor: 'pointer',
                opacity: chatBusy || !chatInput.trim() ? 0.5 : 1,
              }}
            >发</button>
          </div>
        </div>
      )}

      {status !== 'ready' && (
        <div onClick={status === 'error' ? retry : undefined} style={{ position: 'absolute', inset: 0, cursor: status === 'error' ? 'pointer' : 'default', zIndex: 35 }}>
          <StatusPill tone={status === 'error' ? 'error' : 'info'}
            text={status === 'boot' ? '大肥鱼正在游过来…' : statusText} />
        </div>
      )}

      <div style={{
        position: 'absolute', left: 6, bottom: 4, fontSize: 10, padding: '1px 6px', borderRadius: 6, zIndex: 15,
        background: 'rgba(8, 15, 30, 0.75)', color: 'rgba(190, 215, 255, 0.75)', pointerEvents: 'none',
      }}>
        {VERSION_TAG} · 事件:{evtCount}
      </div>
    </div>
  )
}

export function PetOverlayApp() {
  return (
    <OverlayErrorBoundary>
      <PetOverlayInner />
    </OverlayErrorBoundary>
  )
}

export default PetOverlayApp
