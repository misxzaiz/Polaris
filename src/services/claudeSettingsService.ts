/**
 * Claude Settings 服务
 *
 * 封装 settings.json 的读写操作
 */

import { invoke } from '@tauri-apps/api/core';
import type { ClaudeSettings, AutoModeCustomRules } from '../types/autoMode';

/**
 * 读取 Claude settings.json
 */
export async function readClaudeSettings(): Promise<ClaudeSettings> {
  return invoke<ClaudeSettings>('read_claude_settings');
}

/**
 * 写入 Claude settings.json
 */
export async function writeClaudeSettings(settings: ClaudeSettings): Promise<void> {
  return invoke('write_claude_settings', { settings });
}

/**
 * 获取 settings.json 文件路径
 */
export async function getClaudeSettingsPath(): Promise<string> {
  return invoke<string>('get_claude_settings_path');
}

/**
 * 从 settings 中提取自定义规则
 */
export function extractCustomRules(settings: ClaudeSettings | null): AutoModeCustomRules {
  if (!settings?.autoMode) {
    return { allow: [], softDeny: [] };
  }
  return {
    allow: settings.autoMode.allow || [],
    softDeny: settings.autoMode.softDeny || [],
  };
}

/**
 * 更新 settings 中的自定义规则
 */
export function updateCustomRules(
  settings: ClaudeSettings,
  rules: AutoModeCustomRules
): ClaudeSettings {
  return { ...settings, autoMode: rules };
}
