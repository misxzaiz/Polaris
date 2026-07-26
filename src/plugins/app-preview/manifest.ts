import type { PolarisPluginManifest } from '@/plugin-system/types'

export const appPreviewPluginManifest: PolarisPluginManifest = {
  id: 'polaris.app-preview',
  name: 'App Preview',
  version: '0.1.0',
  description: '手机 App 预览面板 — 在手机外框内实时预览前端项目。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'app-preview.panel',
        area: 'activityBar',
        panelType: 'app-preview',
        icon: 'Smartphone',
        labelKey: 'labels.appPreview',
        labelDefault: 'App Preview',
        order: 35, // 放在 Browser(30) 和 Translate(40) 之间
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: false,
    appConfigRead: false,
    aiToolAccess: false,
  },
}