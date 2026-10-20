/**
 * voiceBroadcast — 播报控制器（状态机 + 段循环 + 三路中断）
 *
 * 职责（对齐 spec §2.1/§5）：
 * - 持有播报会话状态机（idle/starting/playing/generating/stopping/error），唯一写入方。
 * - 用 kind='radio-broadcast' 的后台会话驱动 AI 连续生成；段下降沿取全文 → 清洗 →
 *   播放器预取合成 → 句间连续播放；队列播空且仍在播报时自动请求下一段。
 * - stop()：三路中断（AI interruptSession + 播放器代际清队列 + 在途 Promise 结清），
 *   幂等、顺序，不误杀其它会话。
 *
 * 控制器是全局单例：同一时刻只运行一个播报会话。
 */
import { createLogger } from '@/utils/logger'
import { sessionStoreManager } from '@/stores/conversationStore/sessionStoreManager'
import type { ConversationStoreInstance } from '@/stores/conversationStore/types'
import { useConfigStore } from '@/stores/configStore'
import { useWorkspaceStore } from '@/stores/workspaceStore'
import {
  subscribeKernelSessionState,
  waitKernelSessionStreamEnd,
} from '@/session-v2/hooks/useKernelSessionState'
import { pickLatestAssistantText } from '@/services/assistantTextUtils'
import { cleanTextForSpeech } from '@/services/ttsTextFilter'
import { VoiceBroadcastPlayer } from './voiceBroadcastPlayer'
import { VoiceStopWatcher } from './voiceStopWatcher'
import { promptForDirection } from './constants'
import type {
  RadioBroadcastDirection,
  RadioBroadcastSnapshot,
  RadioBroadcastStatus,
  VoiceId,
} from './types'

const log = createLogger('RadioBroadcastController')

/** 连续失败阈值：达到则进入 error 态 */
const MAX_CONSECUTIVE_ERRORS = 3

/** 单段生成最长等待（ms），超时视作该段失败 */
const SEGMENT_TIMEOUT_MS = 60000

export interface RadioBroadcastControllerOptions {
  direction: RadioBroadcastDirection
  voice: VoiceId
  style?: string
  /** 移动端走 base64（audioDataUrl）音频；桌面走插件托管 url */
  base64Mode?: boolean
  /** 语音「停止」口令监听（说「停止/停/暂停」即停止播报；默认开） */
  voiceStopEnabled?: boolean
  volume?: number
}

export type RadioBroadcastListener = (snapshot: RadioBroadcastSnapshot) => void

/**
 * 播报控制器单例。
 */
export class RadioBroadcastController {
  private status: RadioBroadcastStatus = 'idle'
  private sessionId: string | null = null
  private direction: RadioBroadcastDirection | null = null
  private voice: VoiceId = '冰糖'
  private style?: string
  private base64Mode = false
  /** 语音「停止」口令监听是否启用（默认 true） */
  private voiceStopEnabled = true
  /** 语音「停止」口令监听器 */
  private voiceStopWatcher = new VoiceStopWatcher()
  /** 播报会话绑定的工作区路径（sendMessage 用；无工作区为 null） */
  private workspacePath: string | null = null

  /** 播放器（句级流水线） */
  private player = new VoiceBroadcastPlayer()

  /** 订阅者 */
  private listeners = new Set<RadioBroadcastListener>()

  /** 连续失败计数（AI 段失败/合成失败），达阈值进 error */
  private consecutiveErrors = 0
  /** 当前段索引（UI 展示） */
  private segmentIndex = 0
  /** 自开始累计已播句数 */
  private segmentCount = 0
  /** 当前播放句文本（UI 展示） */
  private nowPlayingText: string | null = null
  /** 错误信息（error 态） */
  private lastError: string | null = null

  /** 停止标志：stop() 置 true，晚到回调据此丢弃（代际 + 标志双保险） */
  private stopped = false
  /** 内部循环运行中标志 */
  private running = false
  /** 已提交的段生成 Promise 集合（stop 时结清） */
  private pendingSegmentPromises = new Set<Promise<unknown>>()
  /** 当前等待中的段生成 AbortController */
  private segmentAbort: AbortController | null = null

  /** 方向预设提示词注入用（当前方向文本快照，供段间续接） */
  private lastSegmentSummary = ''

  getStatus(): RadioBroadcastStatus {
    return this.status
  }

  getSnapshot(): RadioBroadcastSnapshot {
    return {
      status: this.status,
      direction: this.direction ?? { kind: 'custom', text: '' },
      voice: this.voice,
      segment:
        this.segmentIndex > 0
          ? { index: this.segmentIndex, text: this.nowPlayingText ?? '' }
          : null,
      segmentCount: this.segmentCount,
      error: this.lastError,
      nowPlayingText: this.nowPlayingText,
    }
  }

