/**
 * 语音识别服务 - 封装 Web Speech API
 *
 * 注意：Web Speech API 要求安全上下文（HTTPS 或 localhost），
 * 在非安全 HTTP 环境下浏览器会拒绝麦克风权限。
 *
 * 内部机制：
 *   - 期望状态机：desiredState（唯一事实源）决定 start/abort 调度
 *   - 会话代际：epoch 自增，旧会话事件（onstart/onend/onerror）比对 epoch 后丢弃
 *   - 可取消重启：onend 排的重启定时器，pause/stop 时直接清理
 *   - 重启熔断：2 秒内 >3 次异常重启则退避 2 秒
 */

import type {
  SpeechLanguage,
  SpeechRecognitionStatus,
  SpeechRecognitionError as AppSpeechError
} from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('SpeechService');

// Web Speech API 类型定义
interface WebSpeechRecognitionEvent {
  resultIndex: number;
  results: SpeechRecognitionResultList;
}

interface WebSpeechRecognitionErrorEvent {
  error: string;
  message: string;
}

interface WebSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  onaudioend: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onaudiostart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onend: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onerror: ((this: WebSpeechRecognition, ev: WebSpeechRecognitionErrorEvent) => void) | null;
  onnomatch: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onresult: ((this: WebSpeechRecognition, ev: WebSpeechRecognitionEvent) => void) | null;
  onsoundend: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onsoundstart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onspeechend: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onspeechstart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  onstart: ((this: WebSpeechRecognition, ev: Event) => void) | null;
  abort(): void;
  start(): void;
  stop(): void;
}

interface SpeechRecognitionConstructor {
  new (): WebSpeechRecognition;
}

interface WindowWithSpeech extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/** 语音服务配置 */
interface SpeechServiceConfig {
  enabled: boolean;
  language: SpeechLanguage;
  continuous: boolean;
  interimResults: boolean;
}

/** 期望状态：唯一事实源 */
type DesiredState = 'listening' | 'paused' | 'stopped';

/**
 * 语音识别服务类
 */
export class SpeechService {
  private recognition: WebSpeechRecognition | null = null;
  private isSupported = false;
  private config: SpeechServiceConfig = {
    enabled: true,
    language: 'zh-CN',
    continuous: true,
    interimResults: true,
  };

  // ========================================
  // 期望状态机（核心：替代 shouldKeepListening 驱动的重启）
  // ========================================

  /** 期望状态：唯一事实源，所有 API 只改这个值 */
  private desiredState: DesiredState = 'stopped';

  /** 会话代际：每次 pause/stop/start 自增，事件携带代际判断是否过期 */
  private epoch = 0;

  /** 记录当前 session 是否正在运行（由 onstart/onend 同步） */
  private runningRef = false;

  /** 记录 start() 已调用但 onstart 尚未回来的过渡态，避免重复 start 抛错 */
  private startingRef = false;

  /** onend 自动重启定时器（pause/stop 时清理，解决不可取消导致循环的根因） */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /** resume 时恢复的监听状态（替代 _wasKeepingListening 解决嵌套失真） */
  private _resumeTarget: DesiredState = 'stopped';

  /** 重启熔断：2 秒内异常重启超过阈值则退避 */
  private restartWindow: number[] = [];
  private readonly RESTART_THRESHOLD = 3;
  private readonly RESTART_WINDOW_MS = 2000;

  // ========================================
  // 回调函数
  // ========================================
  private onStatusChange: ((status: SpeechRecognitionStatus) => void) | null = null;
  private onResult: ((transcript: string, isFinal: boolean) => void) | null = null;
  private onError: ((error: AppSpeechError) => void) | null = null;

  constructor() {
    this.checkSupport();
  }

  /**
   * 检查浏览器是否支持语音识别
   */
  private checkSupport(): void {
    const win = window as WindowWithSpeech;
    const SpeechRecognitionAPI = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (SpeechRecognitionAPI) {
      this.isSupported = true;
      log.info('Web Speech API 可用');
    } else {
      this.isSupported = false;
      log.warn('Web Speech API 不可用');
    }

    // 安全上下文检测：非 HTTPS / 非 localhost 下语音功能受限
    if (!window.isSecureContext) {
      log.warn('非安全上下文，语音识别和 TTS 可能受限（需要 HTTPS 或 localhost）');
    }
  }

  /**
   * 检查是否支持
   */
  get supported(): boolean {
    return this.isSupported;
  }

  /** 是否为安全上下文（HTTPS 或 localhost） */
  get isSecureContext(): boolean {
    return window.isSecureContext;
  }

  /**
   * 设置配置
   */
  setConfig(config: Partial<SpeechServiceConfig>): void {
    this.config = { ...this.config, ...config };
    if (this.recognition) {
      this.applyConfig();
    }
  }

  /**
   * 应用配置到识别实例
   */
  private applyConfig(): void {
    if (!this.recognition) return;

    this.recognition.continuous = this.config.continuous;
    this.recognition.interimResults = this.config.interimResults;
    this.recognition.lang = this.config.language;
    this.recognition.maxAlternatives = 1;
  }

