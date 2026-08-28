import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 定时任务内置插件 manifest
 *
 * 后端(commands + daemon + 存储)与前端面板(SchedulerPanel)完全内置在主仓库;
 * MCP server 也由主仓库二进制 polaris_scheduler_mcp 提供(非外置 node server.js)。
 * 此 manifest 仅声明 views + mcpServers 贡献,让 activityBar 入口和 MCP 注册
 * 不再依赖外置插件目录。
 */
export const schedulerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.scheduler',
  name: 'Scheduler',
  version: '1.0.0',
  description: '定时任务调度器：支持 interval/cron/once 触发，集成 AI 执行能力。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'scheduler.panel',
        area: 'activityBar',
        panelType: 'scheduler',
        icon: 'Clock',
        labelKey: 'labels.schedulerPanel',
        labelDefault: 'Scheduler',
        order: 50,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-scheduler',
        transport: 'stdio',
        command: 'polaris_scheduler_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    appConfigRead: true,
    appConfigWrite: true,
    aiToolAccess: true,
  },
}