  subscribe(listener: RadioBroadcastListener): () => void {
    this.listeners.add(listener)
    listener(this.getSnapshot())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    const snapshot = this.getSnapshot()
    this.listeners.forEach((l) => l(snapshot))
  }

  private setStatus(status: RadioBroadcastStatus): void {
    if (this.status === status) return
    log.debug('状态迁移', { from: this.status, to: status })
    this.status = status
    this.emit()
  }

  // ================================================================
  // 开始 / 停止 / 暂停 / 恢复
  // ================================================================

  /**
   * 开始播报。Promise 在「首个音频就绪可播」或「失败（预检不通过）」时 resolve。
   */
  async start(opts: RadioBroadcastControllerOptions): Promise<void> {
    if (this.status !== 'idle' && this.status !== 'error') {
      log.warn('start 忽略：当前状态', { status: this.status })
      return
    }
    if (!opts.direction.text.trim()) {
      this.lastError = '请填写播报方向'
      this.setStatus('error')
      return
    }

    this.stopped = false
    this.running = true
    this.consecutiveErrors = 0
    this.segmentIndex = 0
    this.segmentCount = 0
    this.nowPlayingText = null
    this.lastError = null
    this.direction = opts.direction
    this.voice = opts.voice
    this.style = opts.style
    this.base64Mode = opts.base64Mode ?? false
    this.voiceStopEnabled = opts.voiceStopEnabled ?? true

    // 上一轮残留（error 态重试）：清播放器 + 弃用旧 session，从零开始
    this.player.stop()
    this.voiceStopWatcher.stop()
    this.pendingSegmentPromises.clear()
    this.segmentAbort = null
    this.sessionId = null
    this.lastSegmentSummary = ''

    this.player.setCallbacks({
      onStart: (text) => {
        this.nowPlayingText = text
        this.segmentCount++
        this.setStatus('playing')
      },
      onEnd: () => {
        this.nowPlayingText = null
      },
      onSynthError: (_item, error) => {
        log.warn('单句合成失败（跳过）', { error })
        this.consecutiveErrors++
        this.checkErrorThreshold()
      },
      onQueueDrained: () => {
        // 队列播空且无在途合成：
        //  - 已停止 → 不动作（stop 流程走完会置 idle）
        //  - 仍在播报且无段生成中 → 请求下一段
        this.handleQueueDrained()
      },
      onPendingSynth: () => {
        // 队列空但仍有在途合成 → generating 子状态（潜在静默窗）
        if (!this.stopped && this.running) this.setStatus('generating')
      },
    })
    this.player.setOptions({ voice: this.voice, style: this.style, base64Mode: this.base64Mode })
    this.player.setVolume(opts.volume ?? 1)

    // 语音「停止」口令监听：命中即停止播报（复用既有 speechService，失败静默降级按钮兜底）
    if (this.voiceStopEnabled) {
      this.voiceStopWatcher.setCallbacks({
        onStop: () => {
          void this.stop()
        },
      })
      this.voiceStopWatcher.start()
    }

    this.setStatus('starting')

    // 预检：mimo-tts 可用性（未配 Key 等直接进 error，避免空跑）
    const probe = await this.probeMimo()
    if (!probe) {
      this.running = false
      this.setStatus('error')
      return
    }

    // 建立 kind 会话
    try {
      this.sessionId = await this.createSession()
    } catch (e) {
      this.lastError = `创建播报会话失败: ${e instanceof Error ? e.message : String(e)}`
      this.running = false
      this.setStatus('error')
      return
    }

    log.info('播报会话就绪', { sessionId: this.sessionId })

    // 进入主循环：请求第一段（首段就绪后 status 由播放器 onStart 置 playing）
    this.requestNextSegment()
  }

