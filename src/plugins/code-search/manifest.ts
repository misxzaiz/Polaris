import type { PolarisPluginManifest } from '@/plugin-system/types'

export const codeSearchPluginManifest: PolarisPluginManifest = {
  id: 'polaris.code-search',
  name: 'Code Search',
  version: '0.1.0',
  description: '增强代码搜索功能，支持正则表达式和语义搜索',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'codeSearch.panel',
        area: 'activityBar',
        panelType: 'codeSearch',
        icon: 'Search',
        labelKey: 'labels.codeSearchPanel',
        labelDefault: 'Code Search',
        order: 111,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}