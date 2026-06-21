import type { PolarisPluginManifest } from '@/plugin-system/types'

export const complexityAnalyzerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.complexity-analyzer',
  name: 'Code Complexity Analyzer',
  version: '0.1.0',
  description: '分析代码圈复杂度、认知复杂度，提供代码质量评估',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'complexityAnalyzer.panel',
        area: 'activityBar',
        panelType: 'complexityAnalyzer',
        icon: 'Activity',
        labelKey: 'labels.complexityAnalyzerPanel',
        labelDefault: 'Complexity Analyzer',
        order: 86,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}