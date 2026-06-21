import type { PolarisPluginManifest } from '@/plugin-system/types'

export const databaseSchemaViewerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.database-schema-viewer',
  name: 'Database Schema Viewer',
  version: '0.1.0',
  description: '查看和分析数据库结构，支持多种数据库',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'databaseSchemaViewer.panel',
        area: 'activityBar',
        panelType: 'databaseSchemaViewer',
        icon: 'Database',
        labelKey: 'labels.databaseSchemaViewerPanel',
        labelDefault: 'Database Schema Viewer',
        order: 104,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}