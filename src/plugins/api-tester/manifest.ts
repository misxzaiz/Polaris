import type { PolarisPluginManifest } from '@/plugin-system/types'

export const apiTesterPluginManifest: PolarisPluginManifest = {
  id: 'polaris.api-tester',
  name: 'API 测试',
  version: '0.1.0',
  description: 'API 接口测试工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'apiTester.panel',
        area: 'activityBar',
        panelType: 'apiTester',
        icon: 'Globe',
        labelKey: 'labels.apiTester',
        labelDefault: 'API',
        order: 104,
      },
    ],
  },
  permissions: {
    network: true,
    aiToolAccess: true,
  },
}
