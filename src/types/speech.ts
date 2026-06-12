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
export type VoiceCommand = 'send' | 'clear' | 'interrupt' | 'undo' | 'play';

/** 单个命令的配置 */
export interface VoiceCommandEntry {
  /** 命令类型 */
  type: VoiceCommand;
  /** 显示名称 */
  label: string;
  /** 触发关键词列表（支持多个同义词） */
  keywords: string[];
}

/** 语音命令映射配置 */
export type VoiceCommandConfig = VoiceCommandEntry[];

/** 默认语音命令配置 */
export const DEFAULT_VOICE_COMMAND_CONFIG: VoiceCommandConfig = [
  { type: 'send',      label: '发送消息',     keywords: ['发送'] },
  { type: 'clear',     label: '清空输入框',   keywords: ['清空'] },
  { type: 'undo',      label: '撤回最后输入', keywords: ['撤回'] },
  { type: 'interrupt', label: '中断对话',     keywords: ['中断'] },
  { type: 'play',      label: '朗读回复',     keywords: ['播放', '朗读'] },
];

/** 去除语音文本中的标点和空白（用于命令匹配） */
function cleanForCommandMatch(text: string): string {
  return text.replace(/[。！？，、\s]/g, '');
}

/**
 * 检查文本是否匹配某个语音命令
 *
 * 匹配规则：文本去标点后，与命令关键词（也去标点）精确匹配
 *
 * @param text 识别文本
 * @param config 命令配置（不传则使用默认配置，传入时会与默认配置合并）
 */
export function checkVoiceCommand(text: string, config?: VoiceCommandConfig): VoiceCommand | null {
  // 合并用户配置和默认配置（用户配置优先，但补充缺失的命令）
  const defaultCommands = DEFAULT_VOICE_COMMAND_CONFIG;
  let commands: VoiceCommandConfig;

  if (config) {
    // 构建类型到配置的映射
    const configMap = new Map(config.map(entry => [entry.type, entry]));
    // 补充默认配置中缺失的命令
    for (const defaultEntry of defaultCommands) {
      if (!configMap.has(defaultEntry.type)) {
        configMap.set(defaultEntry.type, defaultEntry);
      }
    }
    commands = [...configMap.values()];
  } else {
    commands = defaultCommands;
  }

  const cleaned = cleanForCommandMatch(text);
  if (!cleaned) return null;

  for (const entry of commands) {
    for (const keyword of entry.keywords) {
      if (cleaned === cleanForCommandMatch(keyword)) {
        return entry.type;
      }
    }
  }
  return null;
}

/** @deprecated 保留旧常量供引用兼容，新代码请使用 DEFAULT_VOICE_COMMAND_CONFIG */
export const VOICE_COMMANDS: Record<string, VoiceCommand> = {
  '发送': 'send',
  '发送。': 'send',
  '清空': 'clear',
  '清空。': 'clear',
  '中断': 'interrupt',
  '中断。': 'interrupt',
  '撤回': 'undo',
  '撤回。': 'undo',
};

// ========================================
// 唤醒词类型定义
// ========================================

/** 唤醒词配置 */
export interface WakeWordConfig {
  /** 是否启用唤醒词模式 */
  enabled: boolean;
  /** 唤醒词列表（支持多个，如 ["小陈", "小臣", "小晨", "小沉", "小趁"]） */
  words: string[];
}

/** 默认唤醒词配置 */
export const DEFAULT_WAKE_WORD_CONFIG: WakeWordConfig = {
  enabled: false,
  words: [],
};

/** 唤醒词匹配结果 */
export interface WakeWordMatchResult {
  /** 匹配到的唤醒词 */
  wakeWord: string;
  /** 唤醒词后的有效内容 */
  content: string;
}

/**
 * 检查识别文本是否包含唤醒词
 *
 * 匹配规则：
 * - 文本完全等于唤醒词 → 激活，无附加内容
 * - 文本以唤醒词开头 → 激活，唤醒词之后的部分作为有效内容
 * - 其他 → 不匹配
 */
