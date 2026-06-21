import type { PolarisPluginManifest } from '@/plugin-system/types'

export const dependencyGraphPluginManifest: PolarisPluginManifest = {
  id: 'polaris.dependency-graph',
  name: 'Dependency Graph',
  version: '0.1.0',
  description: '可视化模块依赖关系，分析项目结构',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'dependencyGraph.panel',
        area: 'activityBar',
        panelType: 'dependencyGraph',
        icon: 'GitGraph',
        labelKey: 'labels.dependencyGraphPanel',
        labelDefault: 'Dependency Graph',
        order: 87,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}