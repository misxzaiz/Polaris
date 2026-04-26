/**
 * 语音提醒服务
 *
 * 编排各类语音提醒场景：
 * - 发送确认：消息发送后播报 "已发送"
 * - 唤醒回应：唤醒词匹配后播报回应语，播报期间暂停语音识别
 * - AI 回复朗读：AI 回复完成后自动朗读内容
 * - 错误提醒：出错时播报 "出错了"
 * - 后台完成通知：后台任务完成时播报提示
 *
 * 优化点：
 * - 通知类短文本使用 voicePackageService 预缓存，零延迟播放
 * - 唤醒回应播报期间暂停语音识别，避免把回应语录入输入框
 * - AI 回复朗读为高优先级，可打断低优先级通知
 */

import { ttsService } from './ttsService';
import { voicePackageService } from './voicePackageService';
import { extractSpeakableText, cleanTextForSpeech, shouldSpeakText } from './ttsTextFilter';
import type { VoiceNotificationConfig, TTSConfig } from '../types/speech';
import { DEFAULT_VOICE_NOTIFICATION_CONFIG } from '../types/speech';
import type { ChatMessage } from '../types/chat';
import { isAssistantMessage } from '../types/chat';
import type { Config } from '../types';
import { createLogger } from '../utils/logger';

const log = createLogger('VoiceNotification');

type ConfigGetter = () => Config | null;

/** 语音识别控制接口（用于唤醒回应时暂停/恢复） */
export interface SpeechControl {
  /** 暂时停止识别 */
  pause: () => void;
  /** 恢复识别 */
  resume: () => void;
}

/**
 * 语音提醒服务
 */
class VoiceNotificationService {
  private getConfigStore: ConfigGetter = () => null;
  private speechControl: SpeechControl | null = null;

  /** 绑定配置获取函数 */
  initialize(getConfig: ConfigGetter): void {
    this.getConfigStore = getConfig;
    // 初始化时预生成语音包
    this.preGenerateVoicePackage();
  }

  /** 绑定语音识别控制（用于唤醒回应时暂停识别） */
  setSpeechControl(control: SpeechControl): void {
    this.speechControl = control;
  }

  /** 获取语音提醒配置 */
  private getNotificationConfig(): VoiceNotificationConfig {
    const config = this.getConfigStore();
    return config?.voiceNotification ?? DEFAULT_VOICE_NOTIFICATION_CONFIG;
  }

  /** 获取 TTS 配置 */
  private getTTSConfig(): TTSConfig | undefined {
    const config = this.getConfigStore();
    return config?.tts;
  }

  /**
   * 预生成语音包
   * 收集所有配置的通知文本，批量生成并缓存
   */
  preGenerateVoicePackage(): void {
    const config = this.getNotificationConfig();
    const ttsConfig = this.getTTSConfig();
    if (!ttsConfig) return;

    const texts: string[] = [];
    if (config.enabled && config.sendConfirm) {
      texts.push(config.sendConfirmText);
    }
    if (config.enabled && config.wakeResponse) {
      texts.push(...config.wakeResponseTexts);
    }
    if (config.enabled && config.errorAlert) {
      texts.push(config.errorAlertText);
    }
    if (config.enabled && config.backgroundNotify) {
      texts.push(config.backgroundNotifyText);
    }

    if (texts.length === 0) return;

    // 去重
    const uniqueTexts = [...new Set(texts)];

    voicePackageService.preGenerate(
      uniqueTexts,
      ttsConfig.voice,
      ttsConfig.rate
    ).catch(err => {
      log.debug('语音包预生成失败（降级到实时合成）', { error: String(err) });
    });
  }

  /**
   * 低优先级播报：优先使用缓存，缓存 miss 则降级到实时合成
   * 不打断正在播放的高优先级内容
   */
  private async notify(text: string): Promise<void> {
    const ttsConfig = this.getTTSConfig();
    if (!ttsConfig?.enabled) return;

    // 如果正在播放高优先级内容，不打断
    if (ttsService.isPlaying()) {
      log.debug('TTS 正在播放，跳过通知', { text });
      return;
    }

    // 优先使用缓存播放（零延迟）
    const cached = voicePackageService.playCached(text, ttsConfig.volume);
    if (cached) {
      log.debug('缓存命中，即时播放', { text });
      return;
    }

    // 缓存 miss → 降级到实时合成
    log.debug('缓存未命中，实时合成', { text });
    try {
      await ttsService.speak(text);
    } catch (error) {
      log.debug('语音通知播放失败', { error: String(error) });
    }
  }

