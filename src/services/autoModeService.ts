/**
 * Auto-Mode 服务
 *
 * 封装 Tauri 命令调用
 */

import { invoke } from '@/services/transport'
import type { AutoModeConfig, AutoModeDefaults } from '@/types/autoMode';

/**
 * 获取自动模式配置
 */
export async function getAutoModeConfig(): Promise<AutoModeConfig> {
  return invoke<AutoModeConfig>('auto_mode_config');
}

/**
 * 获取默认配置
 */
export async function getAutoModeDefaults(): Promise<AutoModeDefaults> {
  return invoke<AutoModeDefaults>('auto_mode_defaults');
}
