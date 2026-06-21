import type { PolarisPluginManifest } from '@/plugin-system/types'

export const legacyCodeRefactorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.legacy-code-refactor',
  name: 'Legacy Code Refactor',
  version: '0.1.0',
  description: '帮助重构遗留代码，提供现代化改造建议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'legacyCodeRefactor.panel',
        area: 'activityBar',
        panelType: 'legacyCodeRefactor',
        icon: 'Code2',
        labelKey: 'labels.legacyCodeRefactorPanel',
        labelDefault: 'Legacy Code Refactor',
        order: 102,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}