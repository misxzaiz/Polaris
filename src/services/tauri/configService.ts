/**
 * 配置相关 Tauri 命令
 */

import { invoke } from '@/services/transport';
import type { Config, ConfigPatch, HealthStatus } from '../../types';

/** 获取配置 */
export async function getConfig(): Promise<Config> {
  return invoke<Config>('get_config');
}

/** 更新配置 */
export async function updateConfig(config: Config): Promise<void> {
  return invoke('update_config', { config });
}

/** 按字段合并更新配置 */
export async function updateConfigPatch(patch: ConfigPatch): Promise<Config> {
  return invoke<Config>('update_config_patch', { patch });
}

/** 设置工作目录 */
export async function setWorkDir(path: string | null): Promise<void> {
  return invoke('set_work_dir', { path });
}

/** 设置 Claude 命令路径 */
export async function setClaudeCmd(cmd: string): Promise<void> {
  return invoke('set_claude_cmd', { cmd });
}

/** 路径验证结果 */
export interface PathValidationResult {
  valid: boolean;
  error?: string;
  version?: string;
}

/** 查找所有可用的 Claude CLI 路径 */
export async function findClaudePaths(): Promise<string[]> {
  return invoke<string[]>('find_claude_paths');
}

/** 验证 Claude CLI 路径 */
export async function validateClaudePath(path: string): Promise<PathValidationResult> {
  return invoke<PathValidationResult>('validate_claude_path', { path });
}

/** 检查指定 CLI 是否可用 */
export async function checkCliInstalled(cliName: string): Promise<boolean> {
  return invoke<boolean>('cli_check_installed', { cliName });
}

/** 获取指定 CLI 版本 */
export async function getCliVersionFor(cliName: string): Promise<string> {
  return invoke<string>('cli_get_version_for', { cliName });
}

/** 健康检查 */
export async function healthCheck(): Promise<HealthStatus> {
  return invoke<HealthStatus>('health_check');
}
