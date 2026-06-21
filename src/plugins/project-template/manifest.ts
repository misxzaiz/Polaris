import type { PolarisPluginManifest } from '@/plugin-system/types'

export const projectTemplatePluginManifest: PolarisPluginManifest = {
  id: 'polaris.project-template',
  name: 'Project Template',
  version: '0.1.0',
  description: '生成项目模板，支持多种技术栈',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'projectTemplate.panel',
        area: 'activityBar',
        panelType: 'projectTemplate',
        icon: 'Code2',
        labelKey: 'labels.projectTemplatePanel',
        labelDefault: 'Project Template',
        order: 110,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}