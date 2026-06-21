import type { PolarisPluginManifest } from '@/plugin-system/types'

export const markdownToolsPluginManifest: PolarisPluginManifest = {
  id: 'polaris.markdown-tools',
  name: 'Markdown 工具',
  version: '0.1.0',
  description: 'Markdown 预览、格式化和工具集。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'markdownTools.panel',
        area: 'activityBar',
        panelType: 'markdownTools',
        icon: 'BookOpen',
        labelKey: 'labels.markdownTools',
        labelDefault: 'Markdown',
        order: 91,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
