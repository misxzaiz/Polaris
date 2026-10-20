/**
 * AI 连续语音播报 — 共享类型
 */

/** 播报会话状态机状态（对齐 spec §2.1） */
export type RadioBroadcastStatus =
  | 'idle'
  | 'starting'
  | 'playing'
  | 'generating'
  | 'stopping'
  | 'error'

/** mimo-tts 预置音色 id（对齐插件 PRESET_VOICES 的 voiceId） */
export type VoiceId = '冰糖' | '茉莉' | '苏打' | '白桦' | 'Mia' | 'Chloe' | 'Milo' | 'Dean' | 'MiMo-默认'

/** 播报方向 key */
export type DirectionKind = 'study' | 'story' | 'tech' | 'news' | 'custom'

/** 播报方向（预设 key + 自由文本） */
export interface RadioBroadcastDirection {
  kind: DirectionKind
  /** 自由文本方向描述（如「经济学基础」「王阳明传」） */
  text: string
}

/** 单句队列项（播放器内部） */
export interface QueueItem {
  id: string
  text: string
  url: string | null
  status: 'pending' | 'synthesizing' | 'ready' | 'playing' | 'done' | 'failed'
  /** 代际：stop() 时 ++，晚到音频校验用 */
  gen: number
}

/** 当前播放段信息（UI 展示） */
export interface RadioBroadcastSegment {
  /** 段索引（从 0 起） */
  index: number
  /** 段文本（清洗后） */
  text: string
}

/** 控制器订阅快照 */
export interface RadioBroadcastSnapshot {
  status: RadioBroadcastStatus
  direction: RadioBroadcastDirection
  voice: VoiceId
  /** 当前段（无则 null） */
  segment: RadioBroadcastSegment | null
  /** 自开始累计已播句数 */
  segmentCount: number
  /** 错误信息（error 态） */
  error: string | null
  /** 当前播放句文本（无则 null） */
  nowPlayingText: string | null
}
