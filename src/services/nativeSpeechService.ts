/**
 * 原生语音识别桥接服务
 *
 * 在 Android WebView 中，Web Speech API（window.SpeechRecognition）不可用，
 * 但原生层通过 @JavascriptInterface 暴露了 window.SpeechBridge（见
 * polaris-mobile SpeechBridge.kt）。本服务封装该桥接，提供与 SpeechService
 * 兼容的回调接口，使语音听写/语音伙伴在移动端可无感回退到原生识别。
 *
 * 接口语义对齐 Web Speech API：
 *   - start(lang) / stop() / destroy()
 *   - 回调：onStart / onResult({transcript, isFinal}) / onError({code, message}) / onEnd
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('NativeSpeech');

/** SpeechBridge JS @JavascriptInterface 形状 */
interface SpeechBridgeHandle {
  getSupported(): boolean;
  setHandlers(handlers: object): void;
  start(lang: string): void;
  stop(): void;
  destroy(): void;
}

interface WindowWithSpeechBridge extends Window {
  SpeechBridge?: SpeechBridgeHandle;
}

/** 一个会话的识别结果回调 */
export interface NativeSpeechCallbacks {
  onStart?: () => void;
  onResult?: (transcript: string, isFinal: boolean) => void;
  onError?: (code: string, message: string) => void;
  onEnd?: () => void;
}

/** 原生错误码 → Web Speech 错误类型映射 */
const ERROR_CODE_MAP: Record<string, string> = {
  'not-supported': 'not-supported',
  'no-speech': 'no-speech',
  'audio-capture': 'audio-capture',
  'network': 'network',
  'not-allowed': 'service-not-allowed',
  'language-not-supported': 'language-not-supported',
  'busy': 'unknown',
  'unknown': 'unknown',
};

class NativeSpeechService {
  private get bridge(): SpeechBridgeHandle | null {
    return (window as WindowWithSpeechBridge).SpeechBridge ?? null;
  }

  /** 是否可用（原生桥接存在且系统支持） */
  get supported(): boolean {
    try {
      return !!this.bridge && !!this.bridge.getSupported();
    } catch {
      return false;
    }
  }

  /**
   * 启动识别。注入回调对象后调用原生 start。
   * 原生层通过 evaluateJavascript 调用注入对象上的方法。
   */
  start(language: string, callbacks: NativeSpeechCallbacks): void {
    const bridge = this.bridge;
    if (!bridge) {
      callbacks.onError?.('not-supported', '原生语音桥接不可用');
      callbacks.onEnd?.();
      return;
    }

    // 注入全局回调对象，供原生 evaluateJavascript 调用
    const handlers: Record<string, (payload?: unknown) => void> = {
      onStart: () => callbacks.onStart?.(),
      onResult: (payload) => {
        const p = (payload ?? {}) as { transcript?: string; isFinal?: boolean };
        callbacks.onResult?.(p.transcript ?? '', !!p.isFinal);
      },
      onError: (payload) => {
        const p = (payload ?? {}) as { code?: string; message?: string };
        const code = ERROR_CODE_MAP[p.code ?? 'unknown'] ?? 'unknown';
        callbacks.onError?.(code, p.message ?? '');
      },
      onEnd: () => callbacks.onEnd?.(),
    };

    (window as unknown as Record<string, unknown>).__polarisSpeechHandlers = handlers;
    bridge.setHandlers(handlers);

    try {
      bridge.start(language);
    } catch (e) {
      log.error('原生语音启动失败', e as Error);
      callbacks.onError?.('unknown', e instanceof Error ? e.message : String(e));
      callbacks.onEnd?.();
    }
  }

  stop(): void {
    try {
      this.bridge?.stop();
    } catch (e) {
      log.debug('原生语音停止失败', { error: String(e) });
    }
  }

  destroy(): void {
    try {
      this.bridge?.destroy();
    } catch (e) {
      log.debug('原生语音销毁失败', { error: String(e) });
    }
  }
}

/** 单例 */
export const nativeSpeechService = new NativeSpeechService();