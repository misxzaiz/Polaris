/**
 * 硅基流动 (SiliconFlow) 语音 API 对接
 *
 * - STT 语音转写：POST /v1/audio/transcriptions（multipart，SenseVoiceSmall）
 * - TTS 语音合成：POST /v1/audio/speech（JSON，CosyVoice2-0.5B，返回音频二进制）
 *
 * 均为 OpenAI 兼容接口。Phase 1 先在前端直连测试；若 WebView 遇到 CORS，
 * 再切换到 Tauri 后端 reqwest 代理（对上层调用透明）。
 */

import { createLogger } from '@/utils/logger';

const log = createLogger('SiliconFlowVoice');

/** 默认接入点与模型 */
export const SILICONFLOW_DEFAULTS = {
  baseUrl: 'https://api.siliconflow.cn/v1',
  sttModel: 'FunAudioLLM/SenseVoiceSmall',
  ttsModel: 'FunAudioLLM/CosyVoice2-0.5B',
} as const;

/** CosyVoice2 预置音色（4 男 4 女） */
export const COSYVOICE_VOICES: Array<{ value: string; label: string }> = [
  { value: 'anna', label: 'Anna（女声）' },
  { value: 'bella', label: 'Bella（女声）' },
  { value: 'claire', label: 'Claire（女声）' },
  { value: 'diana', label: 'Diana（女声）' },
  { value: 'alex', label: 'Alex（男声）' },
  { value: 'benjamin', label: 'Benjamin（男声）' },
  { value: 'charles', label: 'Charles（男声）' },
  { value: 'david', label: 'David（男声）' },
];

/** 语音服务配置 */
export interface SiliconFlowVoiceConfig {
  /** API Key */
  apiKey: string;
  /** 接入点，默认官方地址 */
  baseUrl?: string;
  /** STT 模型 */
  sttModel?: string;
  /** TTS 模型 */
  ttsModel?: string;
}

/**
 * 规范化 voice 参数：硅基流动要求 `<model>:<voiceName>`。
 * 若传入已含 ':' 则原样使用，否则自动拼接 TTS 模型前缀。
 */
function normalizeVoice(voice: string, ttsModel: string): string {
  if (voice.includes(':')) return voice;
  return `${ttsModel}:${voice}`;
}

/** 从响应体提取错误信息 */
async function extractError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data?.message || data?.error?.message || JSON.stringify(data);
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

/**
 * 语音转写（STT）：音频 → 文本
 *
 * @param audio 录制的音频 Blob（webm/mp3/wav 等）
 * @param config 服务配置
 * @param signal 取消信号
 * @returns 识别出的文本
 */
export async function transcribeAudio(
  audio: Blob,
  config: SiliconFlowVoiceConfig,
  signal?: AbortSignal,
): Promise<string> {
  const baseUrl = config.baseUrl || SILICONFLOW_DEFAULTS.baseUrl;
  const model = config.sttModel || SILICONFLOW_DEFAULTS.sttModel;

  const form = new FormData();
  const ext = audio.type.includes('wav')
    ? 'wav'
    : audio.type.includes('mp3') || audio.type.includes('mpeg')
      ? 'mp3'
      : audio.type.includes('mp4')
        ? 'mp4'
        : 'webm';
  form.append('file', audio, `audio.${ext}`);
  form.append('model', model);

  log.debug('发起 STT 请求', { model, size: audio.size, type: audio.type });

  const res = await fetch(`${baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
    signal,
  });

  if (!res.ok) {
    const msg = await extractError(res);
    log.error('STT 请求失败', new Error(msg));
    throw new Error(`语音识别失败: ${msg}`);
  }

  const data = await res.json();
  const text = (data?.text ?? '').trim();
  log.debug('STT 识别结果', { text });
  return text;
}

/** TTS 合成选项 */
export interface SynthesizeOptions {
  /** 音色（'anna' 或完整 '<model>:anna'） */
  voice: string;
  /** 语速 0.25 - 4.0，默认 1 */
  speed?: number;
  /** 输出格式，默认 mp3 */
  responseFormat?: 'mp3' | 'opus' | 'wav' | 'pcm';
  /** 采样率 */
  sampleRate?: number;
}

/**
 * 语音合成（TTS）：文本 → 音频 Blob
 *
 * @param text 要朗读的文本（支持 `<|endofprompt|>` 前缀做情感控制）
 * @param options 音色/语速等
 * @param config 服务配置
 * @param signal 取消信号
 * @returns 音频 Blob（可用 URL.createObjectURL 播放）
 */
export async function synthesizeSpeech(
  text: string,
  options: SynthesizeOptions,
  config: SiliconFlowVoiceConfig,
  signal?: AbortSignal,
): Promise<Blob> {
  const baseUrl = config.baseUrl || SILICONFLOW_DEFAULTS.baseUrl;
  const model = config.ttsModel || SILICONFLOW_DEFAULTS.ttsModel;

  const body = {
    model,
    input: text,
    voice: normalizeVoice(options.voice, model),
    response_format: options.responseFormat || 'mp3',
    speed: options.speed ?? 1,
    ...(options.sampleRate ? { sample_rate: options.sampleRate } : {}),
  };

  log.debug('发起 TTS 请求', { model, voice: body.voice, textLength: text.length });

  const res = await fetch(`${baseUrl}/audio/speech`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const msg = await extractError(res);
    log.error('TTS 请求失败', new Error(msg));
    throw new Error(`语音合成失败: ${msg}`);
  }

  return await res.blob();
}
