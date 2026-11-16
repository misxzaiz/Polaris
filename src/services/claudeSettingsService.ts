/**
 * Claude Settings 服务
 *
 * 封装 settings.json 的读写操作
 */

import { invoke } from '@/services/transport'

/** K-R5 批E3：claude_settings_* 命令删除，走 cap.meta 总线 */
async function metaDispatch<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const res = await invoke<{ msgId: string; ok: boolean; result: T; error: string | null }>('router_dispatch', {
    req: { target: 'cap.meta', payload: { action, ...payload } },
  })
  if (!res.ok) throw new Error(res.error || ('cap.meta ' + action + ' 失败'))
  return res.result
}

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
  return metaDispatch<ClaudeSettings>('claude_read_settings');
}

/**
 * 写入 Claude settings.json
 */
export async function writeClaudeSettings(settings: ClaudeSettings): Promise<void> {
  return metaDispatch('claude_write_settings', { settings });
}

/**
 * 获取 settings.json 文件路径
 */
export async function getClaudeSettingsPath(): Promise<string> {
  return metaDispatch<string>('claude_settings_path');
}

/**
 * 向 settings.json 的 permissions 列表追加规则（去重，后端落盘）。
 * kind: allow | deny | ask
 */
export async function addClaudePermissionRules(
  rules: string[],
  kind: 'allow' | 'deny' | 'ask' = 'allow',
): Promise<ClaudeSettings> {
  return metaDispatch<ClaudeSettings>('claude_add_permission_rules', { rules, kind });
}
