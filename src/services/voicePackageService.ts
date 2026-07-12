/**
 * 语音包预缓存服务
 *
 * 预生成常用通知语音的音频数据并缓存，实现零延迟播放。
 * 原理：在应用初始化时 / 配置变更时，用 edge-tts 预合成所有通知文本，
 *       存为 base64 data URL Map，播放时直接 new Audio(dataUrl).play()。
 *
 * 缓存策略：
 * - 应用初始化时预生成所有已配置的通知文本
 * - 配置变更时增量更新
 * - 缓存 miss 时降级到实时合成（由 voiceNotificationService 处理）
 */

import { Communicate } from 'edge-tts-universal';
import type { TTSVoice } from '@/types/speech';
import { createLogger } from '@/utils/logger';

const log = createLogger('VoicePackage');

/** 缓存条目 */
interface CachedVoice {
  /** base64 data URL */
  dataUrl: string;
  /** 生成时间戳 */
  createdAt: number;
}

/**
 * 语音包服务
 */
class VoicePackageService {
  /** 音频缓存：文本 → dataUrl */
  private cache = new Map<string, CachedVoice>();

  /** 当前使用的语音角色（用于判断是否需要重新生成） */
  private currentVoice: string = '';

  /** 当前使用的语速 */
  private currentRate: string = '';

  /** 是否正在生成 */
  private isGenerating = false;

  /**
   * 批量预生成语音包
   * @param texts 要缓存的文本列表
   * @param voice 语音角色
   * @param rate 语速
   */
  async preGenerate(texts: string[], voice: string, rate: string): Promise<void> {
    // 检查是否需要重新生成
    if (this.currentVoice === voice && this.currentRate === rate) {
      const allCached = texts.every(t => this.cache.has(t));
      if (allCached) {
        log.debug('语音包已是最新，跳过生成');
        return;
      }
    }

    if (this.isGenerating) {
      log.debug('语音包正在生成中，跳过');
      return;
    }

    this.isGenerating = true;
    log.info('开始预生成语音包', { count: texts.length, voice });

    const voiceRef = voice;
    const rateRef = rate;

    try {
      // 并发生成，限制并发数
      const batchSize = 3;
      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        await Promise.allSettled(
          batch.map(text => this.generateSingle(text, voiceRef, rateRef))
        );
      }

      this.currentVoice = voice;
      this.currentRate = rate;
      log.info('语音包预生成完成', { cached: this.cache.size });
    } catch (error) {
      log.error('语音包预生成失败', error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.isGenerating = false;
    }
  }

  /**
   * 生成单条语音并缓存
   */
  private async generateSingle(text: string, voice: string, rate: string): Promise<void> {
    // 已缓存则跳过
    if (this.cache.has(text) && this.currentVoice === voice && this.currentRate === rate) {
      return;
    }

    try {
      const communicate = new Communicate(text, {
        voice: voice as TTSVoice,
        rate,
      });

      const chunks: Uint8Array[] = [];
      for await (const chunk of communicate.stream()) {
        if (chunk.type === 'audio' && chunk.data) {
          chunks.push(chunk.data);
        }
      }

      if (chunks.length === 0) {
        log.warn('语音生成无数据', { text });
        return;
      }

      // 合并 + 转 base64
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const buffer = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        buffer.set(chunk, offset);
        offset += chunk.length;
      }

      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < buffer.length; i += chunkSize) {
        const sub = buffer.subarray(i, Math.min(i + chunkSize, buffer.length));
        binary += String.fromCharCode.apply(null, Array.from(sub));
      }
      const base64 = btoa(binary);
      const dataUrl = `data:audio/mp3;base64,${base64}`;

      this.cache.set(text, { dataUrl, createdAt: Date.now() });
      log.debug('语音已缓存', { text, size: base64.length });
    } catch (error) {
      log.debug('单条语音生成失败', { text, error: String(error) });
    }
  }

  /**
   * 获取缓存的音频 dataUrl
   * @returns dataUrl 或 null（缓存未命中）
   */
  getCached(text: string): string | null {
    return this.cache.get(text)?.dataUrl ?? null;
  }

  /**
   * 播放缓存的语音（零延迟）
   * @returns 是否成功播放
   */
  playCached(text: string, volume: number = 1.0): boolean {
    const cached = this.cache.get(text);
    if (!cached) return false;

    try {
      const audio = new Audio(cached.dataUrl);
      audio.volume = volume;
      audio.play().catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 播放缓存语音并返回 Promise（等待播放结束）
   */
  playCachedAsync(text: string, volume: number = 1.0): Promise<boolean> {
    const cached = this.cache.get(text);
    if (!cached) return Promise.resolve(false);

    return new Promise((resolve) => {
      try {
        const audio = new Audio(cached.dataUrl);
        audio.volume = volume;

        audio.onended = () => resolve(true);
        audio.onerror = () => resolve(false);

        audio.play().catch(() => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  /**
   * 清除所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.currentVoice = '';
    this.currentRate = '';
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): { cached: number; texts: string[] } {
    return {
      cached: this.cache.size,
      texts: Array.from(this.cache.keys()),
    };
  }
}

export const voicePackageService = new VoicePackageService();
