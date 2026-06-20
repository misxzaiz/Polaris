import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * Git Insight 插件
 *
 * 只读的提交历史分析与可视化面板。复用后端 git_get_log 数据，
 * 在前端聚合贡献者分布、提交时间热度、文件 churn 等指标，
 * 并支持将分析摘要一键发送到对话。
 *
 * 设计边界：不执行任何写操作（commit/merge/push 等），与 core 的
 * GitPanel 职责互补、零重叠。提交 DAG 可视化（需后端按拓扑排序）
 * 列为二期。
 */
export const gitInsightPluginManifest: PolarisPluginManifest = {
  id: 'polaris.git-insight',
  name: 'Git Insight',
  version: '0.1.0',
  description: '提交历史统计分析面板（只读）：贡献者分布、提交热度、活跃度概览。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'gitInsight.panel',
        area: 'activityBar',
        panelType: 'gitInsight',
        icon: 'GitGraph',
        labelKey: 'labels.gitInsightPanel',
        labelDefault: 'Git Insight',
        // 紧挨 core 的 git 面板（order 20），便于用户关联
        order: 25,
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    aiToolAccess: true,
  },
}
