import type { PolarisPluginManifest } from '@/plugin-system/types'

export const bundleAnalyzerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.bundle-analyzer',
  name: 'Bundle Analyzer',
  version: '0.1.0',
  description: '分析前端包大小和组成，优化打包配置',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'bundleAnalyzer.panel',
        area: 'activityBar',
        panelType: 'bundleAnalyzer',
        icon: 'Activity',
        labelKey: 'labels.bundleAnalyzerPanel',
        labelDefault: 'Bundle Analyzer',
        order: 95,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}