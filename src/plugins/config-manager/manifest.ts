import type { PolarisPluginManifest } from '@/plugin-system/types'

export const configManagerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.config-manager',
  name: 'Config Manager',
  version: '0.1.0',
  description: '管理项目配置文件，支持多种配置格式',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'configManager.panel',
        area: 'activityBar',
        panelType: 'configManager',
        icon: 'Settings',
        labelKey: 'labels.configManagerPanel',
        labelDefault: 'Config Manager',
        order: 113,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}