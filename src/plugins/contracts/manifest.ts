import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 契约测试/管理面板 manifest
 *
 * 阶段 A：纯前端面板，自证契约语义（Envelope/Source roundtrip + 契约清单）。
 * 后端连接（已注册能力/依赖图/事件追踪）等在 RouterBus 实现后（第 3 步）再接。
 */
export const contractsPluginManifest: PolarisPluginManifest = {
  id: 'polaris.contracts',
  name: 'Contracts',
  version: '0.1.0',
  description: '核心契约测试与管理面板：Envelope/Source roundtrip 测试台 + 6+1 契约清单。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'contracts.panel',
        area: 'activityBar',
        panelType: 'contracts',
        icon: 'Beaker',
        labelKey: 'labels.contractsPanel',
        labelDefault: 'Contracts',
        order: 96,
      },
    ],
  },
  permissions: {},
}