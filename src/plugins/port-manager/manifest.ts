import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 端口管理器插件
 *
 * 可视化查看系统监听端口、占用进程，支持一键释放端口。
 * MCP 工具供 AI 查询和操作端口。
 */
export const portManagerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.port-manager',
  name: '端口管理',
  version: '0.1.0',
  description: '系统端口监控与管理面板：查看监听端口、释放占用、AI 可查询操作。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'portManager.panel',
        area: 'activityBar',
        panelType: 'portManager',
        icon: 'Activity',
        labelKey: 'labels.portManagerPanel',
        labelDefault: 'Ports',
        order: 75,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-port-manager',
        transport: 'stdio',
        command: 'polaris-port-manager-mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
