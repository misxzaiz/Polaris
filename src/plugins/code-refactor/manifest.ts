import type { PolarisPluginManifest } from '@/plugin-system/types'

export const codeRefactorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.code-refactor',
  name: 'Code Refactor',
  version: '0.1.0',
  description: '提供代码重构建议，优化代码结构',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'codeRefactor.panel',
        area: 'activityBar',
        panelType: 'codeRefactor',
        icon: 'Code2',
        labelKey: 'labels.codeRefactorPanel',
        labelDefault: 'Code Refactor',
        order: 101,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}