  /**
   * 停止播报：三路中断（AI + 播放器 + 在途 Promise），幂等。
   * 完成后回 idle。若已在 idle 则 no-op。
   */
  async stop(): Promise<void> {
    if (this.status === 'idle') return
    if (this.status === 'stopping') {
      log.warn('stop 忽略：已在 stopping')
      return
    }

    const wasError = this.status === 'error'
    this.setStatus('stopping')
    this.stopped = true
    this.running = false

    // 路 1：播放器（代际 + 清队列 + 中止合成 + 停音频）
    this.player.stop()
    // 语音停止口令监听器一并停止
    this.voiceStopWatcher.stop()

    // 路 2：AI 生成中断（幂等：isStreaming=false 时 interruptSession no-op）
    const sessionId = this.sessionId
    if (sessionId) {
      try {
        await sessionStoreManager.getState().interruptSession(sessionId)
      } catch (e) {
        log.warn('中断 AI 生成失败（忽略，继续清理）', { error: String(e) })
      }
    }

    // 路 3：结清在途段生成 Promise（waitKernelSessionStreamEnd 会 reject timeout/abort）
    this.segmentAbort?.abort()
    this.segmentAbort = null
    await Promise.allSettled([...this.pendingSegmentPromises])
    this.pendingSegmentPromises.clear()

    this.sessionId = null
    this.lastSegmentSummary = ''
    this.nowPlayingText = null
    this.consecutiveErrors = 0
    this.lastError = wasError ? this.lastError : null

    this.setStatus('idle')
    log.info('播报已停止（三路中断完成）')
  }

  /** 播放暂停（AI 保持生成） */
  pause(): void {
    if (this.status !== 'playing' && this.status !== 'generating') return
    this.player.pause()
  }

  /** 恢复播放 */
  resume(): void {
    if (this.status !== 'playing' && this.status !== 'generating') return
    this.player.resume()
  }

  // ================================================================
  // 内部：会话与段循环
  // ================================================================

  private async createSession(): Promise<string> {
    const configEngineId = useConfigStore.getState().config?.defaultEngine
    const workspaceStore = useWorkspaceStore.getState()
    const workspaceId = workspaceStore.currentWorkspaceId ?? 'default'
    // workspacePath 供 sendMessage 使用（无工作区时降级 fallback）
    const currentWs = workspaceStore.workspaces.find((w) => w.id === workspaceId)
    this.workspacePath = currentWs?.path ?? null

    const manager = sessionStoreManager.getState()
    const sessionId = manager.createSession({
      type: 'project',
      workspaceId,
      contextWorkspaceIds: [workspaceId],
      workspaceLocked: true,
      engineId: configEngineId,
      title: 'AI 播报',
      kind: 'radio-broadcast',
      silentMode: true,
    })

    // 订阅 kernel 状态：running→idle/error 下降沿即「一段播报完成」（见 requestNextSegment）
    this.setupSegmentEndWatch(sessionId)

    return sessionId
  }

  /** 订阅 kernel 状态下降沿，触发下一段请求（队列播空时） */
  private setupSegmentEndWatch(sessionId: string): void {
    const unsub = subscribeKernelSessionState(sessionId, (state) => {
      if (this.stopped || this.sessionId !== sessionId) {
        unsub()
        return
      }
      // running → idle/error 下降沿：一段流式结束，取全文入队
      if (state.isStreaming === false && (state.state === 'idle' || state.state === 'error')) {
        this.onSegmentEnded(sessionId)
      }
    })
  }

  /** 一段 AI 流式结束：取全文 → 清洗 → 入队播放。
   *  下一段请求统一收敛到 runSegment 的 finally（避免订阅与 await 双触发断链）。 */
  private onSegmentEnded(sessionId: string): void {
    if (this.stopped || this.sessionId !== sessionId) return

    const store = sessionStoreManager.getState().stores.get(sessionId)
    if (!store) {
      log.warn('段结束但会话 store 不存在（可能已 stop）', { sessionId })
      return
    }

    const raw = pickLatestAssistantText(store.getState())
    if (!raw.trim()) {
      log.warn('段文本为空，跳过')
      this.consecutiveErrors++
      this.checkErrorThreshold()
      return
    }

    const clean = this.sanitizeForSpeech(raw)
    if (!clean.trim()) {
      log.warn('清洗后为空，跳过')
      this.consecutiveErrors++
      this.checkErrorThreshold()
      return
    }

    this.consecutiveErrors = 0
    this.lastSegmentSummary = clean.slice(0, 120)
    this.segmentIndex++
    this.player.enqueueSegment(clean)

    // 队尾可能仍有待播内容；由 onQueueDrained 决定何时请求下一段
  }

  /** 队列播空且仍在播报时：请求下一段 */
  private handleQueueDrained(): void {
    if (this.stopped || !this.running) return
    if (this.status === 'stopping' || this.status === 'idle') return

    // 若仍有段生成在途（AI 还在写下一段），保持 generating
    if (this.hasSegmentInFlight()) {
      this.setStatus('generating')
      return
    }

    this.requestNextSegment()
  }

