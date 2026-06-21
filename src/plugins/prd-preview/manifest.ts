import type { PolarisPluginManifest } from '@/plugin-system/types'

export const prdPreviewPluginManifest: PolarisPluginManifest = {
  id: 'polaris.prd-preview',
  name: 'PRD Preview',
  version: '0.1.0',
  description: '提供 PRD HTML 原型预览 MCP 工具能力。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-prd-preview',
        transport: 'stdio',
        command: 'polaris_prd_preview_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    workspaceRead: true,
    workspaceWrite: true,
    appConfigRead: true,
    aiToolAccess: true,
  },
}
