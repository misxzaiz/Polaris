import type { PolarisPluginManifest } from '@/plugin-system/types'

export const jsonTreePluginManifest: PolarisPluginManifest = {
  id: 'polaris.json-tree',
  name: 'JSON 树形',
  version: '0.1.0',
  description: 'JSON 数据树形查看器。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'jsonTree.panel',
        area: 'activityBar',
        panelType: 'jsonTree',
        icon: 'Files',
        labelKey: 'labels.jsonTree',
        labelDefault: 'JSON Tree',
        order: 103,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
