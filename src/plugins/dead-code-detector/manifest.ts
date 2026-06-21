import type { PolarisPluginManifest } from '@/plugin-system/types'

export const deadCodeDetectorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.dead-code-detector',
  name: 'Dead Code Detector',
  version: '0.1.0',
  description: '检测未使用的代码和导入，帮助清理代码库',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'deadCodeDetector.panel',
        area: 'activityBar',
        panelType: 'deadCodeDetector',
        icon: 'AlertCircle',
        labelKey: 'labels.deadCodeDetectorPanel',
        labelDefault: 'Dead Code Detector',
        order: 88,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}