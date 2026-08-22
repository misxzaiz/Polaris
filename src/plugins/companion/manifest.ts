import type { PolarisPluginManifest } from '@/plugin-system/types';

/**
 * AI 主动陪伴助手 builtin plugin manifest
 *
 * 注册面板入口到 ActivityBar，panelType='companion'
 * 图标使用 'Bot'（已在 plugin-system/icons.ts 白名单）
 */
export const companionPluginManifest: PolarisPluginManifest = {
  id: 'polaris.companion',
  name: 'AI 陪伴',
  version: '0.1.0',
  description: '主动感知上下文、带着用户学习新技能/集成新功能的 AI 陪伴助手。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'companion.panel',
        area: 'activityBar',
        panelType: 'companion',
        icon: 'Bot',
        labelKey: 'labels.companionPanel',
        labelDefault: 'AI Companion',
        order: 50,
      },
    ],
  },
  permissions: {
    appConfigRead: true,
    appConfigWrite: true,
    aiToolAccess: true,
  },
};
