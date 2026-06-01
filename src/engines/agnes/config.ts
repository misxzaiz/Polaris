/**
 * Agnes AI Engine — 配置管理
 */

import type { AgnesConfig } from './types'
import { DEFAULT_AGNES_CONFIG } from './types'

/** 配置验证结果 */
export interface ConfigValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * 验证 Agnes 配置
 */
export function validateAgnesConfig(config: Partial<AgnesConfig>): ConfigValidationResult {
  const errors: string[] = []

  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl)
    } catch {
      errors.push('baseUrl must be a valid URL')
    }
  }

  if (config.apiKey !== undefined && config.apiKey.trim() === '') {
    errors.push('apiKey cannot be empty string')
  }

  if (config.timeout !== undefined && config.timeout < 1000) {
    errors.push('timeout must be at least 1000ms')
  }

  if (config.videoPollInterval !== undefined && config.videoPollInterval < 1000) {
    errors.push('videoPollInterval must be at least 1000ms')
  }

  return { valid: errors.length === 0, errors }
}

/**
 * 合并配置与默认值
 */
export function mergeAgnesConfig(config: Partial<AgnesConfig>): AgnesConfig {
  return { ...DEFAULT_AGNES_CONFIG, ...config } as AgnesConfig
}

/**
 * 检查配置是否完整（至少包含必要字段）
 */
export function isAgnesConfigComplete(config: Partial<AgnesConfig>): config is AgnesConfig {
  return (
    typeof config.baseUrl === 'string' && config.baseUrl.length > 0 &&
    typeof config.apiKey === 'string' && config.apiKey.length > 0
  )
}

/**
 * 验证视频帧数参数（必须满足 8n+1 且 ≤441）
 */
export function validateNumFrames(numFrames: number): { valid: boolean; adjusted: number; warning?: string } {
  if (numFrames > 441) {
    return { valid: true, adjusted: 441, warning: 'num_frames capped to max 441' }
  }
  if (numFrames < 9) {
    return { valid: true, adjusted: 9, warning: 'num_frames adjusted to min 9' }
  }
  // 8n+1 检查
  if ((numFrames - 1) % 8 !== 0) {
    const adjusted = Math.round((numFrames - 1) / 8) * 8 + 1
    return { valid: true, adjusted: Math.max(9, Math.min(441, adjusted)), warning: `num_frames adjusted to ${adjusted} (8n+1 rule)` }
  }
  return { valid: true, adjusted: numFrames }
}

/**
 * 推荐的 num_frames 预设
 */
export const VIDEO_FRAME_PRESETS = {
  short: 81,    // ~3.4s @ 24fps
  medium: 121,  // ~5s @ 24fps
  long: 161,    // ~6.7s @ 24fps
  extended: 241, // ~10s @ 24fps
  max: 441,     // ~18.4s @ 24fps
} as const
