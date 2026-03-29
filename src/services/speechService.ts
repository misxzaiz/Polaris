/**
 * 语音识别服务 - 封装 Web Speech API
 */

import type {
  SpeechConfig,
  SpeechRecognitionStatus,
  SpeechRecognitionError as AppSpeechError
} from '../types/speech';
import { DEFAULT_SPEECH_CONFIG } from '../types/speech';
import { createLogger } from '../utils/logger';

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

/**
 * 语音识别服务类
 */
export class SpeechService {
  private recognition: WebSpeechRecognition | null = null;
  private isSupported = false;
  private config: SpeechConfig = DEFAULT_SPEECH_CONFIG;
  private retryCount = 0;
  private maxRetries = 1;

  // 回调函数
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
  }

  /**
   * 检查是否支持
   */
  get supported(): boolean {
    return this.isSupported;
  }

  /**
   * 设置配置
   */
  setConfig(config: Partial<SpeechConfig>): void {
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
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    if (!this.recognition) return;

    this.recognition.onstart = () => {
      log.info('语音识别已启动');
      this.onStatusChange?.('listening');
    };

    this.recognition.onend = () => {
      log.info('语音识别已结束');
      this.onStatusChange?.('idle');
    };

    this.recognition.onerror = (event: WebSpeechRecognitionErrorEvent) => {
      log.error('语音识别错误:', new Error(`${event.error}: ${event.message}`));

      const errorMap: Record<string, AppSpeechError['type']> = {
        'not-allowed': 'service-not-allowed',
        'no-speech': 'no-speech',
        'audio-capture': 'audio-capture',
        'network': 'network',
        'aborted': 'aborted',
        'language-not-supported': 'language-not-supported',
      };

      // no-speech 错误自动重试一次
      if (event.error === 'no-speech' && this.retryCount < this.maxRetries) {
        this.retryCount++;
        log.info('no-speech 错误，自动重试');
        setTimeout(() => {
          try {
            this.recognition?.start();
          } catch (e) {
            // 忽略重复启动错误
          }
        }, 100);
        return;
      }

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
   */
  start(): void {
    if (!this.isSupported) {
      this.onError?.({
        type: 'not-supported',
        message: '浏览器不支持语音识别'
      });
      return;
    }

    // 重置重试计数
    this.retryCount = 0;

    if (!this.recognition) {
      this.initRecognition();
    }

    try {
      this.recognition?.start();
    } catch (e) {
      // 如果已经在运行，先停止再启动
      if (e instanceof Error && e.message.includes('already started')) {
        this.recognition?.stop();
        setTimeout(() => this.recognition?.start(), 100);
      } else {
        throw e;
      }
    }
  }

  /**
   * 停止语音识别
   */
  stop(): void {
    if (this.recognition) {
      this.recognition.stop();
    }
  }

  /**
   * 中止语音识别
   */
  abort(): void {
    if (this.recognition) {
      this.recognition.abort();
    }
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
