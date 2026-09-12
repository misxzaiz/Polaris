/**
 * 配置相关 Tauri 命令
 *
 * D 阶段摘旧：getConfig/updateConfig/updateConfigPatch 三个「config 读写」出口
 * 改走 cap.config 总线（configDispatchService），统一权限 gate + 审计 + 白名单
 * + 深层合并；其余命令（web/路径/CLI 生命周期）仍走原生 invoke。
 */

import { invoke } from '@/services/transport';
import type { Config, ConfigPatch, HealthStatus } from '@/types';
import { configGetFull, configPatchTop } from '@/services/configDispatchService';

export interface WebServerStatus {
  running: boolean;
  host?: string | null;
  port?: number | null;
  url?: string | null;
}

/** 获取配置（经 cap.config get full，等价旧 get_config） */
export async function getConfig(): Promise<Config> {
  return configGetFull();
}

/** 更新配置（整对象 → cap.config patch 逐顶层 key 覆盖） */
export async function updateConfig(config: Config): Promise<void> {
  await configPatchTop(config as unknown as Record<string, unknown>);
}

/** 按字段合并更新配置（cap.config patch 顶层对象：白名单严格 + 自由 key 透传） */
export async function updateConfigPatch(patch: ConfigPatch): Promise<Config> {
  return configPatchTop(patch as unknown as Record<string, unknown>);
}

export async function applyWebServer(): Promise<WebServerStatus> {
  return invoke<WebServerStatus>('apply_web_server');
}

export async function getWebServerStatus(): Promise<WebServerStatus> {
  return invoke<WebServerStatus>('get_web_server_status');
}

/** 设置工作目录 */
export async function setWorkDir(path: string | null): Promise<void> {
  return invoke('set_work_dir', { path });
}

/** 设置 Claude 命令路径 */
export async function setClaudeCmd(cmd: string): Promise<void> {
  return invoke('set_claude_cmd', { cmd });
}

/**
 * 重置 CLI 配置(将 Claude/Codex 的 cli_path 重置为默认占位符).
 * 用于测试/调试:可让应用回到"初始检测"状态,触发首启动检测流程.
 * 同时会刷新所有引擎缓存,避免引擎实例继续使用旧路径.
 */
export async function resetCliConfig(): Promise<Config> {
  return invoke<Config>('reset_cli_config');
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

/** 查找指定 CLI 的所有可用完整路径（where/which 解析） */
export async function findCliPaths(cliName: string): Promise<string[]> {
  return invoke<string[]>('cli_find_paths', { cliName });
}

/** 获取指定 CLI 版本 */
export async function getCliVersionFor(cliName: string): Promise<string> {
  return invoke<string>('cli_get_version_for', { cliName });
}

/** 健康检查 */
export async function healthCheck(): Promise<HealthStatus> {
  return invoke<HealthStatus>('health_check');
}

/**
 * 写入 Personal Hub session token（供 MCP server 认证 Supabase）。
 * 前端登录后调用，将 Supabase auth session token 持久化到 config.json，
 * 使 Rust 端 MCP server 能够以用户身份访问 Supabase 私有数据。
 */
export async function setPersonalHubSession(token: string): Promise<void> {
  return invoke('set_personal_hub_session', { sessionToken: token });
}

/** 检查 Personal Hub 是否已同步 session token */
export async function hasPersonalHubSession(): Promise<boolean> {
  return invoke<boolean>('get_personal_hub_session_token');
}
