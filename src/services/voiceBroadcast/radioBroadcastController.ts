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
import { probeVoice, addLibraryItem, buildAudioPlayUrl } from './voiceService'
import type { LibraryItem } from './voiceService'
import { promptForDirection, promptForInterject, promptForSwitchTopic, SEGMENT_LOOKAHEAD_SENTENCES } from './constants'
import type {
  RadioBroadcastDirection,
  RadioBroadcastSnapshot,
  RadioBroadcastStatus,
  RadioBroadcastStopReason,
  VoiceId,
} from './types'

const log = createLogger('RadioBroadcastController')

/** 方向 key → 中文标签（锁屏媒体会话标题用；与面板 DIRECTION_LABELS 对齐） */
const DIRECTION_LABEL: Record<string, string> = {
  study: '学习',
  story: '故事',
  tech: '技术',
  news: '新闻',
  custom: '自定义',
}

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
  /** AI 引擎（不传则跟随 config.defaultEngine）——建会话时定死，中途不可换 */
  engineId?: string
  /** 模型供应商 Profile（SSR 传 OFFICIAL_API_PROFILE 哨兵 = 官方 API） */
  modelProfileId?: string
  /** 模型名（须与所选 Profile 的 modelOptions 一致） */
  model?: string
  /** 播放轮次上限（播满 N 段自动停止；0/undefined = 不限） */
  maxRounds?: number
  /** 播放时长上限（秒数，到点自动停止；0/undefined = 不限） */
  maxSeconds?: number
  /** 播放倍速（P0-2，0.5~4；缺省 1）。开播生效，播报中可经 setRate 调整 */
  rate?: number
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

  /** AI 引擎（会话级覆盖；undefined = 跟随 config.defaultEngine） */
  private engineId?: string
  /** 模型供应商 Profile（OFFICIAL_API_PROFILE 哨兵 = 官方 API） */
  private modelProfileId?: string
  /** 模型名（须与所选 Profile 的 modelOptions 一致） */
  private model?: string
  /** 轮次上限（播满 N 段自动停止） */
  private maxRounds?: number
  /** 时长上限（秒） */
  private maxSeconds?: number
  /** 开始时刻（时长上限计算起点） */
  private startedAt = 0
  /** 是否已达上限（limitReached 守卫位；stop() 时复位） */
  private limitReached = false

  // ── 睡眠定时（P0-3）──
  /** 定时到点时刻（ms 时间戳；0 = 未设）。到点 → 淡出 3s → stop('sleep') */
  private sleepUntil = 0
  /** 「播完本段」模式：不再请求新段，当前队列播空即优雅停机 */
  private sleepAfterSegment = false
  /** 淡出中守卫：watchdog 只触发一次淡出 */
  private sleepFading = false
  /** 睡眠定时 watchdog（1s 检点；start 建、stop 清） */
  private sleepTimer: ReturnType<typeof setInterval> | null = null

  /** 停止标志：stop() 置 true，晚到回调据此丢弃（代际 + 标志双保险） */
  private stopped = false
  /** 内部循环运行中标志 */
  private running = false
  /** 回听模式（P1）：无 AI 会话，直插库句子播放；队列播空即 stop('finished') */
  private replayMode = false
  /** 最近一次停止原因（回 idle 后保留一次，供 UI Toast 反馈；error 态归 'error'） */
  private stopReason: RadioBroadcastStopReason | null = null
  /** 已提交的段生成 Promise 集合（stop 时结清） */
  private pendingSegmentPromises = new Set<Promise<unknown>>()
  /** 当前等待中的段生成 AbortController */
  private segmentAbort: AbortController | null = null

  /** 方向预设提示词注入用（当前方向文本快照，供段间续接） */
  private lastSegmentSummary = ''

  // ── P2 体验层 ──
  /** 待执行岔题（P2-1）：在途段收尾后，下一次 requestNextSegment 用岔题 prompt */
  private topicSwitchPending = false
  /** 待处理插话（P2-2）：在途段存在时暂存，下一次 requestNextSegment 以插话为请求内容 */
  private queueInterject: string | null = null
  /** 插话回复已入队标志（onSegmentEnded 据此恢复播放，且不增 round） */
  private interjectActive = false

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
      startedAt: this.startedAt,
      maxRounds: this.maxRounds,
      maxSeconds: this.maxSeconds,
      stopReason: this.stopReason,
      transcript: this.player.getTranscript(),
      sleepUntil: this.sleepUntil,
      sleepAfterSegment: this.sleepAfterSegment,
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
    this.engineId = opts.engineId
    this.modelProfileId = opts.modelProfileId
    this.model = opts.model
    this.maxRounds = opts.maxRounds && opts.maxRounds > 0 ? opts.maxRounds : undefined
    this.maxSeconds = opts.maxSeconds && opts.maxSeconds > 0 ? opts.maxSeconds : undefined
    this.startedAt = Date.now()
    this.limitReached = false
    this.stopReason = null
    this.sleepUntil = 0
    this.sleepAfterSegment = false
    this.sleepFading = false
    this.clearSleepTimer()
    // P2 埋点：会话计数 + 收听时长 ticker（stop 清）
    this.writeMetrics({ sessionCount: 1 })
    this.startListenTicker()

    // 上一轮残留（error 态重试）：清播放器 + 弃用旧 session，从零开始
    this.player.stop()
    this.voiceStopWatcher.stop()
    this.pendingSegmentPromises.clear()
    this.segmentAbort = null
    this.sessionId = null
    this.lastSegmentSummary = ''
    this.topicSwitchPending = false
    this.queueInterject = null
    this.interjectActive = false

    this.player.setCallbacks({
      onStart: (text) => {
        this.nowPlayingText = text
        this.segmentCount++
        // emit 修复（P0-1）：status 已是 playing 时 setStatus 会早退不通知，
        // nowPlayingText / transcript 的句级变化须显式广播（连续句间 UI 实时刷新）
        this.emit()
        this.setStatus('playing')
      },
      onEnd: () => {
        this.nowPlayingText = null
        // 段级提前量：每句播完检查队列低水位（未就绪句数 ≤ 阈值），
        // 低水位且无段生成在途 → 提前请求下一段，实现「播当前段时并行生成下一段」。
        // 若已在上限/停止则不请求（reachedLimit 内一并处理）。
        this.maybeAdvanceByLookahead()
        this.emit() // 句级变化广播（同上）
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
      onStopRequest: () => {
        // 锁屏 / 系统媒体会话的停止手势（P0-4）→ 走统一三路中断
        void this.stop('manual')
      },
    })
    this.player.setOptions({
      voice: this.voice,
      style: this.style,
      base64Mode: this.base64Mode,
      ...(opts.rate !== undefined ? { rate: opts.rate } : {}),
      mediaTitle: `${DIRECTION_LABEL[opts.direction.kind]} · ${opts.direction.text}`,
    })
    this.player.setVolume(opts.volume ?? 1)

    // 语音「停止」口令监听：命中即停止播报（复用既有 speechService，失败静默降级按钮兜底）
    if (this.voiceStopEnabled) {
      this.voiceStopWatcher.setCallbacks({
        onStop: () => {
          void this.stop('voice-command')
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
   * @param reason 停止原因（默认 manual；自动停止/口令等由调用方标注，UI 据此反馈）
   */
  async stop(reason: RadioBroadcastStopReason = 'manual'): Promise<void> {
    if (this.status === 'idle') return
    if (this.status === 'stopping') {
      log.warn('stop 忽略：已在 stopping')
      return
    }

    // error 态停止归 'error'（由 error 视图触发）；其余用调用方原因
    this.stopReason = this.status === 'error' ? 'error' : reason
    const wasError = this.status === 'error'
    this.setStatus('stopping')
    this.stopped = true
    this.running = false

    // 全量句入库：收尾前把播完（done）未入库的句子落库。
    // 顺序关键：须在 player.stop() 清队列前取走（takeDoneSentences 依赖队列内容）。
    if (!this.replayMode) this.flushDoneSentencesToLibrary()
    this.replayMode = false

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
    this.topicSwitchPending = false
    this.queueInterject = null
    this.interjectActive = false
    this.nowPlayingText = null
    this.consecutiveErrors = 0
    this.limitReached = false
    this.lastError = wasError ? this.lastError : null

    // 睡眠定时收尾：watchdog/淡出守卫复位（P0-3）
    this.clearSleepTimer()
    this.sleepUntil = 0
    this.sleepAfterSegment = false
    this.sleepFading = false
    // P2 埋点：收听 ticker 停止；「上次畅听」快照写入（续播入口用）
    this.stopListenTicker()
    this.saveLastSession()

    this.setStatus('idle')
    log.info('播报已停止（三路中断完成）')
  }

  // ================================================================
  // 内容库回听（P1）
  // ================================================================

  /**
   * 回听内容库单集（P1）：无 AI 会话，已合成句子直插播放器，队列播空即 stop('finished')。
   * 与 start() 的区别：不建会话、不预检参数、不请求新段、零 AI 成本。
   */
  async playLibraryItem(item: LibraryItem): Promise<boolean> {
    if (this.status !== 'idle') {
      await this.stop('manual')
    }
    const prepared = item.sentences
      .map((s) => {
        const playUrl = typeof s.file === 'string' && s.file ? buildAudioPlayUrl(s.file) : null
        return { text: s.text, playUrl, audioId: s.audioId ?? null, file: s.file ?? null }
      })
      .filter((s): s is { text: string; playUrl: string; audioId: string | null; file: string | null } => !!s.playUrl)
    if (prepared.length === 0) {
      this.lastError = '该单集无可播放音频（句子文件缺失或未入库）'
      this.setStatus('error')
      return false
    }

    this.stopped = false
    this.running = true
    this.replayMode = true
    this.consecutiveErrors = 0
    this.segmentIndex = 0
    this.segmentCount = 0
    this.nowPlayingText = null
    this.limitReached = false
    this.lastError = null
    this.direction = { kind: 'custom', text: item.title || '畅听回放' }
    this.voice = item.voiceRef || this.voice
    this.startedAt = Date.now()
    this.stopReason = null
    this.sleepUntil = 0
    this.sleepAfterSegment = false
    this.sleepFading = false
    this.clearSleepTimer()

    // 上一轮残留清理（不碰会话字段：replay 无 sessionId）
    this.player.stop()
    this.voiceStopWatcher.stop()

    this.player.setOptions({ mediaTitle: item.title })
    this.setStatus('playing')
    this.player.enqueuePrepared(prepared)
    this.writeMetrics({ replayCount: 1 })
    this.startListenTicker()
    log.info('回听开始（replay）', { itemId: item.id, sentences: prepared.length })
    return true
  }

  /**
   * 全量句入库（P1）：把播完（done）且未入库的句子写入内容库（source='live'，fire-and-forget）。
   * 触发点：队列播空（handleQueueDrained）与 stop() 收尾——两处已覆盖段间与最终残留。
   */
  private flushDoneSentencesToLibrary(): void {
    if (this.replayMode) return
    if (!this.sessionId) return
    const sentences = this.player.takeDoneSentences()
    if (sentences.length === 0) return
    const label = DIRECTION_LABEL[this.direction?.kind ?? 'custom'] ?? '自定义'
    const title = `${label} · ${this.direction?.text?.trim() || '畅听'}`
    log.info('段自动入库', { sentences: sentences.length, title })
    void addLibraryItem({
      title,
      topic: this.direction?.text ?? '',
      engine: this.engineId ?? '',
      voiceRef: this.voice,
      style: this.style,
      source: 'live',
      sentences,
    })
      .then((res) => {
        if (!res.ok) log.warn('段入库失败（不影响播放）', { error: res.error })
      })
      .catch((e) => log.warn('段入库异常（不影响播放）', { error: String(e) }))
  }

  // ================================================================
  // 换台 / 插话（P2 体验层）
  // ================================================================

  /**
   * 换台（P2-1）：播报中切换方向——不停声、不重建会话。
   * - 无段在途：立即用岔题指令发起新段（复用段生成唯一路径）；
   * - 有段在途：标记待岔题，在途段收尾后 requestNextSegment 用岔题 prompt（旧话题内容最多多播一段）。
   * 回听模式不适用（无会话）；面板应先 stop 再 start。
   */
  switchTopic(direction: RadioBroadcastDirection): void {
    const text = direction.text.trim()
    if (!text) return
    if (this.stopped || !this.running || this.replayMode) return
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return
    this.direction = { kind: direction.kind, text }
    this.topicSwitchPending = true
    this.lastSegmentSummary = '' // 旧方向摘要不再续接
    this.writeMetrics({ switchCount: 1 })
    this.player.setOptions({ mediaTitle: `${DIRECTION_LABEL[direction.kind]} · ${text}` })
    this.emit()
    log.info('换台', { kind: direction.kind, text, inFlight: this.hasSegmentInFlight() })
    // 无段在途 → 立即岔题；在途 → afterSegmentFinished 衔接点自然用岔题 prompt
    if (!this.hasSegmentInFlight()) this.requestNextSegment()
  }

  /**
   * 插话（P2-2）：半双工——暂停当前播放，插话作为本会话新请求，
   * 回复经 onSegmentEnded 入队并恢复播放；不计 round。
   * 与 stop() 时序解耦：插话不 abort；用户仍可随时 stop()（三路中断幂等）。
   */
  interject(text: string): void {
    const trimmed = text.trim()
    if (!trimmed) return
    if (this.stopped || !this.running || this.replayMode) return
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return
    this.writeMetrics({ interjectCount: 1 })
    if (this.hasSegmentInFlight()) {
      // 在途段未完：暂存插话，收尾衔接点（finally → requestNextSegment）以插话为下一次请求
      this.queueInterject = trimmed
      log.debug('段生成在途：插话暂存，收尾后响应')
      return
    }
    // 无段在途：暂存插话 → requestNextSegment 的插话分支立即发起（半双工 pause 在 buildNextSegmentPrompt 内）
    this.queueInterject = trimmed
    this.requestNextSegment()
  }

  /**
   * 写埋点（P2 北极星指标）：localStorage 本机累计，无上传。
   * bump 调用方语义：delta 累加（switchCount/interjectCount）或绝对置位（listenMs）。
   */
  private writeMetrics(patch: { sessionCount?: number; replayCount?: number; switchCount?: number; interjectCount?: number; listenMsDelta?: number }): void {
    try {
      const key = 'polaris.radioMetrics'
      const raw = localStorage.getItem(key)
      let m: { listenMs?: number; sessionCount?: number; switchCount?: number; interjectCount?: number; replayCount?: number } = {}
      if (raw) {
        try { m = JSON.parse(raw) as typeof m } catch { /* 损坏即重建 */ }
      }
      if (patch.listenMsDelta) m.listenMs = (m.listenMs ?? 0) + patch.listenMsDelta
      if (patch.sessionCount) m.sessionCount = (m.sessionCount ?? 0) + patch.sessionCount
      if (patch.replayCount) m.replayCount = (m.replayCount ?? 0) + patch.replayCount
      if (patch.switchCount) m.switchCount = (m.switchCount ?? 0) + patch.switchCount
      if (patch.interjectCount) m.interjectCount = (m.interjectCount ?? 0) + patch.interjectCount
      localStorage.setItem(key, JSON.stringify(m))
    } catch {
      /* localStorage 不可用（隐私模式等）：埋点静默失败 */
    }
  }

  /** 收听时长 ticker（P2 埋点）：1s 累计 listenMs；start/replay 建、stop 清 */
  private listenTicker: ReturnType<typeof setInterval> | null = null
  private startListenTicker(): void {
    if (this.listenTicker) return
    this.listenTicker = setInterval(() => {
      this.writeMetrics({ listenMsDelta: 1000 })
    }, 1000)
  }
  private stopListenTicker(): void {
    if (this.listenTicker) {
      clearInterval(this.listenTicker)
      this.listenTicker = null
    }
  }

  /**
   * 「上次畅听」快照持久化（P2-3 续播入口）：stop 收尾时写入。
   * 面板 idle 态读取展示「继续上次畅听」；数据在本机，无上传。
   */
  private saveLastSession(): void {
    try {
      localStorage.setItem('polaris.radioLastSession', JSON.stringify({
        direction: this.direction,
        voice: this.voice,
        ts: Date.now(),
      }))
    } catch { /* 隐私模式等：静默 */ }
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
  // 倍速 / 睡眠定时（P0-2 / P0-3）
  // ================================================================

  /** 播放倍速（即时生效；持久化归 prefs store，控制器不落盘） */
  setRate(rate: number): void {
    this.player.setRate(rate)
  }

  /**
   * 睡眠定时（P0-3）。三种形态：
   * - `{ minutes: N }` → N 分钟后淡出 3s 并停止（watchdog 1s 检点，优雅不截半句）
   * - `{ afterSegment: true }` → 「播完本段」：不再请求新段，当前队列播空即停
   * - `null` → 取消定时
   * 与配置字段 maxRounds/maxSeconds 分治：那是「播报上限」语义，本方法是「收听定时」语义。
   */
  sleep(opts: { minutes?: number; afterSegment?: boolean } | null): void {
    if (this.status === 'idle') return
    if (opts === null) {
      this.sleepUntil = 0
      this.sleepAfterSegment = false
      this.sleepFading = false
      this.clearSleepTimer()
      this.emit()
      log.info('睡眠定时已取消')
      return
    }
    if (opts.afterSegment) {
      this.sleepAfterSegment = true
      log.info('睡眠定时：播完本段后停止')
      // 已无待播内容（队列空且无在途合成）→ 直接优雅停机
      if (this.player.queueLength === 0 && !this.player.hasPendingSynth && !this.hasSegmentInFlight()) {
        this.tryGracefulStop()
      }
    } else if (opts.minutes && opts.minutes > 0) {
      this.sleepUntil = Date.now() + opts.minutes * 60_000
      this.sleepFading = false
      this.startSleepTimer()
      log.info('睡眠定时已设', { minutes: opts.minutes })
    }
    this.emit()
  }

  /** watchdog：1s 检点 sleepUntil，到点 → 淡出 → stop('sleep')。仅触发一次。 */
  private startSleepTimer(): void {
    if (this.sleepTimer) return
    this.sleepTimer = setInterval(() => {
      if (this.sleepUntil === 0 || this.sleepFading || this.stopped) {
        if (this.stopped || this.sleepUntil === 0) this.clearSleepTimer()
        return
      }
      if (Date.now() >= this.sleepUntil) {
        this.sleepFading = true
        this.clearSleepTimer()
        log.info('睡眠定时到点：淡出后停止')
        void this.player.fadeOut(3000).then(() => {
          if (!this.stopped) void this.stop('sleep')
        })
      }
    }, 1000)
  }

  private clearSleepTimer(): void {
    if (this.sleepTimer) {
      clearInterval(this.sleepTimer)
      this.sleepTimer = null
    }
  }

  // ================================================================
  // 内部：会话与段循环
  // ================================================================

  private async createSession(): Promise<string> {
    // 引擎/供应商/模型：会话级覆盖（面板显式选择）优先，否则跟随全局（config.defaultEngine + 全局 Profile）
    const configStore = useConfigStore.getState()
    const engineId = this.engineId ?? configStore.config?.defaultEngine
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
      engineId,
      title: 'AI 播报',
      kind: 'radio-broadcast',
      silentMode: true,
      ...(this.modelProfileId ? { modelProfileId: this.modelProfileId } : {}),
      ...(this.model ? { model: this.model } : {}),
    })

    // 订阅 kernel 状态：running→idle/error 下降沿即「一段播报完成」（见 requestNextSegment）
    this.setupSegmentEndWatch(sessionId)

    return sessionId
  }

  /** 订阅 kernel 状态下降沿，触发下一段请求（队列播空时） */
  private setupSegmentEndWatch(sessionId: string): void {
    // 必须观测到 running 之后，idle/error 才算「段结束下降沿」。
    // 根因：kernel.subscribe 建立时立即推首帧快照（v2-kernel.ts 初始 push），
    // 会话刚创建尚未启动 AI 时为 idle，被误判为下降沿 → 取空文本 → 段空跳过。
    // 对齐既有消费方守卫模式（promptOptimizeService / titleGenerationService 的 sawStreaming）。
    let sawStreaming = false
    const unsub = subscribeKernelSessionState(sessionId, (state) => {
      if (this.stopped || this.sessionId !== sessionId) {
        unsub()
        return
      }
      if (state.state === 'running') {
        sawStreaming = true
        return
      }
      // running → idle/error 下降沿：一段流式结束，取全文入队
      if (sawStreaming && state.isStreaming === false && (state.state === 'idle' || state.state === 'error')) {
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
      if (this.interjectActive) this.interjectActive = false
      this.consecutiveErrors++
      this.checkErrorThreshold()
      return
    }

    const clean = this.sanitizeForSpeech(raw)
    if (!clean.trim()) {
      log.warn('清洗后为空，跳过')
      if (this.interjectActive) this.interjectActive = false
      this.consecutiveErrors++
      this.checkErrorThreshold()
      return
    }

    this.consecutiveErrors = 0
    this.lastSegmentSummary = clean.slice(0, 120)
    if (this.interjectActive) {
      // 插话回复（P2-2）：不计 round（不消费轮次上限）；恢复半双工播放
      this.interjectActive = false
      this.player.resume()
    } else {
      this.segmentIndex++
    }
    this.player.enqueueSegment(clean)

    // 队尾可能仍有待播内容；由 onQueueDrained 决定何时请求下一段
  }

  /** 队列播空且仍在播报时：请求下一段 */
  private handleQueueDrained(): void {
    if (this.stopped || !this.running) return
    if (this.status === 'stopping' || this.status === 'idle') return

    // 回听模式（P1）：无 AI 会话，播完即自然结束（stopReason = 'finished'）
    if (this.replayMode) {
      void this.stop('finished')
      return
    }

    // 全量句入库：把本轮播完（done）且未入库的句子存入内容库（fire-and-forget）
    this.flushDoneSentencesToLibrary()

    // 已达轮次/时长上限且队列播空 → 优雅停机（不请求新段）
    if (this.reachedLimit()) {
      this.tryGracefulStop()
      return
    }

    // 若仍有段生成在途（AI 还在写下一段），保持 generating
    if (this.hasSegmentInFlight()) {
      this.setStatus('generating')
      return
    }

    this.requestNextSegment()
  }

  /**
   * 段级提前量（lookahead）：句播完回调触发。队列未就绪句数 ≤ 阈值
   * 且无段生成在途时，提前请求 AI 生成下一段——当前段还在播、后台已开始
   * 生成下一段，消除「段播空 → 静默等 AI」的断档。
   * requestNextSegment 自带 stopped/running/stopping/reachedLimit 守卫。
   */
  private maybeAdvanceByLookahead(): void {
    if (this.stopped || !this.running) return
    if (this.status === 'stopping' || this.status === 'idle' || this.status === 'error') return
    if (this.reachedLimit()) return // 达上限不提前请求，交给 onQueueDrained 优雅停机
    if (this.hasSegmentInFlight()) return
    // 阈值判断：未就绪句数 ≤ SEGMENT_LOOKAHEAD_SENTENCES（含队列播空 = 0）
    // 已就绪（ready）的句还会继续播，此窗口内生成下一段刚好无缝衔接。
    if (this.player.pendingCount <= SEGMENT_LOOKAHEAD_SENTENCES) {
      log.debug('段级提前量：低水位触发提前生成下一段', {
        pendingCount: this.player.pendingCount,
        segmentIndex: this.segmentIndex,
      })
      this.requestNextSegment()
    }
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

    // 自动停止守卫（单点收敛）：轮次/时长上限命中 → 不再请求新段，交给优雅停机收尾
    if (this.reachedLimit()) {
      this.limitReached = true
      // 队列空且无在途合成 → 直接优雅停机（当前音频播完收尾）；否则等 onQueueDrained 判定
      this.tryGracefulStop()
      return
    }

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
      // 已达上限 → 优雅停机收尾
      if (this.reachedLimit()) {
        this.tryGracefulStop()
        return
      }
      this.requestNextSegment()
    }
  }

  /** 自动停止判定：轮次上限（已播段数 ≥ maxRounds）或时长上限（已播时长 ≥ maxSeconds）或睡眠定时命中 */
  private reachedLimit(): boolean {
    if (this.limitReached) return true
    if (this.maxRounds && this.segmentIndex >= this.maxRounds) return true
    if (this.maxSeconds && this.startedAt > 0 && Date.now() - this.startedAt >= this.maxSeconds * 1000) return true
    // 睡眠定时（P0-3）：到点即达上限（watchdog 另行淡出停止）；「播完本段」立即达上限（不再请求新段）
    if (this.sleepAfterSegment) return true
    if (this.sleepUntil > 0 && Date.now() >= this.sleepUntil) return true
    return false
  }

  /** 优雅停机：队列已空且无在途合成 → 走 stop() 三路中断收尾（当前音频播完、无残留队列） */
  private tryGracefulStop(): void {
    if (this.stopped || !this.running) return
    if (this.player.queueLength > 0 || this.player.hasPendingSynth || this.hasSegmentInFlight()) {
      // 队列尚有内容待播 → 交给 onQueueDrained 收尾触发；有合成/AI 在途则继续等
      return
    }
    log.info('已达上限（轮次/时长/睡眠定时），优雅停止', {
      maxRounds: this.maxRounds,
      maxSeconds: this.maxSeconds,
      segmentIndex: this.segmentIndex,
      sleep: this.sleepUntil > 0 || this.sleepAfterSegment,
    })
    // 停止原因：睡眠定时优先（sleepUntil 到点 / 播完本段），其次轮次命中，最后时长
    const reason: RadioBroadcastStopReason =
      this.sleepUntil > 0 || this.sleepAfterSegment
        ? 'sleep'
        : this.maxRounds && this.segmentIndex >= this.maxRounds
          ? 'max-rounds'
          : 'max-seconds'
    void this.stop(reason)
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
      // 本段请求可能是插话（P2-2）：请求失败时半双工恢复由下一次段收尾兜底，不滞留暂停
      this.interjectActive = false
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

  /** 段间续接提示（方向 + 已播摘要；P2：岔题/插话优先级最高） */
  private buildNextSegmentPrompt(): string {
    // 岔题（P2-1）：方向已切换，用岔题指令；本 prompt 只被消费一次
    if (this.topicSwitchPending) {
      this.topicSwitchPending = false
      return promptForSwitchTopic(this.direction?.text ?? '')
    }
    // 插话（P2-2）：插话内容作为本次请求，回复随下降沿入队（onSegmentEnded 恢复播放）
    if (this.queueInterject) {
      const text = this.queueInterject
      this.queueInterject = null
      this.interjectActive = true
      // 半双工：请求发出即暂停当前播放，回复到达后恢复
      this.player.pause()
      return promptForInterject(text)
    }
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

  /** 预检 mimo-tts 可用性（cap.voice voices.probe；自定义音色走 design/clone 透传） */
  private async probeMimo(): Promise<boolean> {
    try {
      const res = await probeVoice({ kind: 'preset', voice: this.voice })
      if (!res.ok) {
        const detail = res.error ?? '未知原因'
        // 仅鉴权类问题才提示查 Key；参数类错误（HTTP 400 等）原样透出，避免误导排查方向
        const isAuthIssue = /未配置 API Key|HTTP 401|Invalid API Key/i.test(detail)
        this.lastError = isAuthIssue
          ? `mimo-tts 不可用：${detail}（请在「语音合成」插件面板配置 API Key）`
          : `mimo-tts 不可用：${detail}`
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
