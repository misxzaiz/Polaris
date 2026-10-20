/**
 * voiceBroadcast — 语音「停止」口令监听器
 *
 * 复用既有 speechService（Web Speech API + Android 原生桥回退，含代际/熔断）。
 * 站内新建独立 SpeechService 实例，不碰全局听写单例（speechService）。
 *
 * 半双工权衡（关键）：
 *   voiceCompanion 用「speaking 时 pause 识别」防回声——但对播报场景不适用：
 *   用户说「停止」恰恰发生在播放中，半双工会屏蔽掉口令。故本监听器在播报期间
 *   **常开监听（全双工）**，命中「停止/停/暂停/stop」即触发 onStop。
 *   回声风险：AI 播报内容若恰好含「停止」会被误停；不破坏性（可再开始），
 *   且面板提供「语音停止」开关可关闭。
 *
 * 失败语义：识别不可用（非安全上下文 / 无权限 / 浏览器不支持）→ 静默降级，
 *   不阻塞播报（按钮停止为兜底）。
 */
import { SpeechService } from '@/services/speechService'
import { createLogger } from '@/utils/logger'

const log = createLogger('VoiceStopWatcher')

/** 触发停止的语音关键词（final 结果匹配，任一命中即停止） */
const STOP_KEYWORDS = /(停止|停|暂停|stop)/i

export interface VoiceStopWatcherCallbacks {
  /** 命中「停止」口令 */
  onStop?: () => void
}

export class VoiceStopWatcher {
  /** 独立识别实例（不碰全局听写单例） */
  private service: SpeechService | null = null
  /** 已启动（stop() 置 false，晚到回调据此丢弃） */
  private active = false
  private callbacks: VoiceStopWatcherCallbacks = {}

  setCallbacks(cb: VoiceStopWatcherCallbacks): void {
    this.callbacks = { ...this.callbacks, ...cb }
  }

  /** 开始监听（识别不可用则静默降级） */
  start(): void {
    if (this.active) return
    this.active = true

    this.service = new SpeechService()
    if (!this.service.supported) {
      log.warn('语音识别不可用，停止口令降级为按钮兜底')
      return
    }

    this.service.setConfig({ language: 'zh-CN', continuous: true, interimResults: false })
    this.service.setCallbacks({
      onResult: (transcript, isFinal) => {
        if (!isFinal || !this.active) return
        if (STOP_KEYWORDS.test(transcript.trim())) {
          log.info('命中停止口令', { transcript })
          this.callbacks.onStop?.()
        }
      },
      onError: (err) => {
        // 识别不可用/超时等：静默降级，不阻塞播报
        log.warn('语音识别异常（停止口令降级为按钮兜底）', { type: err.type })
      },
    })
    this.service.start()
    log.info('语音停止口令监听已启动')
  }

  /** 停止监听并释放实例 */
  stop(): void {
    if (!this.active) return
    this.active = false
    this.service?.destroy()
    this.service = null
    log.info('语音停止口令监听已停止')
  }
}
