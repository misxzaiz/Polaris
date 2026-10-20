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
import { callMimoTts } from './mcpBridge'
import type { QueueItem } from './types'

const log = createLogger('VoiceBroadcastPlayer')

export interface PlayerCallbacks {
  /** 开始播放某句（UI 打点） */
  onStart?: (text: string) => void
  /** 一句播放结束 */
  onEnd?: () => void
  /** 队列已空且无在途合成（段尾/停止时触发，供控制器请求下一段或进入 idle） */
  onQueueDrained?: () => void
  /** 合成失败（单句跳过，不中断整体） */
  onSynthError?: (item: QueueItem, error: string) => void
  /** 队列空但仍有在途合成（供控制器判断 generating 子状态） */
  onPendingSynth?: (count: number) => void
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

  setCallbacks(cb: PlayerCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb }
  }

  setOptions(opts: { voice?: string; style?: string; base64Mode?: boolean }): void {
    this.voice = opts.voice
    this.style = opts.style
    this.base64Mode = opts.base64Mode ?? false
  }

  setVolume(v: number): void {
    this.volume = Math.max(0, Math.min(1, v))
    if (this.audio) this.audio.volume = this.volume
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

  /** 清空队列 + 中止在途合成（stop 路径） */
  private clear(): void {
    this.queue = []
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

  /** 合成一项（带代际 + 超时 + Abort） */
  private synthesize(item: QueueItem): void {
    if (item.status !== 'pending') return
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

    void callMimoTts({
      text: item.text,
      voice: this.voice,
      style: this.style,
      outputMode: this.base64Mode ? 'base64' : 'file',
    })
      .then((res) => {
        clearTimeout(timer)
        if (abort.signal.aborted) return // 已 stop：晚到结果丢弃
        this.pendingSynths.delete(item.id)
        if (gen !== this.generation) {
          log.debug('丢弃旧代合成结果', { itemId: item.id })
          return
        }
        if (res.ok && res.url) {
          item.url = res.url
          item.status = 'ready'
          log.debug('句就绪', { len: item.text.length })
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
    const gen = item.gen

    audio.onplay = () => {
      if (gen !== this.generation) {
        audio.pause()
        return
      }
      this.callbacks.onStart?.(item.text)
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
}
