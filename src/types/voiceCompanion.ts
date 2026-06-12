/**
 * 语音伙伴 (Voice Companion) 类型定义 — v3
 *
 * 交互模型：连续聆听 + 唤醒词 + 命令 + 半双工回声治理
 *   idle → standby(待命,只听唤醒词) → listening(激活,连续识别) → thinking
 *        → speaking(朗读,默认暂停识别) → cooldown(回声冷却) → listening
 *
 * 回声治理（默认半双工）：
 *   - speaking 暂停 ASR（点击光球/空格打断）；
 *   - TTS 结束后进入 cooldown（默认 800ms）等扬声器尾音消散；
 *   - 恢复聆听后短时间内仍施加 bigram 相似度回声过滤兜底；
 *   - 设置 fullDuplex=true 可启用实验性全双工（保留语音唤醒打断，外放有回声风险）。
 *
 * STT=Web Speech(speechService) / TTS=edge-tts(ttsService+streamingTts) / 大脑=主对话管道。
 * 人格经 sendMessage 的 oneTimeSystemPrompt 注入（不出现在消息流中）。
 */

import type { SpeechLanguage, TTSVoice, WakeWordConfig } from './speech';

/** 对话阶段状态机 */
export type VoicePhase =
  | 'idle'        // 未激活 / 通话已开但未运行
  | 'standby'     // 待命：麦克风开着，但只听唤醒词「小陈」
  | 'listening'   // 激活：连续识别用户语音
  | 'thinking'    // 已发送，等待 AI 流式回复
  | 'speaking'    // 小陈正在朗读（半双工：识别暂停；全双工：可被唤醒词打断）
  | 'cooldown'    // 朗读结束后的回声冷却期（半双工专属，自动流转回 listening）
  | 'error';

/** 语音伙伴模式 */
export type VoiceCompanionMode =
  | 'companion'   // 陪伴闲聊：小陈人格、简短口语、适合朗读
  | 'work';       // 干活：保留完整能力与工具链，口头汇报精炼

/** 语音伙伴配置（独立持久化于 localStorage，不进全局 Config） */
export interface VoiceCompanionConfig {
  /** 配置版本（用于 localStorage 迁移） */
  configVersion?: number;
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
  /** 停顿合并发送的静默阈值（毫秒，800-3000） */
  autoSendDelay: number;
  /** 唤醒词配置（默认开启，喊「小陈」激活/打断） */
  wakeWord: WakeWordConfig;
  /** 激活后静默多久回到待命（毫秒，0=不回） */
  standbyTimeout: number;
  /**
   * 实验性全双工：speaking 时保持识别开启（可语音唤醒打断），
   * 依赖回声相似度过滤，外放场景有回声风险。默认 false=半双工。
   */
  fullDuplex: boolean;
  /** 朗读结束后的回声冷却时长（毫秒，半双工生效） */
  echoCooldownMs: number;
}

/** 默认配置（小陈默认「晓晓」女声；唤醒词默认开，含同音容错；默认半双工） */
export const DEFAULT_VOICE_COMPANION_CONFIG: VoiceCompanionConfig = {
  configVersion: 4,
  mode: 'companion',
  language: 'zh-CN',
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  autoSend: false,
  autoSendDelay: 1500,
  wakeWord: { enabled: true, words: ['小陈', '小臣', '小晨', '小沉', '小趁'] },
  standbyTimeout: 15000,
  fullDuplex: false,
  echoCooldownMs: 800,
};

/** 伙伴身份（用于 UI 展示与人格构建） */
export const COMPANION_IDENTITY = {
  name: '小陈',
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
  cooldown: 'voiceCompanion.phase.cooldown',
  error: 'voiceCompanion.phase.error',
};
