import type { PolarisPluginManifest } from '@/plugin-system/types'

export const longGoalPluginManifest: PolarisPluginManifest = {
  id: 'polaris.long-goal',
  name: 'Long Goals',
  version: '0.1.0',
  description: '长期目标执行面板和 MCP 工具面。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'long-goal.panel',
        area: 'activityBar',
        moduleId: 'longGoal',
        icon: 'Target',
        labelKey: 'labels.longGoalPanel',
        labelDefault: 'Long Goals',
        order: 55,
        allowedSlots: ['left', 'right', 'bottom'],
        defaultSlot: 'left',
        preferredSize: 320,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-long-goal',
        transport: 'stdio',
        command: 'polaris_long_goal_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}
