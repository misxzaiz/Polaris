import type { PolarisPluginManifest } from '@/plugin-system/types'

export const dependencyAuditPluginManifest: PolarisPluginManifest = {
  id: 'polaris.dependency-audit',
  name: 'Dependency Audit',
  version: '0.1.0',
  description: '检查依赖包的安全问题，提供更新建议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'dependencyAudit.panel',
        area: 'activityBar',
        panelType: 'dependencyAudit',
        icon: 'CheckSquare',
        labelKey: 'labels.dependencyAuditPanel',
        labelDefault: 'Dependency Audit',
        order: 93,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    network: true,
    aiToolAccess: true,
  },
}