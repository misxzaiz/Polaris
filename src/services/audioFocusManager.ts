/**
 * AudioFocusManager - 音频焦点仲裁器
 *
 * speechService（麦克风/ASR）与 ttsService（扬声器/TTS）均为单例，
 * 此前 voiceCompanion / useVoiceDictation / voiceNotificationService 多方直接操作，
 * 互相覆盖回调、互相 stop()，导致「通知打断通话朗读」「听写卸载误杀通话麦克风」等问题。
 *
 * 本仲裁器以「焦点持有者」模型收口：
 *   - 优先级：companion(通话) > dictation(听写) > notification(语音通知)
 *   - request() 高优先级可抢占低优先级（被抢占方经订阅获知并自行收尾 UI）；
 *     同级幂等，低优先级申请被拒绝。
 *   - release() 仅持有者本人可释放，避免旁路误释放。
 *
 * 注意：仲裁器只管「谁有权用」，不直接操作音频服务 —— 申请成功后由调用方
 * 自行 start/stop，释放前调用方自行清理。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('AudioFocusManager');

/** 音频焦点持有者类型 */
export type AudioFocusOwner = 'companion' | 'dictation' | 'notification';

/** 优先级（越大越高） */
const PRIORITY: Record<AudioFocusOwner, number> = {
  companion: 3,
  dictation: 2,
  notification: 1,
};

type FocusListener = (owner: AudioFocusOwner | null) => void;

class AudioFocusManager {
  private current: AudioFocusOwner | null = null;
  private listeners = new Set<FocusListener>();

  /** 当前持有者（null=空闲） */
  get owner(): AudioFocusOwner | null {
    return this.current;
  }

  /** 是否被指定持有者占用 */
  isHeldBy(owner: AudioFocusOwner): boolean {
    return this.current === owner;
  }

  /**
   * 申请焦点
   * @returns true=获得（或已持有）；false=被更高/同级占用，申请被拒
   */
  request(owner: AudioFocusOwner): boolean {
    if (this.current === owner) return true;
    if (this.current && PRIORITY[this.current] >= PRIORITY[owner]) {
      log.debug('焦点申请被拒', { requester: owner, holder: this.current });
      return false;
    }
    const preempted = this.current;
    this.current = owner;
    if (preempted) {
      log.info('焦点抢占', { from: preempted, to: owner });
    }
    this.emit();
    return true;
  }

  /** 释放焦点（仅持有者本人生效） */
  release(owner: AudioFocusOwner): void {
    if (this.current !== owner) return;
    this.current = null;
    this.emit();
  }

  /** 订阅焦点变化（返回取消订阅函数） */
  subscribe(fn: FocusListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn(this.current);
      } catch (e) {
        log.warn('焦点订阅回调异常', { error: String(e) });
      }
    }
  }
}

/** 单例 */
export const audioFocusManager = new AudioFocusManager();
