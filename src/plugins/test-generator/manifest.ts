import type { PolarisPluginManifest } from '@/plugin-system/types'

export const testGeneratorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.test-generator',
  name: 'Test Generator',
  version: '0.1.0',
  description: '基于代码生成测试用例，支持多种测试框架',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'testGenerator.panel',
        area: 'activityBar',
        panelType: 'testGenerator',
        icon: 'Bot',
        labelKey: 'labels.testGeneratorPanel',
        labelDefault: 'Test Generator',
        order: 90,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}