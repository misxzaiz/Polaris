import type { PolarisPluginManifest } from '@/plugin-system/types'

export const envManagerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.env-manager',
  name: '环境变量',
  version: '0.1.0',
  description: '环境变量查看和管理工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'envManager.panel',
        area: 'activityBar',
        panelType: 'envManager',
        icon: 'Terminal',
        labelKey: 'labels.envManager',
        labelDefault: 'Env',
        order: 95,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
