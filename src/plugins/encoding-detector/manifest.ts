import type { PolarisPluginManifest } from '@/plugin-system/types'

export const encodingDetectorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.encoding-detector',
  name: '编码检测',
  version: '0.1.0',
  description: '文本编码检测和转换工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'encodingDetector.panel',
        area: 'activityBar',
        panelType: 'encodingDetector',
        icon: 'Languages',
        labelKey: 'labels.encodingDetector',
        labelDefault: 'Encoding',
        order: 106,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
