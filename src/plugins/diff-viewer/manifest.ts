import type { PolarisPluginManifest } from '@/plugin-system/types'

export const diffViewerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.diff-viewer',
  name: '差异查看',
  version: '0.1.0',
  description: '文本差异对比工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'diffViewer.panel',
        area: 'activityBar',
        panelType: 'diffViewer',
        icon: 'GitPullRequest',
        labelKey: 'labels.diffViewer',
        labelDefault: 'Diff',
        order: 100,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
