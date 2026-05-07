# 4. 插件 Manifest Schema

## 目标

阶段 5 先固化内置插件 manifest 的稳定字段，避免前端 Todo manifest 和后端 MCP contribution registry 通过裸字符串隐式对齐。

当前仍以 TypeScript manifest 为前端来源，Rust 侧维护内置 MCP manifest mirror，并通过测试校验两侧关键标识。

## 顶层字段

```ts
interface PolarisPluginManifest {
  id: string
  name: string
  version: string
  description?: string
  builtin: boolean
  enabledByDefault: boolean
  contributes: {
    views?: PluginViewContribution[]
    mcpServers?: PluginMcpServerContribution[]
  }
  permissions: PluginPermissionDeclaration
}
```

约束：

- `id` 使用反向域名风格，例如 `polaris.todo`。
- `builtin` 为 `true` 的插件必须在前端内置 registry 中注册。
- 如果内置插件贡献 MCP server，后端必须在内置 MCP registry 中声明相同 `plugin_id` 和 server name。
- 外部安装插件可以贡献受控宿主面板，例如 demo 插件使用 `panelType: 'demoPlugin'`；当前不执行插件目录中的动态前端代码。

## MCP Server Contribution

```ts
interface PluginMcpServerContribution {
  id: string
  transport: 'stdio' | 'http'
  command: string
  argsTemplate?: string[]
}
```

约束：

- `id` 是 MCP server name，也是聊天链路 `disabledMcpServers` 使用的稳定标识。
- `transport` 当前后端只支持 `stdio`，前端不得为内置本地 MCP server 声明其他 transport。
- `command` 是前端展示/声明字段；后端实际启动路径由 Rust registry 解析。
- 内置 MCP server 的 `argsTemplate` 目前支持 `{{appConfigDir}}` 和 `{{workspacePath}}`，对应 Rust `McpServerArgsMode::ConfigDirAndWorkspace`。
- 外部安装插件的 `argsTemplate` 额外支持 `{{pluginDir}}`，用于解析插件安装目录内的脚本或二进制。

## 当前内置对齐表

| Plugin ID | MCP Server ID | Transport | Frontend command | Backend bin name | Args mode |
| --- | --- | --- | --- | --- | --- |
| `polaris.todo` | `polaris-todo` | `stdio` | `polaris_todo_mcp` | `polaris-todo-mcp` | `ConfigDirAndWorkspace` |

## 校验入口

- 前端：`src/plugin-system/mcp.test.ts` 校验 `polaris.todo` manifest 声明。
- 后端：`src-tauri/src/services/mcp_config_service.rs` 中 `builtin_plugin_mcp_manifest_matches_registry` 校验 Rust mirror 与 registry。
