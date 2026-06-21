import type { PolarisPluginManifest } from '@/plugin-system/types'

export const mutationTestingPluginManifest: PolarisPluginManifest = {
  id: 'polaris.mutation-testing',
  name: 'Mutation Testing',
  version: '0.1.0',
  description: '通过修改代码验证测试质量，检测测试用例的有效性',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'mutationTesting.panel',
        area: 'activityBar',
        panelType: 'mutationTesting',
        icon: 'Activity',
        labelKey: 'labels.mutationTestingPanel',
        labelDefault: 'Mutation Testing',
        order: 91,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}