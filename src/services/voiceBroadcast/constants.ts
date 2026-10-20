/**
 * AI 连续语音播报 — 常量与方向预设
 *
 * 播报方向：自由文本 + 预设模板。模板约束 AI 每段讲什么/讲多长/如何过滤
 * 不宜朗读内容，不做复杂任务编排。
 */
import type { VoiceId } from './types'

/** mimo-tts 预置音色（与插件 PRESET_VOICES 对齐） */
export const MIMO_VOICES: ReadonlyArray<{ id: VoiceId; label: string; desc: string }> = [
  { id: '冰糖', label: '冰糖', desc: '中文女声 · 温婉' },
  { id: '茉莉', label: '茉莉', desc: '中文女声' },
  { id: '苏打', label: '苏打', desc: '中文男声' },
  { id: '白桦', label: '白桦', desc: '中文男声' },
  { id: 'Mia', label: 'Mia', desc: '英文女声' },
  { id: 'Chloe', label: 'Chloe', desc: '英文女声' },
  { id: 'Milo', label: 'Milo', desc: '英文男声' },
  { id: 'Dean', label: 'Dean', desc: '英文男声' },
  { id: 'MiMo-默认', label: 'MiMo-默认', desc: '中英混合自动' },
]

/** 预取流水线：播放当前句时最多保持多少句处于「合成中/已合成」 */
export const PREFETCH_DEPTH = 2

/** 单句合成等待上限（ms）；超时该句标记失败跳过，不断链 */
export const SYNTH_TIMEOUT_MS = 12000

/** 单句合成失败自动重试次数上限（0=不重试）。1=失败后重试一次，仍失败才跳过 */
export const SYNTH_MAX_RETRIES = 1

/**
 * base64 模式（移动端）专用值。
 * mimo-tts 单进程串行合成 + base64 载荷大（~200KB/句）经 HTTP 回传，
 * 并发预取会让后续句子在服务端排队累积突破单句超时。降并发 + 放宽超时兜底。
 */
export const BASE64_PREFETCH_DEPTH = 1

/** base64 单句合成 + 经 HTTP 回传大载荷的上限（ms），远大于桌面 file 模式的轻量 url 返回 */
export const BASE64_SYNTH_TIMEOUT_MS = 25000

/** AI 一段播报结束 → 自动请求下一段的衔接动作 */
export const AUTO_ADVANCE_MS = 300

/**
 * 段级低水位（句数）：队列剩余未播句数 ≤ 此值时，提前请求 AI 生成下一段，
 * 使「播当前段的同时生成下一段」无缝衔接，而非播空才等（消除段间静默）。
 * 需 ≥ PREFETCH_DEPTH 且 ≥ 1：太低则窗口不足以覆盖 AI 生成耗时，仍会断。
 */
export const SEGMENT_LOOKAHEAD_SENTENCES = 3

/** 播报方向预设模板（自由文本 + 模板） */
export interface DirectionPreset {
  key: string
  label: string
  /** 注入 AI 会话的定向 system prompt 模板 */
  promptTemplate: string
}

const PRESET_PROMPTS: Record<string, string> = {
  study: `你是一个「语音播报」内容生成助手。方向：{direction}。
规则：
1. 一次性输出一段可朗读的普通话内容（建议 150~350 字），围绕该方向，信息密度高、衔接自然。
2. 只输出正文本身，不要代码围栏、不要表格、不要 Markdown 语法符号、不要任务列表；确需列表时用口语化表述。
3. 遇到不宜朗读的内容（代码、表格、公式）自行改写为口语，或跳过。
4. 段落结尾用句号。`,
  story: `你是一个「语音播报」故事讲述者。方向：{direction}。
规则：
1. 一次性讲一段 150~350 字的普通话故事，情节连贯、有画面感。
2. 只输出正文本身，不要代码围栏、不要 Markdown、不要标题。
3. 每段结尾留一个自然悬念，为下一段衔接。
4. 不要问用户问题，不要重复开场白。`,
  tech: `你是一个「语音播报」技术讲解者。方向：{direction}。
规则：
1. 一次性讲一段 150~350 字的普通话技术内容，概念准确、通俗。
2. 只输出正文本身，不要代码围栏、不要表格、不要行内代码符号；技术名词保留原名。
3. 代码示例改为口述「例如…」。
4. 不要问用户问题。`,
  news: `你是一个「语音播报」新闻主播。方向：{direction}。
规则：
1. 一次性播一段 150~350 字的普通话新闻简报，事实清晰、节奏明快。
2. 只输出正文本身，不要 Markdown、不要列表、不要引用。
3. 不要评论，不要问用户问题。`,
  custom: `你是一个「语音播报」内容生成助手。方向：{direction}。
规则：
1. 一次性输出一段可朗读的普通话内容（建议 150~350 字），围绕该方向，信息密度高、衔接自然。
2. 只输出正文本身，不要代码围栏、不要表格、不要 Markdown 语法符号、不要任务列表。
3. 遇不宜朗读的内容自行改写为口语，或跳过。
4. 段落结尾用句号。`,
}

export const DIRECTION_PRESETS: ReadonlyArray<DirectionPreset> = [
  { key: 'study', label: '学习', promptTemplate: PRESET_PROMPTS.study },
  { key: 'story', label: '故事', promptTemplate: PRESET_PROMPTS.story },
  { key: 'tech', label: '技术', promptTemplate: PRESET_PROMPTS.tech },
  { key: 'news', label: '新闻', promptTemplate: PRESET_PROMPTS.news },
  { key: 'custom', label: '自定义', promptTemplate: PRESET_PROMPTS.custom },
]

/** 根据方向 key 取提示词模板（含 {direction} 占位） */
export function promptForDirection(key: string, direction: string): string {
  const preset = PRESET_PROMPTS[key] ?? PRESET_PROMPTS.custom
  // 避免依赖 lib 版本 replaceAll（项目 tsconfig 非 es2021）
  return preset.split('{direction}').join(direction)
}
