import type { PolarisPluginManifest } from '@/plugin-system/types'

export const memoryLeakDetectorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.memory-leak-detector',
  name: 'Memory Leak Detector',
  version: '0.1.0',
  description: '检测潜在的内存泄漏，提供修复建议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'memoryLeakDetector.panel',
        area: 'activityBar',
        panelType: 'memoryLeakDetector',
        icon: 'AlertCircle',
        labelKey: 'labels.memoryLeakDetectorPanel',
        labelDefault: 'Memory Leak Detector',
        order: 97,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}