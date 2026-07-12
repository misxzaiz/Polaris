import { generateUUID } from '@/utils/uuid';
/**
 * TTS 语音合成服务
 *
 * 使用 edge-tts-universal 实现文本转语音功能
 * 支持后台播放、中断控制、音量调节
 *
 * 架构：合成（synthesize）与播放（playBlob）解耦——
 *   - synthesize: 纯合成，不触碰播放状态，可被并发调用（供流水线预取）
 *   - playBlob:   播放一个 Blob，Promise 在播放结束时 resolve
 *   - speak:      二者的组合，保持单次播放语义（打断上一次）
 *
 * 在非安全上下文（非 HTTPS / 非 localhost）下，edge-tts 因 crypto.subtle 不可用而失败，
 * 此时自动降级到浏览器内置 speechSynthesis API（质量较低但所有现代浏览器均支持）。
 */

import { Communicate } from 'edge-tts-universal';
import type { TTSConfig, TTSStatus, TTSVoice } from '@/types/speech';
import { DEFAULT_TTS_CONFIG } from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('TTSService');

/** TTS 事件回调 */
interface TTSCallbacks {
  onStatusChange?: (status: TTSStatus) => void;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (error: Error) => void;
  onProgress?: (text: string, offset: number, duration: number) => void;
}

/**
 * TTS 服务类
 *
 * 功能：
 * - 文本转语音合成
 * - 后台播放（不弹出播放器）
 * - 播放控制（播放、暂停、停止）
 * - 中断支持
 * - 音量调节
 */
export class TTSService {
  private config: TTSConfig = DEFAULT_TTS_CONFIG;
  private audio: HTMLAudioElement | null = null;
  private status: TTSStatus = 'idle';
  private callbacks: TTSCallbacks = {};
  private isStopped = false;
  private currentTaskId: string | null = null;
  private audioContext: AudioContext | null = null;
  /** 当前播放音频的 objectURL（结束/打断时 revoke 防泄漏） */
  private currentObjectUrl: string | null = null;
  /** 结清当前 playBlob 的 pending Promise（stop/接管时调用，避免调用方永久挂起） */
  private settleCurrentPlayback: (() => void) | null = null;

  /** 设置配置 */
  setConfig(config: Partial<TTSConfig>): void {
    this.config = { ...this.config, ...config };
    // 更新当前音频音量
    if (this.audio && config.volume !== undefined) {
      this.audio.volume = config.volume;
    }
    log.debug('TTS 配置已更新', { config: this.config });
  }

  /** 获取当前配置 */
  getConfig(): TTSConfig {
    return { ...this.config };
  }

