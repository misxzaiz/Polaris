import type { PolarisPluginManifest } from '@/plugin-system/types'

export const batchRenamePluginManifest: PolarisPluginManifest = {
  id: 'polaris.batch-rename',
  name: '批量重命名',
  version: '0.1.0',
  description: '文件批量重命名工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'batchRename.panel',
        area: 'activityBar',
        panelType: 'batchRename',
        icon: 'Files',
        labelKey: 'labels.batchRename',
        labelDefault: 'Rename',
        order: 101,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}
