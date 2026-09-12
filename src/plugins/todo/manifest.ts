import type { PolarisPluginManifest } from '@/plugin-system/types'

export const todoPluginManifest: PolarisPluginManifest = {
  id: 'polaris.todo',
  name: '待办',
  version: '0.1.0',
  description: '提供工作区待办面板能力。待办数据经 cap.todo capability 读写，不再提供独立 MCP server。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'todo.panel',
        area: 'activityBar',
        panelType: 'todo',
        icon: 'CheckSquare',
        labelKey: 'labels.todoPanel',
        labelDefault: 'Todo',
        order: 30,
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