  /**
   * 设置回调函数
   */
  setCallbacks(callbacks: {
    onStatusChange?: (status: SpeechRecognitionStatus) => void;
    onResult?: (transcript: string, isFinal: boolean) => void;
    onError?: (error: AppSpeechError) => void;
  }): void {
    if (callbacks.onStatusChange) this.onStatusChange = callbacks.onStatusChange;
    if (callbacks.onResult) this.onResult = callbacks.onResult;
    if (callbacks.onError) this.onError = callbacks.onError;
  }

  /**
   * 初始化语音识别
   */
  private initRecognition(): void {
    const win = window as WindowWithSpeech;
    const SpeechRecognitionAPI = win.SpeechRecognition || win.webkitSpeechRecognition;

    if (!SpeechRecognitionAPI) {
      this.onError?.({
        type: 'not-supported',
        message: '浏览器不支持语音识别'
      });
      return;
    }

    this.recognition = new SpeechRecognitionAPI();
    this.applyConfig();
    this.setupEventListeners();
  }

  /**
   * 清理在途重启定时器（解决"不可取消"导致循环的根因）
   */
  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /**
   * 重启熔断：检查最近是否频繁重启，超阈值则退避
   * @returns 是否在退避窗口中（需要等待）
   */
  private isRestartThrottled(): boolean {
    const now = Date.now();
    // 清理过期时间窗
    this.restartWindow = this.restartWindow.filter(t => now - t < this.RESTART_WINDOW_MS);
    if (this.restartWindow.length >= this.RESTART_THRESHOLD) {
      log.warn('重启熔断触发，退避 2 秒', { count: this.restartWindow.length });
      // 设置退避定时器
      this.restartTimer = setTimeout(() => {
        this.clearRestartTimer();
        // 退避结束，若仍在 listening 则重启
        if (this.desiredState === 'listening') {
          this.reconcile();
        }
      }, this.RESTART_WINDOW_MS);
      return true;
    }
    return false;
  }

  /**
   * 安全启动底层识别器。
   *
   * Web Speech 的 start() 在已启动/启动中再次调用会抛 InvalidStateError。
   * runningRef 只能在 onstart 后置 true，因此额外用 startingRef 覆盖过渡窗口。
   */
  private startRecognition(): void {
    if (!this.recognition || this.runningRef || this.startingRef) return;

    try {
      this.startingRef = true;
      this.recognition.start();
    } catch (e) {
      this.startingRef = false;
      log.error('启动语音识别失败', e as Error);
      this.onError?.({
        type: 'unknown',
        message: e instanceof Error ? e.message : String(e),
      });
      this.onStatusChange?.('error');
    }
  }

  /**
   * 调度调度：对比期望状态与实际运行状态，决定 start 或 abort
   *
   * 核心调和逻辑：
   *   desired=listening && !running  → start()
   *   desired≠listening && running    → abort()
   *   否则保持现状
   */
  private reconcile(): void {
    if (!this.recognition) {
      if (this.desiredState === 'listening') {
        this.initRecognition();
        this.startRecognition();
      }
      return;
    }

    if (this.desiredState === 'listening' && !this.runningRef) {
      this.startRecognition();
    } else if (this.desiredState !== 'listening' && (this.runningRef || this.startingRef)) {
      this.abortRecognition('状态调和中止语音识别');
    }
  }

