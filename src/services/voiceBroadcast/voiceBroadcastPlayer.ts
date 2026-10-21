/**
 * voiceBroadcast — 句级播放器（预取流水线 + 代际打断）
 *
 * 职责：维护「已清洗、待合成/待播放」的句队列；队头就绪即播放；
 * 播放的同时后台预取后续句（PREFETCH_DEPTH），消除「播完等生成」长静默。
 *
 * 所有权（对齐 spec §2.2）：
 * - 队列增删 / 清空 / 播放打点只经本播放器 action。
 * - 合成走 cap.mcp（mimo-tts），不经 ttsService（edge-tts）。
 * - stop()：generation++ + 清队列 + 中止在途合成 + audio.pause()，
 *   晚到音频（旧代）校验 gen 不符即丢弃不播。
 *
 * 播放：浏览器原生 `<audio>`（桌面 + 移动端共用），无需 Web Audio，手机锁屏可播。
 */
import { generateUUID } from '@/utils/uuid'
import { createLogger } from '@/utils/logger'
import { PREFETCH_DEPTH, SYNTH_TIMEOUT_MS, BASE64_PREFETCH_DEPTH, BASE64_SYNTH_TIMEOUT_MS, SYNTH_MAX_RETRIES } from './constants'
import { synthesizeVoice, buildAudioPlayUrl } from './voiceService'
import type { SynthResult } from './voiceService'
import { SynthCache, synthCacheKey } from './synthCache'
import type { QueueItem, RadioBroadcastTranscript } from './types'

const log = createLogger('VoiceBroadcastPlayer')

/** MediaSession 最小类型（局部定义，避免依赖较新 DOM lib 的媒体会话类型） */
interface MediaSessionLike {
  metadata: unknown
  playbackState: string
  setActionHandler: (action: 'play' | 'pause' | 'stop', handler: (() => void) | null) => void
}

export interface PlayerCallbacks {
  /** 开始播放某句（UI 打点；meta = 合成 meta，供控制器/入库用） */
  onStart?: (text: string, meta?: { audioId?: string | null; file?: string | null }) => void
  /** 一句播放结束 */
  onEnd?: () => void
  /** 队列已空且无在途合成（段尾/停止时触发，供控制器请求下一段或进入 idle） */
  onQueueDrained?: () => void
  /** 合成失败（单句跳过，不中断整体） */
  onSynthError?: (item: QueueItem, error: string) => void
  /** 队列空但仍有在途合成（供控制器判断 generating 子状态） */
  onPendingSynth?: (count: number) => void
  /** 锁屏 MediaSession stop 手势（P0-4）：转交控制器走三路中断 */
  onStopRequest?: () => void
}

