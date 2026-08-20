import type { PolarisPluginManifest } from '@/plugin-system/types'

export const engineTestPluginManifest: PolarisPluginManifest = {
  id: 'polaris.engine-test',
  name: '引擎测试',
  version: '0.1.0',
  description: 'AI 引擎插件路径验证面板：测试 PluginProcessEngine + engine-v1 协议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'engineTest.panel',
        area: 'activityBar',
        panelType: 'engineTest',
        icon: 'Activity',
        labelKey: 'labels.engineTestPanel',
        labelDefault: '引擎测试',
        order: 55,
      },
    ],
  },
  permissions: {},
}