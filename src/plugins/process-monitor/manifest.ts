import type { PolarisPluginManifest } from '@/plugin-system/types'

export const processMonitorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.process-monitor',
  name: '进程监控',
  version: '0.1.0',
  description: '系统进程监控和管理工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'processMonitor.panel',
        area: 'activityBar',
        panelType: 'processMonitor',
        icon: 'Activity',
        labelKey: 'labels.processMonitor',
        labelDefault: 'Process',
        order: 92,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
