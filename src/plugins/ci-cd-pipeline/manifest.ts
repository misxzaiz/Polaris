import type { PolarisPluginManifest } from '@/plugin-system/types'

export const ciCdPipelinePluginManifest: PolarisPluginManifest = {
  id: 'polaris.ci-cd-pipeline',
  name: 'CI/CD Pipeline',
  version: '0.1.0',
  description: '管理持续集成/部署管道，支持多种CI/CD平台',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'ciCdPipeline.panel',
        area: 'activityBar',
        panelType: 'ciCdPipeline',
        icon: 'GitPullRequest',
        labelKey: 'labels.ciCdPipelinePanel',
        labelDefault: 'CI/CD Pipeline',
        order: 108,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    network: true,
    aiToolAccess: true,
  },
}