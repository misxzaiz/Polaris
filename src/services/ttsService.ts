import { generateUUID } from '@/utils/uuid';
/**
 * TTS 语音合成服务
 *
 * 使用 edge-tts-universal 实现文本转语音功能
 * 支持后台播放、中断控制、音量调节
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
   * 合成并播放语音
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
      // 合成音频
      const communicate = new Communicate(text, {
        voice: options?.voice || this.config.voice,
        rate: options?.rate || this.config.rate,
      });

      const chunks: Uint8Array[] = [];
      for await (const chunk of communicate.stream()) {
        // 检查是否已被停止
        if (this.isStopped || this.currentTaskId !== taskId) {
          log.debug('语音合成被中断');
          return;
        }

        if (chunk.type === 'audio' && chunk.data) {
          chunks.push(chunk.data);
        } else if (chunk.type === 'WordBoundary' && chunk.text && chunk.offset !== undefined) {
          // 触发进度回调
          this.callbacks.onProgress?.(chunk.text, chunk.offset, chunk.duration || 0);
        }
      }

      // 再次检查是否被停止
      if (this.isStopped || this.currentTaskId !== taskId) {
        return;
      }

      if (chunks.length === 0) {
        log.warn('未生成音频数据');
        this.setStatus('idle');
        return;
      }

      // 合并音频数据
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const audioBuffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        audioBuffer.set(chunk, offset);
        offset += chunk.length;
      }

      // 转换为 base64 Data URL（使用分块处理避免栈溢出）
      let binary = '';
      const chunkSize = 0x8000; // 32768 字符分块
      for (let i = 0; i < audioBuffer.length; i += chunkSize) {
        const subChunk = audioBuffer.subarray(i, Math.min(i + chunkSize, audioBuffer.length));
        binary += String.fromCharCode.apply(null, Array.from(subChunk));
      }
      const base64 = btoa(binary);
      const dataUrl = `data:audio/mp3;base64,${base64}`;

      // 创建音频元素并播放
      this.audio = new Audio(dataUrl);
      this.audio.volume = this.config.volume;

      // 绑定事件
      this.audio.onplay = () => {
        this.setStatus('playing');
        this.callbacks.onStart?.();
        log.debug('开始播放音频');
      };

      this.audio.onended = () => {
        this.setStatus('idle');
        this.callbacks.onEnd?.();
        this.audio = null;
        log.debug('音频播放完成');
      };

      this.audio.onerror = (e) => {
        this.setStatus('error');
        const errorMsg = typeof e === 'string' ? e : 'Audio playback failed';
        this.callbacks.onError?.(new Error(errorMsg));
        this.audio = null;
        log.error('音频播放失败', new Error(errorMsg));
      };

      // 开始播放
      await this.audio.play();

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

    if (this.audio) {
      this.audio.pause();
      this.audio.src = '';
      this.audio = null;
    }

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
