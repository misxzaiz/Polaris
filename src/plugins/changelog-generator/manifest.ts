import type { PolarisPluginManifest } from '@/plugin-system/types'

export const changelogGeneratorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.changelog-generator',
  name: 'Changelog Generator',
  version: '0.1.0',
  description: '从Git提交生成更新日志，支持多种格式',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'changelogGenerator.panel',
        area: 'activityBar',
        panelType: 'changelogGenerator',
        icon: 'GitPullRequest',
        labelKey: 'labels.changelogGeneratorPanel',
        labelDefault: 'Changelog Generator',
        order: 99,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}