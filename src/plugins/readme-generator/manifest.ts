import type { PolarisPluginManifest } from '@/plugin-system/types'

export const readmeGeneratorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.readme-generator',
  name: 'README Generator',
  version: '0.1.0',
  description: '为项目生成README文件，支持多种模板',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'readmeGenerator.panel',
        area: 'activityBar',
        panelType: 'readmeGenerator',
        icon: 'BookOpen',
        labelKey: 'labels.readmeGeneratorPanel',
        labelDefault: 'README Generator',
        order: 100,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}