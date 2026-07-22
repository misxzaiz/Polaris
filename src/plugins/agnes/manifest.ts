import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * Agnes 多模态内置插件。
 *
 * 提供活动栏面板（生图 / 生视频 / 设置）与 polaris-agnes MCP server。
 * MCP bin 由 src-tauri/src/bin/polaris_agnes_mcp.rs 构建，凭证从
 * `<appConfigDir>/agnes/config.json` 读取，由面板设置页写入。
 */
export const agnesPluginManifest: PolarisPluginManifest = {
  id: 'polaris.agnes',
  name: 'Agnes 多模态',
  version: '0.1.0',
  description: 'Agnes Image 2.1 Flash 文生图/图生图 + Agnes Video V2.0 文生视频/图生视频/多图/关键帧。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'agnes.panel',
        area: 'activityBar',
        panelType: 'agnes',
        icon: 'Film',
        labelKey: 'labels.agnesPanel',
        labelDefault: 'Agnes',
        order: 50,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-agnes',
        transport: 'stdio',
        command: 'polaris_agnes_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
    chatCards: [
      {
        id: 'media-card',
        mcpServerId: 'polaris-agnes',
        tools: ['generate_image', 'generate_video', 'query_video'],
        mode: 'result',
      },
    ],
  },
  permissions: {
    network: true,
    appConfigRead: true,
    appConfigWrite: true,
    aiToolAccess: true,
  },
}
