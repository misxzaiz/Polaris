import type { PolarisPluginManifest } from '@/plugin-system/types'

export const requirementPluginManifest: PolarisPluginManifest = {
  id: 'polaris.requirements',
  name: '需求库',
  version: '0.1.0',
  description: '提供需求管理面板和 Requirements MCP 工具能力。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'requirement.panel',
        area: 'activityBar',
        panelType: 'requirement',
        icon: 'ClipboardList',
        labelKey: 'labels.requirementPanel',
        labelDefault: 'Requirements',
        order: 60,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-requirements',
        transport: 'stdio',
        command: 'polaris_requirements_mcp',
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
