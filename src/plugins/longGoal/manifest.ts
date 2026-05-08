import type { PolarisPluginManifest } from '@/plugin-system/types'

export const longGoalPluginManifest: PolarisPluginManifest = {
  id: 'polaris.long-goal',
  name: 'Long Goal MCP',
  version: '0.1.0',
  description: '长期目标执行 MCP 工具面。UI 暂由 Polaris Core 托管。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-long-goal',
        transport: 'stdio',
        command: 'polaris_long_goal_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    aiToolAccess: true,
  },
}
