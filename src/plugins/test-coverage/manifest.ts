import type { PolarisPluginManifest } from '@/plugin-system/types'

export const testCoveragePluginManifest: PolarisPluginManifest = {
  id: 'polaris.test-coverage',
  name: 'Test Coverage Report',
  version: '0.1.0',
  description: '生成和查看测试覆盖率报告，分析测试质量',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'testCoverage.panel',
        area: 'activityBar',
        panelType: 'testCoverage',
        icon: 'CheckSquare',
        labelKey: 'labels.testCoveragePanel',
        labelDefault: 'Test Coverage',
        order: 89,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}