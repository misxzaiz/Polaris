import type { PolarisPluginManifest } from '@/plugin-system/types'

export const dataConverterPluginManifest: PolarisPluginManifest = {
  id: 'polaris.data-converter',
  name: '数据转换',
  version: '0.1.0',
  description: '数据格式转换工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'dataConverter.panel',
        area: 'activityBar',
        panelType: 'dataConverter',
        icon: 'Code2',
        labelKey: 'labels.dataConverter',
        labelDefault: 'Convert',
        order: 105,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
