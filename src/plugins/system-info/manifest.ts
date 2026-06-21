import type { PolarisPluginManifest } from '@/plugin-system/types'

export const systemInfoPluginManifest: PolarisPluginManifest = {
  id: 'polaris.system-info',
  name: '系统信息',
  version: '0.1.0',
  description: '系统信息查看工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'systemInfo.panel',
        area: 'activityBar',
        panelType: 'systemInfo',
        icon: 'Activity',
        labelKey: 'labels.systemInfo',
        labelDefault: 'System',
        order: 98,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
