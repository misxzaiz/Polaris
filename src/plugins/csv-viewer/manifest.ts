import type { PolarisPluginManifest } from '@/plugin-system/types'

export const csvViewerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.csv-viewer',
  name: 'CSV 查看',
  version: '0.1.0',
  description: 'CSV 文件查看和分析工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'csvViewer.panel',
        area: 'activityBar',
        panelType: 'csvViewer',
        icon: 'ClipboardList',
        labelKey: 'labels.csvViewer',
        labelDefault: 'CSV',
        order: 102,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
