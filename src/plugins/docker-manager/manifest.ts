import type { PolarisPluginManifest } from '@/plugin-system/types'

export const dockerManagerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.docker-manager',
  name: 'Docker Manager',
  version: '0.1.0',
  description: '管理Docker容器和镜像，提供可视化操作界面',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'dockerManager.panel',
        area: 'activityBar',
        panelType: 'dockerManager',
        icon: 'Terminal',
        labelKey: 'labels.dockerManagerPanel',
        labelDefault: 'Docker Manager',
        order: 107,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    network: true,
    aiToolAccess: true,
  },
}