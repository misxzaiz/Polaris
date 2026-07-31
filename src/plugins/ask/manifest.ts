import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 内置用户提问 MCP 插件。
 *
 * 提供 ask_user_question 工具，AI 可通过多选或输入方式向用户提问并获取反馈。
 * 该 MCP 使用 AskListener 模式，需通过 TCP 回连 Polaris 主进程通信。
 */
export const askPluginManifest: PolarisPluginManifest = {
  id: 'polaris.ask',
  name: '用户提问',
  version: '0.1.0',
  description: '提供 Ask MCP 工具能力，AI 可向用户提问（多选/输入）并获取反馈。关闭后将不再注入到 AI 会话。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-ask',
        transport: 'stdio',
        command: 'polaris_ask_mcp',
        argsTemplate: ['--polaris-port', '{{polarisPort}}', '--polaris-token', '{{polarisToken}}', '--polaris-session', '{{sessionId}}'],
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}