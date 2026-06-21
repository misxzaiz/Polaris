import type { PolarisPluginManifest } from '@/plugin-system/types'

export const toolMenuPluginManifest: PolarisPluginManifest = {
  id: 'polaris.tool-menu',
  name: 'Tool Menu',
  version: '0.1.0',
  description: '统一的插件工具菜单面板，集中管理所有开发工具',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'toolMenu.panel',
        area: 'activityBar',
        panelType: 'toolMenu',
        icon: 'Code2',
        labelKey: 'labels.toolMenuPanel',
        labelDefault: 'Tool Menu',
        order: 75,
      },
    ],
    panel: {
      entry: './dist/tool-menu-panel.js',
    },
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}