  /** 设置回调 */
  setCallbacks(callbacks: TTSCallbacks): void {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  /** 获取当前状态 */
  getStatus(): TTSStatus {
    return this.status;
  }

  /**
   * 当前正在播放的音频元素（供 AudioContext 音量分析等只读消费，可能为 null）。
   * 每句合成会创建新元素，消费方需自行检测变化并重新挂载分析节点。
   */
  getCurrentAudio(): HTMLAudioElement | null {
    return this.audio;
  }

  /** 是否正在播放或合成 */
  isPlaying(): boolean {
    return this.status === 'playing' || this.status === 'synthesizing';
  }

  /** 是否已启用 */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  /**
   * 纯合成：文本 → 音频 Blob
   *
   * 与播放完全解耦：不打断当前播放、不修改全局状态（status/audio），
   * 供流水线预取（边播第 N 句边合成第 N+1 句）使用。
   *
   * @returns 音频 Blob；文本为空 / 无音频数据 / 被 signal 中止时返回 null；网络等错误抛异常
   */
  async synthesize(
    text: string,
    options?: {
      voice?: TTSVoice;
      rate?: string;
      signal?: AbortSignal;
      onProgress?: (text: string, offset: number, duration: number) => void;
    },
  ): Promise<Blob | null> {
    if (!text || !text.trim()) return null;

    const communicate = new Communicate(text, {
      voice: options?.voice || this.config.voice,
      rate: options?.rate || this.config.rate,
    });

    const chunks: Uint8Array[] = [];
    for await (const chunk of communicate.stream()) {
      if (options?.signal?.aborted) {
        log.debug('语音合成被中止');
        return null;
      }
      if (chunk.type === 'audio' && chunk.data) {
        chunks.push(chunk.data);
      } else if (chunk.type === 'WordBoundary' && chunk.text && chunk.offset !== undefined) {
        options?.onProgress?.(chunk.text, chunk.offset, chunk.duration || 0);
      }
    }

    if (options?.signal?.aborted) return null;
    if (chunks.length === 0) return null;
    return new Blob(chunks as BlobPart[], { type: 'audio/mp3' });
  }

  /**
   * 播放一个音频 Blob
   *
   * Promise 在「播放结束 / 出错 / 被 stop() 或下一次播放接管」时 resolve，
   * 调用方可借此实现按句衔接。开始前会自动结清上一段未完成的播放。
   */
  playBlob(blob: Blob): Promise<void> {
    // 接管：停掉并结清上一段播放，避免双声重叠
    this.detachCurrentAudio();

    return new Promise<void>((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audio.volume = this.config.volume;
      this.audio = audio;
      this.currentObjectUrl = url;

      let settled = false;
      const finish = (status: TTSStatus | null) => {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        if (this.audio === audio) {
          this.audio = null;
          this.currentObjectUrl = null;
          this.settleCurrentPlayback = null;
        }
        if (status) this.setStatus(status);
        resolve();
      };

      // 注册结清入口：stop() / 下一次 playBlob 接管时提前 resolve
      this.settleCurrentPlayback = () => finish(null);

      audio.onplay = () => {
        this.setStatus('playing');
        this.callbacks.onStart?.();
        log.debug('开始播放音频');
      };

      audio.onended = () => {
        this.callbacks.onEnd?.();
        log.debug('音频播放完成');
        finish('idle');
      };

      audio.onerror = (e) => {
        const errorMsg = typeof e === 'string' ? e : 'Audio playback failed';
        this.callbacks.onError?.(new Error(errorMsg));
        log.error('音频播放失败', new Error(errorMsg));
        finish('error');
      };

      audio.play().catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.callbacks.onError?.(error);
        log.error('音频播放失败', error);
        finish('error');
      });
    });
  }

  /** 停掉当前音频元素、revoke objectURL 并结清其播放 Promise */
  private detachCurrentAudio(): void {
    const settle = this.settleCurrentPlayback;
    this.settleCurrentPlayback = null;

    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    settle?.();
  }

  /**
   * 合成并播放语音（synthesize + playBlob 的组合）
   *
   * 注意：Promise 在「播放结束」时 resolve（而非播放开始），
   * 调用方 await 后即可安全执行"播报完成后"的逻辑（如恢复语音识别）。
   *
   * @param text 要朗读的文本
   * @param options 可选配置
   * @param options.force 是否强制播放（绕过 enabled 检查）
   */
  async speak(text: string, options?: { voice?: TTSVoice; rate?: string; force?: boolean }): Promise<void> {
    if (!options?.force && !this.config.enabled) {
      log.debug('TTS 未启用，跳过播放');
      return;
    }

    if (!text || !text.trim()) {
      log.debug('文本为空，跳过播放');
      return;
    }

    // 停止之前的播放
    this.stop();

    this.isStopped = false;
    this.currentTaskId = generateUUID();
    const taskId = this.currentTaskId;

    this.setStatus('synthesizing');
    log.info('开始合成语音', { textLength: text.length, voice: options?.voice || this.config.voice });

    try {
      const blob = await this.synthesize(text, {
        voice: options?.voice,
        rate: options?.rate,
        onProgress: (t, offset, duration) => this.callbacks.onProgress?.(t, offset, duration),
      });

      // 检查是否被停止
      if (this.isStopped || this.currentTaskId !== taskId) {
        log.debug('语音合成被中断');
        return;
      }

      if (!blob) {
        log.warn('未生成音频数据');
        this.setStatus('idle');
        return;
      }

      // 播放（结束/被打断后 resolve）
      await this.playBlob(blob);

    } catch (error) {
      if (this.isStopped) {
        log.debug('语音合成被中断');
        return;
      }

      // edge-tts 失败 → 尝试浏览器内置 TTS 降级
      if (TTSService.browserTTSSupported && !window.isSecureContext) {
        log.info('edge-tts 失败（非安全上下文），降级到浏览器内置 TTS');
        try {
          await this.speakWithBrowserTTS(text, options?.rate);
          return;
        } catch (fallbackErr) {
          log.error('浏览器内置 TTS 也失败', fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr)));
        }
      }

      this.setStatus('error');
      const err = error instanceof Error ? error : new Error(String(error));
      this.callbacks.onError?.(err);
      log.error('语音合成失败', err);
    }
  }

  /** 暂停播放 */
  pause(): void {
    if (this.audio && this.status === 'playing') {
      this.audio.pause();
      this.setStatus('paused');
      log.debug('音频已暂停');
    }
  }

  /** 恢复播放 */
  resume(): void {
    if (this.audio && this.status === 'paused') {
      this.audio.play();
      this.setStatus('playing');
      log.debug('音频已恢复');
    }
  }

  /** 停止播放 */
  stop(): void {
    log.debug('停止 TTS 播放');
    this.isStopped = true;
    this.currentTaskId = null;

    // 停掉音频 + revoke objectURL + 结清 pending 的 playBlob Promise
    this.detachCurrentAudio();

    if (this.status !== 'idle') {
      this.setStatus('idle');
    }
  }

  /** 切换播放/暂停 */
  toggle(): void {
    if (this.status === 'playing') {
      this.pause();
    } else if (this.status === 'paused') {
      this.resume();
    }
  }

  /** 设置音量 */
  setVolume(volume: number): void {
    const safeVolume = Math.max(0, Math.min(1, volume));
    this.config.volume = safeVolume;
    if (this.audio) {
      this.audio.volume = safeVolume;
    }
    log.debug('音量已设置', { volume: safeVolume });
  }

  /** 获取音量 */
  getVolume(): number {
    return this.config.volume;
  }

  /** 销毁服务 */
  destroy(): void {
    this.stop();
    this.callbacks = {};
    this.audioContext?.close();
    this.audioContext = null;
    log.debug('TTS 服务已销毁');
  }

  // ========================================
  // 浏览器内置 speechSynthesis 降级
  // ========================================

  /**
   * 将 edge-tts 格式的语速（如 "+20%", "-10%"）转换为 speechSynthesis 的 rate 值
   * speechSynthesis rate: 0.1 ~ 10, 默认 1.0
   */
  private static convertRateForBrowser(rate: string): number {
    const match = rate.match(/([+-]?\d+)%/);
    if (!match) return 1.0;
    const percent = parseInt(match[1], 10);
    // +20% → 1.2, -30% → 0.7
    return Math.max(0.1, Math.min(10, 1 + percent / 100));
  }

  /** 浏览器 speechSynthesis 是否可用 */
  static get browserTTSSupported(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  /**
   * 使用浏览器内置 speechSynthesis 播放文本（降级路径）
   */
  private speakWithBrowserTTS(text: string, rate?: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!TTSService.browserTTSSupported) {
        reject(new Error('speechSynthesis API 不可用'));
        return;
      }

      const utterance = new SpeechSynthesisUtterance(text);
      // 从 voice 名称中提取语言代码（如 "zh-CN-XiaoxiaoNeural" → "zh-CN"）
      const voiceName = this.config.voice || 'zh-CN-XiaoxiaoNeural';
      const langCode = voiceName.split('-').slice(0, 2).join('-');
      utterance.lang = langCode;
      utterance.rate = TTSService.convertRateForBrowser(rate || this.config.rate);
      utterance.volume = this.config.volume;

      // 尝试选择匹配语言的语音
      const voices = window.speechSynthesis.getVoices();
      const zhVoice = voices.find(v => v.lang.startsWith('zh'));
      if (zhVoice) {
        utterance.voice = zhVoice;
      }

      utterance.onstart = () => {
        this.setStatus('playing');
        this.callbacks.onStart?.();
        log.debug('浏览器 TTS 开始播放');
      };

      utterance.onend = () => {
        this.setStatus('idle');
        this.callbacks.onEnd?.();
        log.debug('浏览器 TTS 播放完成');
        resolve();
      };

      utterance.onerror = (e) => {
        log.error('浏览器 TTS 播放失败', new Error(e.error));
        reject(new Error(e.error));
      };

      this.setStatus('synthesizing');
      window.speechSynthesis.speak(utterance);
    });
  }

  private setStatus(status: TTSStatus): void {
    this.status = status;
    this.callbacks.onStatusChange?.(status);
  }
}

// 单例导出
export const ttsService = new TTSService();
