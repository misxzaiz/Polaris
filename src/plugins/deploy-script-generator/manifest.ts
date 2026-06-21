import type { PolarisPluginManifest } from '@/plugin-system/types'

export const deployScriptGeneratorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.deploy-script-generator',
  name: 'Deploy Script Generator',
  version: '0.1.0',
  description: '生成部署脚本，支持多种部署方式',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'deployScriptGenerator.panel',
        area: 'activityBar',
        panelType: 'deployScriptGenerator',
        icon: 'Terminal',
        labelKey: 'labels.deployScriptGeneratorPanel',
        labelDefault: 'Deploy Script Generator',
        order: 114,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}