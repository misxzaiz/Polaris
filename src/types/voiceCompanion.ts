/**
 * 语音伙伴 (Voice Companion) 类型定义 — v2
 *
 * 交互模型：连续聆听 + 唤醒词 + 命令 + 软全双工（回声指纹过滤 + 唤醒词穿透打断）
 *   idle → standby(待命,只听唤醒词) → listening(激活,连续识别) → thinking → speaking(朗读,可被"小白"打断)
 *
 * STT=Web Speech(speechService) / TTS=edge-tts(ttsService+streamingTts) / 大脑=主对话管道。
 * 均免费无 key。人格经 sendMessage 消息前缀注入（含"绝不自称小白"以防朗读自我打断）。
 */

import type { SpeechLanguage, TTSVoice, WakeWordConfig, VoiceCommandConfig } from './speech';
import { DEFAULT_VOICE_COMMAND_CONFIG } from './speech';

/** 对话阶段状态机 */
export type VoicePhase =
  | 'idle'        // 未激活 / 通话已开但未运行
  | 'standby'     // 待命：麦克风开着，但只听唤醒词「小白」
  | 'listening'   // 激活：连续识别用户语音
  | 'thinking'    // 已发送，等待 AI 流式回复
  | 'speaking'    // 小白正在朗读（全程开麦，可被「小白」打断）
  | 'error';

/** 语音伙伴模式 */
export type VoiceCompanionMode =
  | 'companion'   // 陪伴闲聊：小白人格、简短口语、适合朗读
  | 'work';       // 干活：保留完整能力与工具链，口头汇报精炼

/** 语音伙伴配置（独立持久化于 localStorage，不进全局 Config） */
export interface VoiceCompanionConfig {
  /** 对话模式 */
  mode: VoiceCompanionMode;
  /** STT 识别语言（Web Speech） */
  language: SpeechLanguage;
  /** TTS 音色（edge-tts 神经网络嗓音） */
  voice: TTSVoice;
  /** 语速（如 +0%、+20%） */
  rate: string;
  /** 停顿后自动发送（true=说完即发，false=靠「发送」命令） */
  autoSend: boolean;
  /** 唤醒词配置（默认开启，喊「小白」激活/打断） */
  wakeWord: WakeWordConfig;
  /** 语音命令（发送/清空/中断/朗读） */
  voiceCommands: VoiceCommandConfig;
  /** 激活后静默多久回到待命（毫秒，0=不回） */
  standbyTimeout: number;
}

/** 默认配置（小白默认「晓晓」女声；唤醒词默认开，喊「小白」激活） */
export const DEFAULT_VOICE_COMPANION_CONFIG: VoiceCompanionConfig = {
  mode: 'companion',
  language: 'zh-CN',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  autoSend: true,
  wakeWord: { enabled: true, words: ['小白'] },
  voiceCommands: DEFAULT_VOICE_COMMAND_CONFIG,
  standbyTimeout: 15000,
};

/** 伙伴身份（用于 UI 展示与人格构建） */
export const COMPANION_IDENTITY = {
  name: '小白',
  tagline: '你的语音陪伴伙伴',
} as const;

/** localStorage 持久化键 */
export const VOICE_COMPANION_CONFIG_KEY = 'polaris.voiceCompanion.config';

/** 各阶段对应的状态文案 i18n key（UI 用） */
export const VOICE_PHASE_I18N_KEY: Record<VoicePhase, string> = {
  idle: 'voiceCompanion.phase.idle',
  standby: 'voiceCompanion.phase.standby',
  listening: 'voiceCompanion.phase.listening',
  thinking: 'voiceCompanion.phase.thinking',
  speaking: 'voiceCompanion.phase.speaking',
  error: 'voiceCompanion.phase.error',
};
