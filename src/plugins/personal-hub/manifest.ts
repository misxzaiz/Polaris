import type { PolarisPluginManifest } from '@/plugin-system/types'

export const personalHubPluginManifest: PolarisPluginManifest = {
  id: 'polaris.personal-hub',
  name: '个人空间',
  version: '0.1.0',
  description: '集成 personal-hub 的 Supabase 登录注册、字段级加密与 links 数据管理。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'personalHub.panel',
        area: 'activityBar',
        panelType: 'personalHub',
        icon: 'BookOpen',
        labelKey: 'labels.personalHubPanel',
        labelDefault: 'Personal Hub',
        order: 65,
      },
    ],
  },
  permissions: {
    network: true,
    appConfigRead: true,
  },
}
