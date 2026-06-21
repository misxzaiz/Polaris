import type { PolarisPluginManifest } from '@/plugin-system/types'

export const textTransformerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.text-transformer',
  name: '文本转换',
  version: '0.1.0',
  description: '文本格式转换和处理工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'textTransformer.panel',
        area: 'activityBar',
        panelType: 'textTransformer',
        icon: 'Code2',
        labelKey: 'labels.textTransformer',
        labelDefault: 'Text',
        order: 99,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
