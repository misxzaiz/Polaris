import type { PolarisPluginManifest } from '@/plugin-system/types'

/**
 * Polaris Knowledge 插件 manifest。
 *
 * Phase 1 of the Knowledge plugin refactor: split `knowledge.panel` and the
 * `polaris-knowledge` MCP server out of the monolithic `polaris.core` builtin
 * so users can independently enable/disable them, and so the panel + MCP
 * surface can be externalized in later phases without touching `core`.
 *
 * The view contribution and MCP server `id` must stay in lock-step with their
 * Rust counterparts:
 *   - `panelType: 'knowledge'`           — matches LeftPanel content key
 *   - `mcpServers[0].id: 'polaris-knowledge'`
 *                                        — matches `KNOWLEDGE_MCP_SERVER_NAME`
 *                                          in `src-tauri/.../mcp_config_service.rs`
 *   - plugin id `polaris.knowledge`      — matches `KNOWLEDGE_PLUGIN_ID`
 *                                          in `src-tauri/.../mcp_config_service.rs`
 */
export const knowledgePluginManifest: PolarisPluginManifest = {
  id: 'polaris.knowledge',
  name: 'Knowledge',
  version: '0.1.0',
  description: '项目知识库面板和 Knowledge MCP 工具面。',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [
      {
        id: 'knowledge.panel',
        area: 'activityBar',
        panelType: 'knowledge',
        icon: 'BookOpen',
        labelKey: 'labels.knowledgePanel',
        labelDefault: 'Knowledge',
        order: 100,
      },
    ],
    mcpServers: [
      {
        id: 'polaris-knowledge',
        transport: 'stdio',
        command: 'polaris_knowledge_mcp',
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
