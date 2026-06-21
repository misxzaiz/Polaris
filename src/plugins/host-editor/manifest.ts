import type { PolarisPluginManifest } from '@/plugin-system/types'

export const hostEditorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.host-editor',
  name: 'Hosts 编辑',
  version: '0.1.0',
  description: 'Hosts 文件编辑和管理工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'hostEditor.panel',
        area: 'activityBar',
        panelType: 'hostEditor',
        icon: 'Globe',
        labelKey: 'labels.hostEditor',
        labelDefault: 'Hosts',
        order: 96,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}
