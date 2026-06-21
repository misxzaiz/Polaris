import type { PolarisPluginManifest } from '@/plugin-system/types'

export const jsonFormatterPluginManifest: PolarisPluginManifest = {
  id: 'polaris.json-formatter',
  name: 'JSON 工具',
  version: '0.1.0',
  description: 'JSON 格式化、压缩、校验和转换工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'jsonFormatter.panel',
        area: 'activityBar',
        panelType: 'jsonFormatter',
        icon: 'Code2',
        labelKey: 'labels.jsonFormatter',
        labelDefault: 'JSON',
        order: 82,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
