import type { PolarisPluginManifest } from '@/plugin-system/types'

export const secretScannerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.secret-scanner',
  name: 'Secret Scanner',
  version: '0.1.0',
  description: '检测代码中的硬编码密钥、密码等敏感信息',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'secretScanner.panel',
        area: 'activityBar',
        panelType: 'secretScanner',
        icon: 'Target',
        labelKey: 'labels.secretScannerPanel',
        labelDefault: 'Secret Scanner',
        order: 94,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}