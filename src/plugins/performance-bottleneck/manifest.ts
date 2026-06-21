import type { PolarisPluginManifest } from '@/plugin-system/types'

export const performanceBottleneckPluginManifest: PolarisPluginManifest = {
  id: 'polaris.performance-bottleneck',
  name: 'Performance Bottleneck',
  version: '0.1.0',
  description: '分析代码性能瓶颈，提供优化建议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'performanceBottleneck.panel',
        area: 'activityBar',
        panelType: 'performanceBottleneck',
        icon: 'Activity',
        labelKey: 'labels.performanceBottleneckPanel',
        labelDefault: 'Performance Bottleneck',
        order: 103,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}