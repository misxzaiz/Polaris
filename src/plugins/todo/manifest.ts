import type { PolarisPluginManifest } from '@/plugin-system/types'

export const todoPluginManifest: PolarisPluginManifest = {
  id: 'polaris.todo',
  name: '待办',
  version: '0.1.0',
  description: '提供工作区待办面板和 Todo MCP 工具能力。',
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
    mcpServers: [
      {
        id: 'polaris-todo',
        transport: 'stdio',
        command: 'polaris_todo_mcp',
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
