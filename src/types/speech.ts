/**
 * 语音识别相关类型定义
 */

/** 语音识别状态 */
export type SpeechRecognitionStatus =
  | 'idle'           // 空闲
  | 'listening'      // 正在监听
  | 'processing'     // 处理中
  | 'error';         // 错误

/** 语音识别错误类型 */
export type SpeechRecognitionErrorType =
  | 'not-supported'      // 浏览器不支持
  | 'no-speech'          // 未检测到语音
  | 'audio-capture'      // 无法捕获音频
  | 'network'            // 网络错误
  | 'aborted'            // 用户中止
  | 'service-not-allowed' // 服务不允许
  | 'language-not-supported' // 语言不支持
  | 'unknown';           // 未知错误

/** 语音识别错误 */
export interface SpeechRecognitionError {
  type: SpeechRecognitionErrorType;
  message: string;
}

/** 语音识别配置 */
export interface SpeechConfig {
  /** 是否启用语音输入 */
  enabled: boolean;
  /** 识别语言 */
  language: SpeechLanguage;
}

/** 支持的语音识别语言 */
export type SpeechLanguage =
  | 'zh-CN'    // 中文（简体）
  | 'zh-TW'    // 中文（繁体）
  | 'en-US'    // 英语（美国）
  | 'en-GB'    // 英语（英国）
  | 'ja-JP'    // 日语
  | 'ko-KR';   // 韩语

/** 语音识别语言选项 */
export const SPEECH_LANGUAGE_OPTIONS: Array<{ value: SpeechLanguage; label: string }> = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'zh-TW', label: '中文（繁体）' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'ja-JP', label: '日本語' },
  { value: 'ko-KR', label: '한국어' },
];

/** 默认语音配置 */
export const DEFAULT_SPEECH_CONFIG: SpeechConfig = {
  enabled: true,
  language: 'zh-CN',
};

/** 语音命令类型 */
export type VoiceCommand = 'send' | 'clear' | 'interrupt' | 'undo';

/** 语音命令映射（全匹配） */
export const VOICE_COMMANDS: Record<string, VoiceCommand> = {
  // 发送
  '发送': 'send',
  '发送。': 'send',
  // 清空
  '清空': 'clear',
  '清空。': 'clear',
  // 中断
  '中断': 'interrupt',
  '中断。': 'interrupt',
  // 撤回
  '撤回': 'undo',
  '撤回。': 'undo',
};

/** 检查文本是否是语音命令 */
export function checkVoiceCommand(text: string): VoiceCommand | null {
  const trimmed = text.trim();
  return VOICE_COMMANDS[trimmed] || null;
}
