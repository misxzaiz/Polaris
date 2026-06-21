import type { PolarisPluginManifest } from '@/plugin-system/types'

export const logViewerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.log-viewer',
  name: '日志查看',
  version: '0.1.0',
  description: '日志文件查看和分析工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'logViewer.panel',
        area: 'activityBar',
        panelType: 'logViewer',
        icon: 'ClipboardList',
        labelKey: 'labels.logViewer',
        labelDefault: 'Logs',
        order: 97,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
