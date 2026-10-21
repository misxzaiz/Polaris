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

/**
 * 音色 id（P0 放开为 string：面板经 mimo_tts_list_voices 动态拉取，
 * 预置音色由 constants.MIMO_VOICES 兜底；不再硬编码枚举，设计/克隆音色可入播报）
 */
export type VoiceId = string

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
  /** 合成失败已重试次数（0=未重试；达到 1 次后失败即跳过，见 voiceBroadcastPlayer 重试逻辑） */
  synthAttempts?: number
  /** 合成缓存 audioId（P1：库入库句子引用用） */
  audioId?: string | null
  /** 合成产物绝对路径（P1：内容库入库 / 续播复放用；base64 模式也有缓存文件） */
  file?: string | null
}

/** 当前播放段信息（UI 展示） */
export interface RadioBroadcastSegment {
  /** 段索引（从 0 起） */
  index: number
  /** 段文本（清洗后） */
  text: string
}

/** 停止原因（自动停止 / 语音口令 / 按钮 / 睡眠定时；UI 反馈用） */
export type RadioBroadcastStopReason =
  | 'manual'
  | 'voice-command'
  | 'max-rounds'
  | 'max-seconds'
  | 'sleep'
  | 'finished'
  | 'error'

/** 字幕跟读单行（P0-1）：队列即文稿，行状态与 QueueItem 对齐 */
export interface TranscriptLine {
  id: string
  text: string
  status: 'pending' | 'synthesizing' | 'ready' | 'playing' | 'done' | 'failed'
}

/** 字幕跟读快照（null = 当前无可展示文稿） */
export interface RadioBroadcastTranscript {
  lines: TranscriptLine[]
  /** 当前播放行索引（-1 = 无在播句，如 generating 静默窗） */
  currentIndex: number
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
  /** 本次播报开始时刻（Date.now()，未开始为 0；前端算累计时长） */
  startedAt: number
  /** 轮次上限（本次生效；未设为 undefined） */
  maxRounds?: number
  /** 时长上限（秒；本次生效；未设为 undefined） */
  maxSeconds?: number
  /** 最近一次停止原因（回 idle 后仍保留一次，供 Toast 反馈） */
  stopReason: RadioBroadcastStopReason | null
  /** 字幕跟读文稿（P0-1；无可展示内容为 null） */
  transcript: RadioBroadcastTranscript | null
  /** 睡眠定时到点时刻（Date.now() 毫秒；0 = 未设定时） */
  sleepUntil: number
  /** 睡眠定时「播完本段」模式（队列播空即停，不再请求新段） */
  sleepAfterSegment: boolean
}
