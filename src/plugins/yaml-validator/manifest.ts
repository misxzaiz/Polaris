import type { PolarisPluginManifest } from '@/plugin-system/types'

export const yamlValidatorPluginManifest: PolarisPluginManifest = {
  id: 'polaris.yaml-validator',
  name: 'YAML 工具',
  version: '0.1.0',
  description: 'YAML 格式化、验证和转换工具。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'yamlValidator.panel',
        area: 'activityBar',
        panelType: 'yamlValidator',
        icon: 'Code2',
        labelKey: 'labels.yamlValidator',
        labelDefault: 'YAML',
        order: 89,
      },
    ],
  },
  permissions: {
    aiToolAccess: true,
  },
}