  /** 请求 AI 生成下一段 */
  private requestNextSegment(): void {
    if (this.stopped || !this.running) return
    if (this.status === 'stopping' || this.status === 'error') return
    if (this.hasSegmentInFlight()) {
      log.debug('已有段生成在途，跳过重复请求')
      return
    }
    if (!this.sessionId) return

    const store = sessionStoreManager.getState().stores.get(this.sessionId)
    if (!store) {
      this.handleSessionLost()
      return
    }

    const prompt = this.buildNextSegmentPrompt()
    const systemPrompt = promptForDirection(this.direction?.kind ?? 'custom', this.direction?.text ?? '')

    this.setStatus('generating')

    const abort = new AbortController()
    this.segmentAbort = abort
    const p = this.runSegment(store, this.sessionId, prompt, systemPrompt, abort.signal)
      .catch(() => { /* runSegment 内部已计错 */ })
      .finally(() => {
        this.pendingSegmentPromises.delete(p)
        if (this.segmentAbort === abort) this.segmentAbort = null
        // 段生成收尾唯一衔接点：仍处于播报态且未到 error → 队列空即请求下一段
        this.afterSegmentFinished()
      })
    this.pendingSegmentPromises.add(p)
  }

  /** 段生成结束收尾：error 停循环；否则队列空则续下段 */
  private afterSegmentFinished(): void {
    if (this.stopped || !this.running) return
    if (this.status === 'stopping' || this.status === 'error' || this.status === 'idle') return
    if (this.hasSegmentInFlight()) return
    // 队列空（段文本为空/超时/清洗后空）→ 直接续下一段；否则等 onQueueDrained
    if (this.player.queueLength === 0 && !this.player.hasPendingSynth) {
      this.requestNextSegment()
    }
  }

  /** 执行一次段生成：发送消息 + 等待流式下降沿（onSegmentEnded 统一取全文入队） */
  private async runSegment(
    store: ConversationStoreInstance,
    sessionId: string,
    prompt: string,
    systemPrompt: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const accepted = await store.getState().sendMessage(prompt, this.workspacePath ?? undefined, undefined, {
        oneTimeSystemPrompt: systemPrompt,
      })
      if (!accepted) {
        throw new Error('段发送未受理')
      }
      // 等待下降沿（running→idle/error）；超时/abort 由 waitKernelSessionStreamEnd 处理
      await waitKernelSessionStreamEnd(sessionId, { timeoutMs: SEGMENT_TIMEOUT_MS, signal })
      if (signal.aborted) return // stop() 触发，丢弃
      // 下降沿后由 onSegmentEnded（订阅）统一取全文入队
    } catch (e) {
      if (signal.aborted) return
      log.warn('段生成失败', { error: String(e) })
      this.consecutiveErrors++
      this.checkErrorThreshold()
    }
  }

  private hasSegmentInFlight(): boolean {
    return this.pendingSegmentPromises.size > 0 || this.segmentAbort !== null
  }

  private handleSessionLost(): void {
    this.lastError = '播报会话已失效（可能被系统回收）'
    this.setStatus('error')
  }

  private checkErrorThreshold(): void {
    if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      this.lastError = `连续生成失败 ${this.consecutiveErrors} 次，已停止播报`
      this.running = false
      this.setStatus('error')
    }
  }

  /** 段间续接提示（方向 + 已播摘要） */
  private buildNextSegmentPrompt(): string {
    if (this.segmentIndex === 0) {
      return `请开始${this.direction?.text ?? ''}的第一次播报。`
    }
    return `请接续上一段，继续${this.direction?.text ?? ''}的播报。上一段结尾：${this.lastSegmentSummary}`
  }

  /** 清洗：cleanTextForSpeech + 表格过滤（丢弃 | 成行表格块与行内残留） */
  private sanitizeForSpeech(text: string): string {
    let cleaned = cleanTextForSpeech(text)
    // 丢弃 Markdown 表格块（| --- | 成行段落）
    cleaned = cleaned
      .split('\n')
      .filter((line) => !/^\s*\|/.test(line))
      .join('\n')
    // 去掉残留的单元格分隔竖线
    cleaned = cleaned.replace(/\s*\|\s*/g, ' ')
    return cleaned.trim()
  }

  /** 预检 mimo-tts 可用性 */
  private async probeMimo(): Promise<boolean> {
    try {
      const { probeMimoTts } = await import('./mcpBridge')
      const res = await probeMimoTts(this.voice)
      if (!res.ok) {
        this.lastError = `mimo-tts 不可用：${res.error ?? '未知原因'}（请检查插件 API Key 配置）`
        return false
      }
      return true
    } catch (e) {
      this.lastError = `mimo-tts 预检失败: ${e instanceof Error ? e.message : String(e)}`
      return false
    }
  }
}

/** 全局单例导出 */
export const radioBroadcastController = new RadioBroadcastController()
