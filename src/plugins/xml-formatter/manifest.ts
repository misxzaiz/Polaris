import type { PolarisPluginManifest } from '@/plugin-system/types'

export const xmlFormatterPluginManifest: PolarisPluginManifest = {
  id: 'polaris.xml-formatter',
  name: 'XML 工具',
  version: '0.1.0',
  description: 'XML 格式化、压缩和验证工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'xmlFormatter.panel',
        area: 'activityBar',
        panelType: 'xmlFormatter',
        icon: 'Code2',
        labelKey: 'labels.xmlFormatter',
        labelDefault: 'XML',
        order: 90,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