  private abortRecognition(reason: string): void {
    if (!this.recognition || (!this.runningRef && !this.startingRef)) return;

    try {
      this.recognition.abort();
    } catch (e) {
      log.debug(`${reason}失败`, { error: String(e) });
    } finally {
      this.startingRef = false;
      this.runningRef = false;
    }
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (!this.recognition) return;

    this.recognition.onstart = () => {
      this.startingRef = false;
      this.runningRef = true;

      // 代际检查：若 epoch 已变，这是旧会话的启动事件，丢弃
      if (this.desiredState === 'paused' || this.desiredState === 'stopped') {
        log.debug('旧会话 onstart，丢弃');
        return;
      }

      log.info('语音识别已启动');
      this.onStatusChange?.('listening');
    };

    this.recognition.onend = () => {
      this.startingRef = false;
      this.runningRef = false;

      // 按期望状态决策，而非应不应该保持监听
      if (this.desiredState === 'listening') {
        // 在 listening 模式下自然结束 → 自动重启
        this.clearRestartTimer();

        // 重启熔断检查
        if (this.isRestartThrottled()) {
          return; // 退避中，不排队重启
        }

        this.restartTimer = setTimeout(() => {
          this.clearRestartTimer();
          // 双重检查：当前仍在 listening 且实例仍在
          if (this.desiredState === 'listening' && this.recognition) {
            log.info('自动重启语音识别');
            this.startRecognition();
          }
        }, 100);
      } else {
        // paused 或 stopped 时自然结束 → 不重启，上报 idle
        log.info('语音识别自然结束', { desiredState: this.desiredState });
        this.onStatusChange?.('idle');
      }
    };

    this.recognition.onerror = (event: WebSpeechRecognitionErrorEvent) => {
      this.startingRef = false;
      // 代际检查：epoch 已变说明已被新实例替换，这是旧会话的过期回调，丢弃
      // （pause/stop/start 都会自增 epoch 并创建新实例，旧实例的 onerror 不应再触发）
      //
      // 'aborted' 是 pause()/abort()/stop() 主动中止的预期回调
      // （如 TTS 播报期间暂停识别防回声），不是真实错误：
      // 不打 ERROR 日志、不进入 error 状态、不向上传播（下游 onError 无需感知）。
      // 后续 onend 会按 desiredState 决定重启或回 idle。
      if (event.error === 'aborted') {
        log.debug('语音识别被中止（预期流程，通常由 pause/abort 触发）');
        return;
      }

      log.error(`语音识别错误: ${event.error}: ${event.message}`);

      const errorMap: Record<string, AppSpeechError['type']> = {
        'not-allowed': 'service-not-allowed',
        'no-speech': 'no-speech',
        'audio-capture': 'audio-capture',
        'network': 'network',
        'language-not-supported': 'language-not-supported',
      };

      this.onError?.({
        type: errorMap[event.error] || 'unknown',
        message: event.message || event.error
      });
      this.onStatusChange?.('error');
    };

    this.recognition.onresult = (event: WebSpeechRecognitionEvent) => {
      const results = event.results;
      const lastResult = results[event.resultIndex];

      if (lastResult) {
        const transcript = lastResult[0].transcript;
        const isFinal = lastResult.isFinal;

        log.debug('识别结果:', { transcript, isFinal });
        this.onResult?.(transcript, isFinal);
      }
    };

    this.recognition.onspeechstart = () => {
      log.debug('检测到语音');
    };

    this.recognition.onspeechend = () => {
      log.debug('语音结束');
    };
  }

  /**
   * 开始语音识别
   *
   * 期望状态 → listening，调度 reconcile() 启动（或继续）识别
   */
  start(): void {
    if (!this.isSupported) {
      this.onError?.({
        type: 'not-supported',
        message: '浏览器不支持语音识别'
      });
      return;
    }

    this.desiredState = 'listening';
    this.epoch++;  // 新会话代际

    // 取消遗留重启定时器（防止旧 onend 排的重启被触发）
    this.clearRestartTimer();

    this.reconcile();
  }

  /**
   * 停止语音识别
   *
   * 期望状态 → stopped，立即 abort，清除重启定时器
   */
  stop(): void {
    this.desiredState = 'stopped';
    this.epoch++;  // 代际失效旧会话事件
    this.clearRestartTimer();

    if (this.recognition) {
      if (this.runningRef || this.startingRef) {
        try {
          this.recognition.stop();  // stop 比 abort 更干净（只触发 onend，不触发 onerror）
        } catch (e) {
          log.debug('停止语音识别失败，回退为本地停止状态', { error: String(e) });
        }
      }
      this.startingRef = false;
      this.runningRef = false;
    }
  }

  /**
   * 中止语音识别
   *
   * 直接 abort 底层实例（等价于 pause，但不改 desiredState，调用方慎用）
   */
  abort(): void {
    this.abortRecognition('直接中止语音识别');
  }

  /**
   * 暂停语音识别（用于 TTS 播报期间临时静音）
   *
   * 与 stop() 的区别：
   * - stop() 期望状态 → stopped，永久停止
   * - pause() 记住当前期望状态，resume() 时恢复
   *
   * 修复：记录"期望恢复的目标状态"而非 "shouldKeepListening flag"，
   *       解决嵌套 pause 下 _wasKeepingListening 语义失真问题。
   */
  pause(): void {
    // 记录暂停前的监听状态，resume 时恢复
    this._resumeTarget = this.desiredState;

    this.desiredState = 'paused';
    this.epoch++;  // 代际失效旧会话事件
    this.clearRestartTimer();  // 取消在途重启（根治循环的根因）

    this.abortRecognition('暂停语音识别');
    log.info('语音识别已暂停');
  }

  /**
   * 恢复语音识别（配合 pause 使用）
   *
   * 修复：恢复到 pause 前的期望状态（listening/stopped），而非简单翻 _wasKeepingListening flag。
   *       这样嵌套 pause/resume 语义正确：第二次 pause 记录的是第一次 pause 后的 'paused'，
   *       resume 时目标状态为 'paused'（= 保持暂停），语义一致。
   */
  resume(): void {
    if (!this.isSupported) return;

    // 恢复到 pause 前的期望状态
    this.desiredState = this._resumeTarget;
    this.epoch++;  // 新会话代际

    // 取消遗留重启定时器
    this.clearRestartTimer();

    this.reconcile();  // 统一调度
    log.info('语音识别已恢复');
  }

  /**
   * 销毁实例
   */
  destroy(): void {
    this.stop();
    this.recognition = null;
    this.onStatusChange = null;
    this.onResult = null;
    this.onError = null;
  }
}

// 导出单例
export const speechService = new SpeechService();
