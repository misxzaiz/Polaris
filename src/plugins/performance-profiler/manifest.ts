import type { PolarisPluginManifest } from '@/plugin-system/types'

export const performanceProfilerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.performance-profiler',
  name: 'Performance Profiler',
  version: '0.1.0',
  description: '分析代码执行性能，检测性能瓶颈',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'performanceProfiler.panel',
        area: 'activityBar',
        panelType: 'performanceProfiler',
        icon: 'Activity',
        labelKey: 'labels.performanceProfilerPanel',
        labelDefault: 'Performance Profiler',
        order: 96,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}