  /**
   * 高优先级播报：中断当前播放
   * 用于 AI 回复朗读
   * @param text 要朗读的文本
   * @param force 是否强制播放（true=强制播放, false=不播放）
   */
  private async speak(text: string, force?: boolean): Promise<void> {
    // force === true → 强制播放（语音输入触发）
    // force === false → 不播放（键盘输入）
    if (force === false) {
      return;
    }

    try {
      await ttsService.speak(text, { force: force === true });
    } catch (error) {
      log.debug('AI 回复朗读失败', { error: String(error) });
    }
  }

  /** 发送确认 */
  notifySendConfirm(): void {
    const config = this.getNotificationConfig();
    if (!config.enabled || !config.sendConfirm) return;

    log.debug('播报发送确认');
    this.notify(config.sendConfirmText);
  }

  /**
   * 唤醒回应（从回应语列表中随机选择）
   *
   * 时序控制：
   * 1. pause() → 同步设置 mute flag + 暂停识别器（阻止自动重启）
   * 2. 播报回应语并等待结束
   * 3. resume() → 恢复识别器 + 300ms 后关闭 mute flag（等待声学回声消散）
   */
  async notifyWakeResponse(): Promise<void> {
    const config = this.getNotificationConfig();
    if (!config.enabled || !config.wakeResponse) return;

    const texts = config.wakeResponseTexts;
    if (texts.length === 0) return;

    const text = texts[Math.floor(Math.random() * texts.length)];
    log.info('播报唤醒回应', { text });

    const ttsConfig = this.getTTSConfig();
    if (!ttsConfig?.enabled) {
      // TTS 未启用时，不做暂停/恢复（不需要播报）
      return;
    }

    // 1. 暂停识别（mute flag 立即生效 + 识别器暂停）
    this.speechControl?.pause();

    // 2. 播报回应语
    const played = await voicePackageService.playCachedAsync(text, ttsConfig.volume);

    if (!played) {
      try {
        await ttsService.speak(text);
      } catch (error) {
        log.debug('唤醒回应播放失败', { error: String(error) });
      }
    }

    // 3. 播报结束 → 恢复识别（resume 内部有 300ms 声学消散等待）
    this.speechControl?.resume();
  }

  /** 错误提醒 */
  notifyError(): void {
    const config = this.getNotificationConfig();
    if (!config.enabled || !config.errorAlert) return;

    log.debug('播报错误提醒');
    this.notify(config.errorAlertText);
  }

  /** 后台完成通知 */
  notifyBackgroundComplete(): void {
    const config = this.getNotificationConfig();
    if (!config.enabled || !config.backgroundNotify) return;

    log.debug('播报后台完成通知');
    this.notify(config.backgroundNotifyText);
  }

  /**
   * AI 回复自动朗读
   * 接收 ChatMessage 联合类型，仅处理 assistant 消息
   * @param message AI 消息对象
   * @param options.force 是否强制播放（绕过 autoPlay 检查）
   */
  speakAIResponse(message: ChatMessage, options?: { force?: boolean }): void {
    const config = this.getNotificationConfig();
    if (!config.enabled) return;

    // 类型守卫：只处理 assistant 消息
    if (!isAssistantMessage(message)) return;

    const rawText = extractSpeakableText(message);
    if (!shouldSpeakText(rawText)) {
      log.debug('AI 回复内容过短，跳过朗读', { length: rawText.length });
      return;
    }

    const text = cleanTextForSpeech(rawText);
    log.info('开始朗读 AI 回复', { textLength: text.length, force: options?.force });
    this.speak(text, options?.force);
  }
}

export const voiceNotificationService = new VoiceNotificationService();
