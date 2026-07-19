import type { PolarisPluginManifest } from '@/plugin-system/types'

export const agentGalleryPluginManifest: PolarisPluginManifest = {
  id: 'polaris.agent-gallery',
  name: '专家画廊',
  version: '0.1.0',
  description: 'Agency Agents 专家库:浏览/搜索 267 位专家,设为当前 agent 或派发任务。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'agentGallery.panel',
        area: 'activityBar',
        panelType: 'agentGallery',
        icon: 'Users',
        labelKey: 'labels.agentGalleryPanel',
        labelDefault: 'Agents',
        order: 35,
      },
    ],
  },
  permissions: {},
}
