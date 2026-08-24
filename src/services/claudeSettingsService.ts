/**
 * Claude Settings 服务
 *
 * 封装 settings.json 的读写操作
 */

import { invoke } from '@/services/transport'

/**
 * Claude settings.json 结构（简化版，仅包含前端使用的字段）
 */
export interface ClaudeSettings {
  autoMode?: { allow: string[]; softDeny: string[] };
  permissions?: { allow?: string[]; deny?: string[]; ask?: string[]; [key: string]: unknown };
  model?: string;
  env?: Record<string, string>;
  [key: string]: unknown;
}

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
 * 向 settings.json 的 permissions 列表追加规则（去重，后端落盘）。
 * kind: allow | deny | ask
 */
export async function addClaudePermissionRules(
  rules: string[],
  kind: 'allow' | 'deny' | 'ask' = 'allow',
): Promise<ClaudeSettings> {
  return invoke<ClaudeSettings>('add_claude_permission_rules', { rules, kind });
}
