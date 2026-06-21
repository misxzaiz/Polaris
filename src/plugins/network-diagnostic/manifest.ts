import type { PolarisPluginManifest } from '@/plugin-system/types'

export const networkDiagnosticPluginManifest: PolarisPluginManifest = {
  id: 'polaris.network-diagnostic',
  name: '网络诊断',
  version: '0.1.0',
  description: '网络连通性测试和诊断工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'networkDiagnostic.panel',
        area: 'activityBar',
        panelType: 'networkDiagnostic',
        icon: 'Globe',
        labelKey: 'labels.networkDiagnostic',
        labelDefault: 'Network',
        order: 94,
      },
    ],
  },
  permissions: {
    network: true,
    aiToolAccess: true,
  },
}