/**
 * 按句末标点切分句子（保留可朗读的语义单元）。
 * 与 streamingTts 的 splitSentences 一致（该函数未导出，此处自带）。
 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?；;\n])/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export class VoiceBroadcastPlayer {
  /** 句队列（只经本类 action 修改） */
  private queue: QueueItem[] = []
  /** 代际：stop() 时 ++，晚到音频 / 晚到 onended 校验用 */
  private generation = 0
  /** 当前播放的 audio 元素 */
  private audio: HTMLAudioElement | null = null
  /** 当前播放句 */
  private current: QueueItem | null = null
  /** 在途合成（<itemId, AbortController>），stop 时中止 */
  private pendingSynths = new Map<string, AbortController>()
  private callbacks: PlayerCallbacks = {}
  private voice?: string
  private style?: string
  /** base64 模式（移动端）：合成结果走 audioDataUrl 而非插件托管 url */
  private base64Mode = false
  private volume = 1
  /** 播放倍速（P0-2）：当前音频即时生效，新建音频继承 */
  private rate = 1
  /** 锁屏会话标题（话题名，控制器 start 时注入；P0-4） */
  private mediaTitle: string | null = null
  /** 句合成缓存（P0-5 内存 L1）：key = hash(text+voice+style+outputMode)；后端 cap.voice 磁盘缓存为 L2 */
  private synthCache = new SynthCache()
  /** 已取走的 done 游标（段自动入库去重）；stop 清队列时复位 */
  private takenDoneCursor = 0

  setCallbacks(cb: PlayerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb }
  }

  setOptions(opts: { voice?: string; style?: string; base64Mode?: boolean; rate?: number; mediaTitle?: string }): void {
    this.voice = opts.voice
    this.style = opts.style
    this.base64Mode = opts.base64Mode ?? false
    if (opts.rate !== undefined) this.setRate(opts.rate)
    if (opts.mediaTitle !== undefined) this.mediaTitle = opts.mediaTitle
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.audio) this.audio.volume = this.volume
  }

  /** 播放倍速（P0-2）：对在播音频即时生效；后续新建音频在 playItem 继承 */
  setRate(rate: number): void {
    const clamped = Math.max(0.5, Math.min(4, rate))
    this.rate = clamped
    if (this.audio) this.audio.playbackRate = clamped
  }

  /** 队列长度（诊断/测试用） */
  get queueLength(): number {
    return this.queue.length
  }

  /** 是否有在途合成 */
  get hasPendingSynth(): boolean {
    return this.pendingSynths.size > 0
  }

  /** 队列中尚未就绪可播的句数（pending + synthesizing；不含 ready/播放中/done/failed）。
   *  控制器用它做「段级提前量」：低水位时提前请求 AI 下一段，播放的同时生成。 */
  get pendingCount(): number {
    return this.queue.filter((q) => q.status === 'pending' || q.status === 'synthesizing').length
  }

  get currentText(): string | null {
    return this.current?.text ?? null
  }

  /**
   * 字幕跟读文稿（P0-1）：队列即文稿（done/failed 行保留，播完即弃语义由 stop 清队列承载）。
   * 无任何可展示内容（未入队且无在播句）返回 null。
   */
  getTranscript(): RadioBroadcastTranscript | null {
    if (this.queue.length === 0 && !this.current) return null
    const currentId = this.current?.id
    const currentIndex = currentId ? this.queue.findIndex((q) => q.id === currentId) : -1
    return {
      lines: this.queue.map((q) => ({ id: q.id, text: q.text, status: q.status })),
      currentIndex,
    }
  }

  /**
   * 淡出当前音频（睡眠定时到点；线性降音量后暂停）。
   * 无在播音频（暂停中/句间隙）立即返回。期间被 stop/换句则放弃（不与代际机制打架）。
   * 只改该 audio 元素音量，不改 this.volume（下次 playItem 仍用会话音量）。
   */
  async fadeOut(ms = 3000): Promise<void> {
    const audio = this.audio
    if (!audio || ms <= 0) return
    const startVolume = audio.volume
    const step = 50
    const steps = Math.max(1, Math.floor(ms / step))
    for (let i = 1; i <= steps; i++) {
      await new Promise((r) => setTimeout(r, step))
      if (this.audio !== audio) return // 期间已 stop/换句：放弃淡出
      audio.volume = Math.max(0, startVolume * (1 - i / steps))
    }
    if (this.audio === audio) audio.pause()
  }

  /** 当前播放音频元素（音量调节等只读消费） */
  get currentAudio(): HTMLAudioElement | null {
    return this.audio
  }

  /** 已就绪（可播放）队列项数（诊断） */
  get readyCount(): number {
    return this.queue.filter((q) => q.status === 'ready').length
  }

  /**
   * 加入一段清洗后的文本：切句后逐句预取。
   * 允许重复调用（一段 AI 输出到达时追加）。
   */
  enqueueSegment(text: string): void {
    if (!text || !text.trim()) return
    const sentences = splitSentences(text)
    if (sentences.length === 0) return
    for (const sentence of sentences) {
      this.queue.push({
        id: generateUUID(),
        text: sentence,
        url: null,
        status: 'pending',
        gen: this.generation,
        synthAttempts: 0,
      })
    }
    log.debug('入队', { count: sentences.length, total: this.queue.length })
    this.pump()
  }

  /**
   * 直插就绪句（P1 续播/回听）：库单集句子经 buildAudioPlayUrl 已是可播 URL，
   * 不再走合成（零 AI 成本回听）。
   */
  enqueuePrepared(items: Array<{ text: string; playUrl: string; audioId?: string | null; file?: string | null }>): void {
    for (const it of items) {
      if (!it.playUrl) continue
      this.queue.push({
        id: generateUUID(),
        text: it.text,
        url: it.playUrl,
        status: 'ready',
        gen: this.generation,
        audioId: it.audioId ?? undefined,
        file: it.file ?? undefined,
      })
    }
    log.info('就绪句直插（回听）', { count: items.length, total: this.queue.length })
    this.pump()
  }

  /**
   * 取走自上次调用以来播完（done）且带音频文件的句子（P1 段自动入库用）。
   * 单调前移游标（done/failed 视为已消费）：永不越过未到终态的队头，
   * 避免同批内跳过未播句子。指针在 stop/clear 复位；无新增返回空数组。
   */
  takeDoneSentences(): Array<{ text: string; audioId?: string; file?: string }> {
    const out: Array<{ text: string; audioId?: string; file?: string }> = []
    while (this.takenDoneCursor < this.queue.length) {
      const q = this.queue[this.takenDoneCursor]
      // 播放按序进行：队头未到终态（done/failed）→ 后面的更没有播完，停止扫描
      if (q.status !== 'done' && q.status !== 'failed') break
      if (q.status === 'done' && q.file) {
        out.push({ text: q.text, audioId: q.audioId ?? undefined, file: q.file })
      }
      this.takenDoneCursor++
    }
    return out
  }

  /** 清空队列 + 中止在途合成（stop 路径） */
  private clear(): void {
    this.queue = []
    this.takenDoneCursor = 0
    this.pendingSynths.forEach((abort) => abort.abort())
    this.pendingSynths.clear()
  }

  /** 停止播放：代际 +1、清队列、中止合成、暂停当前音频 */
  stop(): void {
    this.generation++
    this.clear()
    if (this.audio) {
      this.audio.pause()
      this.audio.onended = null
      this.audio.onerror = null
      this.audio = null
    }
    this.current = null
    log.info('播放器停止（代际递增）', { generation: this.generation })
    this.callbacks.onQueueDrained?.()
  }

  /** 播放暂停（不中断队列与合成，移动端锁屏保活） */
  pause(): void {
    this.audio?.pause()
  }

  /** 恢复播放 */
  resume(): void {
    if (this.current && this.current.url && this.audio) {
      void this.audio.play().catch(() => { /* 恢复失败：保持状态，下次句播自然接管 */ })
    }
  }

  /**
   * 流水线主循环：
   * 1. 队头有效项（未 done/failed）若 ready 即播放；pending 则优先合成队头；
   * 2. 队列空 → 有在途合成报 onPendingSynth（generating），否则 onQueueDrained（段尾）。
   * 3. 再按 PREFETCH_DEPTH 补足预取。
   */
  private pump(): void {
    if (!this.current) {
      const head = this.queue.find((q) => q.status !== 'done' && q.status !== 'failed')
      if (!head) {
        if (this.hasPendingSynth) {
          this.callbacks.onPendingSynth?.(this.pendingSynths.size)
        } else {
          this.callbacks.onQueueDrained?.()
        }
        return
      }
      if (head.status === 'ready') {
        this.playItem(head)
      } else if (head.status === 'pending') {
        // 队头优先合成（保证顺序），随后预取线补足
        this.synthesize(head)
      }
    }

    this.prefetch()
  }

  /** 预取：合成线领先播放线 PREFETCH_DEPTH */
  private prefetch(): void {
    const inFlight = this.inFlightSynthCount()
    // base64 模式（移动端）音频载荷大且 mimo-tts 单进程串行合成，
    // 并发预取会让后续句子在服务端排队累积、突破单句超时（见移动端实测）。
    // 降为 1：每句串行合成，无排队抖动，单句稳定在超时内。
    const depth = this.base64Mode ? BASE64_PREFETCH_DEPTH : PREFETCH_DEPTH
    let need = depth - inFlight
    if (need <= 0) return
    for (const item of this.queue) {
      if (need <= 0) break
      if (item.status === 'pending') {
        this.synthesize(item)
        need--
      }
    }
  }

  private inFlightSynthCount(): number {
    return this.queue.filter((q) => q.status === 'synthesizing').length
  }

  /**
   * 合成失败统一收口：未达重试上限 → 重置为 pending（下次 pump 重新合成一次，有限重试降偶发丢句）；
   * 已达上限 → 标 failed + onSynthError 通知（controller 计数，跳过该句不断链）。
   * 仅状态转换，不 pump（调用方统一在失败路径后 pump，避免重入）。
   * 仅用于合成路径（callMimoTts 失败/超时/异常）；播放失败不走重试（音频已合成，重试无意义）。
   */
  private markSynthFailed(item: QueueItem, reason: string): void {
    const attempts = item.synthAttempts ?? 0
    if (attempts < SYNTH_MAX_RETRIES) {
      item.synthAttempts = attempts + 1
      item.status = 'pending'
      log.debug('合成失败，重试一次', { itemId: item.id, attempt: attempts + 1, reason })
      return
    }
    item.status = 'failed'
    this.callbacks.onSynthError?.(item, reason)
  }

  /** 合成一项（带代际 + 超时 + Abort + 缓存） */
  private synthesize(item: QueueItem): void {
    if (item.status !== 'pending') return
    // P0-5 缓存命中：跳过 API 直接就绪（微任务泵送，避免同步重入 pump 深递归）
    const cacheKey = synthCacheKey({
      text: item.text,
      voice: this.voice,
      style: this.style,
      outputMode: this.base64Mode ? 'base64' : 'file',
    })
    const cached = this.synthCache.get(cacheKey)
    if (cached) {
      item.url = cached.url
      item.status = 'ready'
      log.debug('缓存命中，跳过合成', { len: item.text.length })
      queueMicrotask(() => this.pump())
      return
    }
    item.status = 'synthesizing'
    const abort = new AbortController()
    this.pendingSynths.set(item.id, abort)

    const gen = item.gen
    const timeoutMs = this.base64Mode ? BASE64_SYNTH_TIMEOUT_MS : SYNTH_TIMEOUT_MS
    const timer = setTimeout(() => {
      if (gen !== this.generation) return
      this.pendingSynths.delete(item.id)
      if (item.status === 'synthesizing') {
        this.markSynthFailed(item, '合成超时')
        this.pump()
      }
    }, timeoutMs)

    void synthesizeVoice({
      text: item.text,
      voiceRef: this.voice,
      style: this.style,
      outputMode: this.base64Mode ? 'base64' : 'file',
    })
      .then((res: SynthResult) => {
        clearTimeout(timer)
        if (abort.signal.aborted) return // 已 stop：晚到结果丢弃
        this.pendingSynths.delete(item.id)
        if (gen !== this.generation) {
          log.debug('丢弃旧代合成结果', { itemId: item.id })
          return
        }
        if (res.ok && res.dataUrl) {
          // base64 模式：内联 dataUrl 直播
          item.url = res.dataUrl
          item.audioId = res.audioId
          item.file = res.file
          item.status = 'ready'
          this.synthCache.put(cacheKey, { url: res.dataUrl, format: res.format })
          log.debug('句就绪（base64）', { len: item.text.length })
        } else if (res.ok && res.file) {
          // file 模式：绝对路径按端构建播放 URL（Tauri asset / Web /api/files?token=，手机可达）
          const playUrl = buildAudioPlayUrl(res.file)
          if (!playUrl) {
            this.markSynthFailed(item, '播放 URL 构建失败（fileService 未就绪）')
          } else {
            item.url = playUrl
            item.audioId = res.audioId
            item.file = res.file
            item.status = 'ready'
            this.synthCache.put(cacheKey, { url: playUrl, format: res.format })
            log.debug('句就绪', { len: item.text.length, cached: res.cached })
          }
        } else {
          this.markSynthFailed(item, res.error ?? '合成失败')
        }
        this.pump()
      })
      .catch((e) => {
        clearTimeout(timer)
        if (abort.signal.aborted) return
        this.pendingSynths.delete(item.id)
        if (gen !== this.generation) return
        this.markSynthFailed(item, e instanceof Error ? e.message : String(e))
        this.pump()
      })
  }

  /** 播放队头 ready 项 */
  private playItem(item: QueueItem): void {
    if (item.status !== 'ready' || !item.url) return
    this.current = item
    item.status = 'playing'

    const audio = new Audio(item.url)
    this.audio = audio
    audio.volume = this.volume
    audio.playbackRate = this.rate // P0-2：新句继承会话倍速
    const gen = item.gen
    this.applyMediaSession(item)

    audio.onplay = () => {
      if (gen !== this.generation) {
        audio.pause()
        return
      }
      this.callbacks.onStart?.(item.text, { audioId: item.audioId ?? null, file: item.file ?? null })
    }

    audio.onended = () => {
      if (gen !== this.generation) return // stop 后音频已暂停，双保险
      if (this.current === item) this.current = null
      item.status = 'done'
      if (this.audio === audio) this.audio = null
      this.callbacks.onEnd?.()
      this.pump()
    }

    audio.onerror = () => {
      if (gen !== this.generation) return
      if (this.current === item) this.current = null
      item.status = 'failed'
      if (this.audio === audio) this.audio = null
      this.callbacks.onSynthError?.(item, '音频播放失败（音频托管服务可能不可达）')
      this.pump()
    }

    audio.play().catch(() => {
      if (gen !== this.generation) return
      if (this.current === item) this.current = null
      item.status = 'failed'
      if (this.audio === audio) this.audio = null
      this.callbacks.onSynthError?.(item, '音频播放失败')
      this.pump()
    })
  }

  /**
   * 锁屏 / 系统媒体会话（P0-4）：每句播放时刷新 metadata（话题 + 当前句摘要），
   * 注册 play/pause/stop 手势。stop 手势转交回调（控制器三路中断），不走播放器局部暂停。
   * 环境不支持（jsdom / 老内核）静默跳过，不影响主链路。
   */
  private applyMediaSession(item: QueueItem): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    try {
      const ms = (navigator as unknown as { mediaSession?: MediaSessionLike }).mediaSession
      if (!ms) return
      const MediaMetadataCtor = (
        globalThis as { MediaMetadata?: new (init: { title: string; artist: string; album: string }) => unknown }
      ).MediaMetadata
      if (MediaMetadataCtor) {
        ms.metadata = new MediaMetadataCtor({
          title: this.mediaTitle ?? 'AI 播报',
          artist: item.text.slice(0, 40),
          album: 'Polaris 无限畅听',
        })
      }
      ms.playbackState = 'playing'
      ms.setActionHandler('play', () => { void this.audio?.play().catch(() => {}) })
      ms.setActionHandler('pause', () => { this.audio?.pause() })
      ms.setActionHandler('stop', () => { this.callbacks.onStopRequest?.() })
    } catch {
      // 个别内核 setActionHandler 抛错：降级为仅展示，不阻塞播放
    }
  }
}
