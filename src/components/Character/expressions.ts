/**
 * 角色表情定义
 *
 * 定义各表情对应的 SVG 嘴巴路径、眼睛样式、腮红强度等视觉参数。
 */

/** 角色表情枚举 */
export type CharacterExpression =
  | 'idle'          // 默认 — 呼吸/眨眼
  | 'thinking'      // session_start — 眼睛微转
  | 'deep_thought'  // thinking block — 闭眼沉思
  | 'speaking'      // token 流式 — 嘴部开合
  | 'working'       // tool_call_start — 专注
  | 'celebrating'   // tool_call_end(success) — 微笑
  | 'error'         // error — 沮丧
  | 'curious'       // question — 疑问
  | 'listening'     // STT 激活 — 耳机波纹
  | 'sleeping'      // 长时间无交互 — 休眠

/** 嘴巴 SVG path 的 d 属性，基于 polaris-commander 坐标系 */
export const MOUTH_PATHS: Record<CharacterExpression, string> = {
  idle:          'M220,320 Q256,340 292,320',     // 微笑
  thinking:      'M220,320 Q256,325 292,320',     // 微微抿嘴
  deep_thought:  'M225,322 Q256,322 287,322',     // 一字型（平静）
  speaking:      'M220,315 Q256,350 292,315',     // 大开口
  working:       'M225,320 Q256,323 287,320',     // 专注紧抿
  celebrating:   'M215,318 Q256,352 297,318',     // 大笑
  error:         'M220,328 Q256,312 292,328',     // 不开心（倒弧）
  curious:       'M230,320 Q256,318 282,320',     // 小 O 嘴
  listening:     'M225,320 Q256,330 287,320',     // 微张（倾听）
  sleeping:      'M230,322 Q256,322 282,322',     // 平直（安睡）
}

/** 眼睛样式参数 */
export interface EyeStyle {
  /** 透明度 (0~1) */
  opacity: number
  /** 缩放 (0.5~1.5) */
  scale: number
  /** Y 偏移 (px, 负=向上) */
  translateY: number
  /** X 偏移 (px) */
  translateX: number
  /** 动画类名 */
  animation: string
}

/** 左眼样式 */
export const LEFT_EYE_STYLES: Record<CharacterExpression, EyeStyle> = {
  idle:          { opacity: 1,    scale: 1,    translateY: 0,  translateX: 0,  animation: 'character-blink 4s infinite' },
  thinking:      { opacity: 1,    scale: 1,    translateY: -2, translateX: 2,  animation: 'eye-wander 2s infinite' },
  deep_thought:  { opacity: 0.3,  scale: 0.85, translateY: 3,  translateX: 0,  animation: 'none' },
  speaking:      { opacity: 1,    scale: 1,    translateY: 0,  translateX: 0,  animation: 'none' },
  working:       { opacity: 1,    scale: 0.9,  translateY: 0,  translateX: 0,  animation: 'none' },
  celebrating:   { opacity: 1,    scale: 1.15, translateY: -1, translateX: 0,  animation: 'star-twinkle 0.6s infinite' },
  error:         { opacity: 0.6,  scale: 0.8,  translateY: 4,  translateX: 0,  animation: 'none' },
  curious:       { opacity: 1,    scale: 1.1,  translateY: -1, translateX: 0,  animation: 'star-twinkle 1.2s infinite' },
  listening:     { opacity: 1,    scale: 1.05, translateY: 0,  translateX: 3,  animation: 'none' },
  sleeping:      { opacity: 0.1,  scale: 0.6,  translateY: 5,  translateX: 0,  animation: 'none' },
}

/** 右眼样式（通常与左眼对称，微小差异增加自然感） */
export const RIGHT_EYE_STYLES: Record<CharacterExpression, EyeStyle> = {
  idle:          { opacity: 1,    scale: 1,    translateY: 0,  translateX: 0,  animation: 'character-blink 4s infinite 0.15s' },
  thinking:      { opacity: 1,    scale: 1,    translateY: -2, translateX: -1, animation: 'eye-wander 2.2s infinite 0.3s' },
  deep_thought:  { opacity: 0.3,  scale: 0.85, translateY: 3,  translateX: 0,  animation: 'none' },
  speaking:      { opacity: 1,    scale: 1,    translateY: 0,  translateX: 0,  animation: 'none' },
  working:       { opacity: 1,    scale: 0.9,  translateY: 0,  translateX: 0,  animation: 'none' },
  celebrating:   { opacity: 1,    scale: 1.15, translateY: -1, translateX: 0,  animation: 'star-twinkle 0.6s infinite 0.1s' },
  error:         { opacity: 0.6,  scale: 0.8,  translateY: 4,  translateX: 0,  animation: 'none' },
  curious:       { opacity: 1,    scale: 1.1,  translateY: -1, translateX: 0,  animation: 'star-twinkle 1.2s infinite 0.15s' },
  listening:     { opacity: 1,    scale: 1.05, translateY: 0,  translateX: -3, animation: 'none' },
  sleeping:      { opacity: 0.1,  scale: 0.6,  translateY: 5,  translateX: 0,  animation: 'none' },
}

/** 腮红透明度 (0~1) */
export const BLUSH_OPACITY: Record<CharacterExpression, number> = {
  idle:          0.4,
  thinking:      0.3,
  deep_thought:  0.2,
  speaking:      0.35,
  working:       0.2,
  celebrating:   0.6,
  error:         0,
  curious:       0.55,
  listening:     0.35,
  sleeping:      0.25,
}

/** 天线球动画 */
export const ANTENNA_ANIMATION: Record<CharacterExpression, string> = {
  idle:          'antenna-pulse 2s ease-in-out infinite',
  thinking:      'antenna-pulse 1s ease-in-out infinite',
  deep_thought:  'antenna-pulse 3s ease-in-out infinite',
  speaking:      'antenna-pulse 0.8s ease-in-out infinite',
  working:       'antenna-pulse 0.5s ease-in-out infinite',
  celebrating:   'antenna-pulse 0.4s ease-in-out infinite',
  error:         'antenna-pulse 0.3s ease-in-out infinite',
  curious:       'antenna-pulse 1.5s ease-in-out infinite',
  listening:     'antenna-pulse 0.6s ease-in-out infinite',
  sleeping:      'antenna-pulse 4s ease-in-out infinite',
}

/** 能量环旋转速度 (秒/圈) */
export const ENERGY_RING_DURATION: Record<CharacterExpression, string> = {
  idle:          '20s',
  thinking:      '8s',
  deep_thought:  '15s',
  speaking:      '6s',
  working:       '4s',
  celebrating:   '3s',
  error:         '2s',
  curious:       '12s',
  listening:     '5s',
  sleeping:      '30s',
}

/** AIEvent.type → CharacterExpression 映射 */
export const EVENT_TO_EXPRESSION: Record<string, CharacterExpression> = {
  session_start:    'thinking',
  token:            'speaking',
  thinking:         'deep_thought',
  assistant_message:'speaking',
  tool_call_start:  'working',
  tool_call_end:    'celebrating',
  progress:         'working',
  error:            'error',
  session_end:      'idle',
  question:         'curious',
  question_answered:'speaking',
}
