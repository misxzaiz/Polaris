import type { PolarisPluginManifest } from '@/plugin-system/types'

export const codeReviewAssistantPluginManifest: PolarisPluginManifest = {
  id: 'polaris.code-review-assistant',
  name: 'Code Review Assistant',
  version: '0.1.0',
  description: '代码审查助手，提供代码质量检查和改进建议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'codeReviewAssistant.panel',
        area: 'activityBar',
        panelType: 'codeReviewAssistant',
        icon: 'CheckSquare',
        labelKey: 'labels.codeReviewAssistantPanel',
        labelDefault: 'Code Review Assistant',
        order: 115,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}