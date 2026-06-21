import type { PolarisPluginManifest } from '@/plugin-system/types'

export const apiDocGeneratorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.api-doc-generator',
  name: 'API Doc Generator',
  version: '0.1.0',
  description: '从代码生成API文档，支持多种格式',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'apiDocGenerator.panel',
        area: 'activityBar',
        panelType: 'apiDocGenerator',
        icon: 'BookOpen',
        labelKey: 'labels.apiDocGeneratorPanel',
        labelDefault: 'API Doc Generator',
        order: 98,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}