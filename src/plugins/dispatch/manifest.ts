import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 内置任务派发 MCP 插件。
 *
 * 提供 dispatch_task / check_dispatched_task / continue_dispatched_task 工具，
 * 可将子任务派发到独立后台 Polaris 会话并行执行。
 * 该 MCP 使用 AskListener 模式，需通过 TCP 回连 Polaris 主进程通信。
 */
export const dispatchPluginManifest: PolarisPluginManifest = {
  id: 'polaris.dispatch',
  name: '任务派发',
  version: '0.1.0',
  description: '提供 Dispatch MCP 工具能力，可将子任务派发到独立后台 Polaris 会话。关闭后将不再注入到 AI 会话。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-dispatch',
        transport: 'stdio',
        command: 'polaris_dispatch_mcp',
        argsTemplate: ['--polaris-port', '{{polarisPort}}', '--polaris-token', '{{polarisToken}}', '--polaris-session', '{{sessionId}}'],
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}