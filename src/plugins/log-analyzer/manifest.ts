import type { PolarisPluginManifest } from '@/plugin-system/types'

export const logAnalyzerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.log-analyzer',
  name: 'Log Analyzer',
  version: '0.1.0',
  description: '分析日志文件，提供日志查看和过滤功能',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'logAnalyzer.panel',
        area: 'activityBar',
        panelType: 'logAnalyzer',
        icon: 'FileText',
        labelKey: 'labels.logAnalyzerPanel',
        labelDefault: 'Log Analyzer',
        order: 112,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}