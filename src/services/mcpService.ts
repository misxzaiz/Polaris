/**
 * MCP 管理器服务
 *
 * 封装 Tauri 命令调用
 */

import { invoke } from '@/services/transport'
import type {
  McpServerAggregate,
  McpHealthStatus,
  McpScope,
  McpTransport,
} from '../types/mcp'

/**
 * 列出所有 MCP 服务器 (聚合配置 + 健康状态)
 * @param workspacePath 工作区路径
 */
export async function mcpListServers(workspacePath: string): Promise<McpServerAggregate[]> {
  return invoke<McpServerAggregate[]>('mcp_list_servers', { workspacePath })
}

/**
 * 获取单个 MCP 服务器的聚合信息
 * @param name 服务器名称
 * @param workspacePath 工作区路径
 */
export async function mcpGetServer(name: string, workspacePath: string): Promise<McpServerAggregate> {
  return invoke<McpServerAggregate>('mcp_get_server', { name, workspacePath })
}

/**
 * 对所有 MCP 服务器执行健康检查
 */
export async function mcpHealthCheck(): Promise<McpHealthStatus[]> {
  return invoke<McpHealthStatus[]>('mcp_health_check')
}

/**
 * 对单个 MCP 服务器执行健康检查
 * @param name 服务器名称
 */
export async function mcpHealthCheckOne(name: string): Promise<McpHealthStatus> {
  return invoke<McpHealthStatus>('mcp_health_check_one', { name })
}

/**
 * 添加 MCP 服务器
 */
export async function mcpAddServer(
  name: string,
  command: string,
  args: string[],
  transport: McpTransport,
  scope: McpScope,
): Promise<void> {
  return invoke('mcp_add_server', { name, command, args, transport, scope })
}

/**
 * 移除 MCP 服务器
 */
export async function mcpRemoveServer(name: string, scope?: string): Promise<void> {
  return invoke('mcp_remove_server', { name, scope: scope ?? null })
}

/**
 * 启动 MCP 服务器 OAuth 认证
 */
export async function mcpStartAuth(name: string, url: string, scope: string): Promise<void> {
  return invoke('mcp_start_auth', { name, url, scope })
}
