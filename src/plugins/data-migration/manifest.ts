import type { PolarisPluginManifest } from '@/plugin-system/types'

export const dataMigrationPluginManifest: PolarisPluginManifest = {
  id: 'polaris.data-migration',
  name: 'Data Migration',
  version: '0.1.0',
  description: '管理数据库迁移，支持多种数据库',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'dataMigration.panel',
        area: 'activityBar',
        panelType: 'dataMigration',
        icon: 'GitPullRequest',
        labelKey: 'labels.dataMigrationPanel',
        labelDefault: 'Data Migration',
        order: 106,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}