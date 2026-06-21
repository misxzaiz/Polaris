import type { PolarisPluginManifest } from '@/plugin-system/types'

export const queryBuilderPluginManifest: PolarisPluginManifest = {
  id: 'polaris.query-builder',
  name: 'Query Builder',
  version: '0.1.0',
  description: '可视化构建SQL查询，支持多种数据库',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'queryBuilder.panel',
        area: 'activityBar',
        panelType: 'queryBuilder',
        icon: 'Terminal',
        labelKey: 'labels.queryBuilderPanel',
        labelDefault: 'Query Builder',
        order: 105,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}