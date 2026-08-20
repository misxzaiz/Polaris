import type { PolarisPluginManifest } from '@/plugin-system/types'

export const schedulerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.scheduler',
  name: '定时任务',
  version: '0.1.0',
  description: '提供定时任务面板和 Scheduler MCP 工具能力。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'scheduler.panel',
        area: 'activityBar',
        panelType: 'scheduler',
        icon: 'Clock',
        labelKey: 'labels.schedulerPanel',
        labelDefault: 'Scheduler',
        order: 50,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-scheduler',
        transport: 'stdio',
        command: 'polaris_scheduler_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    appConfigRead: true,
    appConfigWrite: true,
    aiToolAccess: true,
  },
}