export function matchWakeWord(text: string, words: string[]): WakeWordMatchResult | null {
  const trimmed = text.trim();
  for (const word of words) {
    if (!word) continue;

    // 去标点后精确匹配
    const cleaned = trimmed.replace(/[。！？，、\s]/g, '');
    if (cleaned === word) {
      return { wakeWord: word, content: '' };
    }

    // 去标点后前缀匹配
    if (cleaned.startsWith(word)) {
      // 从原文中截取唤醒词之后的内容
      const idx = trimmed.indexOf(word);
      const content = idx >= 0 ? trimmed.slice(idx + word.length).replace(/^[。！？，、\s]+/, '') : '';
      return { wakeWord: word, content };
    }
  }
  return null;
}

// ========================================
// 回声相似度判定
// ========================================

/** 去标点/空白，用于回声指纹比对 */
function normalizeForEcho(s: string): string {
  return s.replace(/[。！？，、,.!?；;：:\s'"「」『』（）()]/g, '');
}

/** 提取字符 bigram 集合（单字文本退化为单字集合） */
function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length <= 1) {
    if (s) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) {
    set.add(s.slice(i, i + 2));
  }
  return set;
}

/**
 * 判断识别文本是否为正在朗读文本的回声
 *
 * 比子串包含更鲁棒：ASR 同音错字、断句重组下仍可命中。
 * 规则：识别文本的 bigram 有 ≥ threshold 比例出现在朗读文本的 bigram 中
 * （方向性 containment，识别端通常只是朗读内容的一个片段）。
 *
 * @param recognized 识别出的文本
 * @param speaking 当前正在朗读的文本（回声指纹源）
 * @param threshold 命中比例阈值，默认 0.6
 */
export function isLikelyEcho(recognized: string, speaking: string, threshold = 0.6): boolean {
  const rec = normalizeForEcho(recognized);
  const spk = normalizeForEcho(speaking);
  if (!rec || !spk) return false;

  // 快路径：仍保留子串判定（完全命中）
  if (spk.includes(rec)) return true;

  // 短文本保护：识别端或朗读端 < 3 字符时不做回声判定（bigram 偶然重合概率过高）
  if (rec.length < 3 || spk.length < 3) return false;

  const recGrams = bigrams(rec);
  if (recGrams.size === 0) return false;
  const spkGrams = bigrams(spk);

  let hit = 0;
  for (const g of recGrams) {
    if (spkGrams.has(g)) hit++;
  }
  return hit / recGrams.size >= threshold;
}

// ========================================
// 语音提醒类型定义
// ========================================

/** 语音提醒配置 */
export interface VoiceNotificationConfig {
  /** 是否启用语音提醒（总开关） */
  enabled: boolean;
  /** 发送确认：消息发送后播报 */
  sendConfirm: boolean;
  /** 发送确认文本 */
  sendConfirmText: string;
  /** 唤醒回应：唤醒词匹配后播报 */
  wakeResponse: boolean;
  /** 唤醒回应语列表（随机选一个） */
  wakeResponseTexts: string[];
  /** 错误提醒：出错时播报 */
  errorAlert: boolean;
  /** 错误提醒文本 */
  errorAlertText: string;
  /** 后台回复完成通知 */
  backgroundNotify: boolean;
  /** 后台完成通知文本 */
  backgroundNotifyText: string;
}

/** 默认语音提醒配置 */
export const DEFAULT_VOICE_NOTIFICATION_CONFIG: VoiceNotificationConfig = {
  enabled: true,
  sendConfirm: true,
  sendConfirmText: '已发送',
  wakeResponse: true,
  wakeResponseTexts: ['在的', '我在', '嗯嗯'],
  errorAlert: true,
  errorAlertText: '出错了',
  backgroundNotify: true,
  backgroundNotifyText: '后台任务完成了',
};

// ========================================
// TTS 语音合成类型定义
// ========================================

