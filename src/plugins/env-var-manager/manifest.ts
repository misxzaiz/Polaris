import type { PolarisPluginManifest } from '@/plugin-system/types'

export const envVarManagerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.env-var-manager',
  name: 'Environment Variable Manager',
  version: '0.1.0',
  description: '管理环境变量，支持多种环境配置',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'envVarManager.panel',
        area: 'activityBar',
        panelType: 'envVarManager',
        icon: 'Terminal',
        labelKey: 'labels.envVarManagerPanel',
        labelDefault: 'Env Var Manager',
        order: 109,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}