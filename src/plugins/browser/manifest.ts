import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 内置浏览器 MCP 插件。
 *
 * 提供 Polaris 内置浏览器控制能力（导航、点击、填表、截图、控制台、网络请求等）。
 * 该 MCP 使用 AskListener 模式，需通过 TCP 回连 Polaris 主进程通信。
 */
export const browserPluginManifest: PolarisPluginManifest = {
  id: 'polaris.browser',
  name: '内置浏览器',
  version: '0.1.0',
  description: '提供 Browser MCP 工具能力，AI 可控制内置浏览器进行网页导航、点击、填表、截图等操作。关闭后将不再注入到 AI 会话。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-browser',
        transport: 'stdio',
        command: 'polaris_browser_mcp',
        argsTemplate: ['--polaris-port', '{{polarisPort}}', '--polaris-token', '{{polarisToken}}', '--polaris-session', '{{sessionId}}'],
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}