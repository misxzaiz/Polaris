import type { PolarisPluginManifest } from '@/plugin-system/types'

export const diskAnalyzerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.disk-analyzer',
  name: '磁盘分析',
  version: '0.1.0',
  description: '磁盘空间使用分析工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'diskAnalyzer.panel',
        area: 'activityBar',
        panelType: 'diskAnalyzer',
        icon: 'Activity',
        labelKey: 'labels.diskAnalyzer',
        labelDefault: 'Disk',
        order: 93,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