/** TTS 语音选项 */
export type TTSVoice =
  | 'zh-CN-XiaoxiaoNeural'    // 晓晓（女声，自然）
  | 'zh-CN-YunxiNeural'       // 云希（男声，年轻）
  | 'zh-CN-YunjianNeural'     // 云健（男声，新闻）
  | 'zh-CN-XiaoyiNeural'      // 晓伊（女声，温柔）
  | 'zh-CN-YunyangNeural'     // 云扬（男声，客服）
  | 'zh-CN-XiaochenNeural'    // 晓辰（女声，情感）
  | 'zh-CN-XiaohanNeural'     // 晓涵（女声，故事）
  | 'zh-CN-XiaomengNeural'    // 晓梦（女声，可爱）
  | 'zh-CN-XiaomoNeural'      // 晓墨（女声，知性）
  | 'zh-CN-XiaoruiNeural'     // 晓睿（女声，儿童）
  | 'zh-CN-XiaoshuangNeural'  // 晓双（女声，儿童）
  | 'zh-CN-XiaoxuanNeural'    // 晓萱（女声，温暖）
  | 'zh-CN-XiaoyanNeural'     // 晓妍（女声，客服）
  | 'zh-CN-XiaoyouNeural'     // 晓悠（女声，儿童）
  | 'zh-CN-YunfengNeural'     // 云枫（男声，情感）
  | 'zh-CN-YunhaoNeural'      // 云皓（男声，广告）
  | 'zh-CN-YunxiaNeural'      // 云夏（男声，儿童）
  | 'zh-CN-YunyeNeural'       // 云野（男声，纪录片）
  | 'zh-CN-YunzeNeural';      // 云泽（男声，新闻）

/** TTS 语音选项列表 */
export const TTS_VOICE_OPTIONS: Array<{ value: TTSVoice; label: string; description: string }> = [
  { value: 'zh-CN-XiaoxiaoNeural', label: '晓晓', description: '女声，自然亲切' },
  { value: 'zh-CN-YunxiNeural', label: '云希', description: '男声，年轻阳光' },
  { value: 'zh-CN-YunjianNeural', label: '云健', description: '男声，新闻播报' },
  { value: 'zh-CN-XiaoyiNeural', label: '晓伊', description: '女声，温柔甜美' },
  { value: 'zh-CN-YunyangNeural', label: '云扬', description: '男声，客服风格' },
  { value: 'zh-CN-XiaochenNeural', label: '晓辰', description: '女声，情感丰富' },
  { value: 'zh-CN-XiaohanNeural', label: '晓涵', description: '女声，故事讲述' },
  { value: 'zh-CN-XiaomengNeural', label: '晓梦', description: '女声，可爱活泼' },
  { value: 'zh-CN-XiaomoNeural', label: '晓墨', description: '女声，知性优雅' },
  { value: 'zh-CN-XiaoxuanNeural', label: '晓萱', description: '女声，温暖治愈' },
  { value: 'zh-CN-YunfengNeural', label: '云枫', description: '男声，情感深沉' },
  { value: 'zh-CN-YunhaoNeural', label: '云皓', description: '男声，广告播音' },
  { value: 'zh-CN-YunyeNeural', label: '云野', description: '男声，纪录片风' },
  { value: 'zh-CN-YunzeNeural', label: '云泽', description: '男声，新闻联播' },
];

/** TTS 播放状态 */
export type TTSStatus =
  | 'idle'         // 空闲
  | 'synthesizing' // 正在合成
  | 'playing'      // 正在播放
  | 'paused'       // 已暂停
  | 'error';       // 错误

/** TTS 配置 */
export interface TTSConfig {
  /** 是否启用语音输出 */
  enabled: boolean;
  /** 语音角色 */
  voice: TTSVoice;
  /** 语速调整 (如: +0%, +20%, -20%) */
  rate: string;
  /** 音量 (0-1) */
  volume: number;
  /** 是否自动播放 */
  autoPlay: boolean;
}

/** 默认 TTS 配置 */
export const DEFAULT_TTS_CONFIG: TTSConfig = {
  enabled: false,
  voice: 'zh-CN-XiaoxiaoNeural',
  rate: '+0%',
  volume: 1.0,
  autoPlay: false,
};

/** TTS 语速选项 */
export const TTS_RATE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '-30%', label: '0.7x' },
  { value: '-20%', label: '0.8x' },
  { value: '-10%', label: '0.9x' },
  { value: '+0%', label: '1.0x' },
  { value: '+10%', label: '1.1x' },
  { value: '+20%', label: '1.2x' },
  { value: '+30%', label: '1.3x' },
];
