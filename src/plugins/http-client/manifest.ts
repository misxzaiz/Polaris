import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * HTTP Client 插件
 *
 * API 调试器面板：构建并发送 HTTP 请求，查看响应（状态/头/体/耗时），历史记录本地持久化。
 * MCP 工具 http_request 让 AI 能够直接发起 HTTP 请求，用于调试接口、对接第三方 API。
 */
export const httpClientPluginManifest: PolarisPluginManifest = {
  id: 'polaris.http-client',
  name: 'HTTP 客户端',
  version: '0.1.0',
  description: 'API 调试器：发起 HTTP 请求、查看响应、保存历史；AI 可通过 MCP 调用接口。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'httpClient.panel',
        area: 'activityBar',
        panelType: 'httpClient',
        icon: 'Globe',
        labelKey: 'labels.httpClientPanel',
        labelDefault: 'HTTP',
        order: 85,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-http-client',
        transport: 'stdio',
        command: 'polaris-http-client-mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
