import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * 内置电脑操作插件。
 *
 * 注意：id 与 mcpServers[].id 必须与后端硬编码常量严格一致
 * （src-tauri/src/services/mcp_config_service.rs 中的
 * COMPUTER_PLUGIN_ID / COMPUTER_MCP_SERVER_NAME），
 * 否则禁用开关将静默失效。一致性由 manifest.test.ts 守护。
 *
 * 平台说明：computer MCP 二进制仅在 Windows 构建（cfg(windows) 门控），
 * 其他平台后端会以"可执行文件不存在"自动跳过注入。
 */
export const computerPluginManifest: PolarisPluginManifest = {
  id: 'polaris.computer',
  name: '电脑操作',
  version: '0.1.0',
  description: '提供 Computer MCP 工具能力（截图、鼠标键盘控制、窗口与控件操作）。关闭后将不再注入到 AI 会话。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    mcpServers: [
      {
        id: 'polaris-computer',
        transport: 'stdio',
        command: 'polaris_computer_mcp',
        argsTemplate: ['{{appConfigDir}}', '{{workspacePath}}'],
      },
    ],
  },
  permissions: {
    appConfigRead: true,
    aiToolAccess: true,
  },
}
