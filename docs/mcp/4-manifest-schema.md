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
  origin?: PluginOriginMetadata
}

interface PluginOriginMetadata {
  repository?: string
  homepage?: string
  updateUrl?: string
  downloadUrl?: string
}
```

约束：

- `id` 使用反向域名风格，例如 `polaris.todo`。
- `builtin` 为 `true` 的插件必须在前端内置 registry 中注册。
- 如果内置插件贡献 MCP server，后端必须在内置 MCP registry 中声明相同 `plugin_id` 和 server name。
- 外部安装插件可以贡献受控宿主面板，例如 demo 插件使用 `panelType: 'demoPlugin'`；当前不执行插件目录中的动态前端代码。
- 长期目标执行面板使用受控宿主 `panelType: 'longGoal'` 和 `icon: 'Target'`。
- `origin.repository` / `origin.homepage` 用于设置页展示插件来源；`origin.updateUrl` 指向可读取的远端或本地 manifest，用于检查是否存在新版本。`origin.downloadUrl` 指向插件 zip 包或插件目录/manifest 来源，用于远程安装和用户确认后的覆盖更新。检查更新只读取 manifest 并比较版本，不执行远端代码；覆盖安装必须由用户在设置页确认。

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
- 后端：`plugin_validate_manifest` 校验本地外部 manifest；`plugin_install_package` 安装本地 zip/json 包；`plugin_install_remote` 从远程 manifest/zip 安装；`plugin_check_update` 读取 `origin.updateUrl` 并返回 `currentVersion` / `latestVersion` / `updateAvailable` / `downloadUrl`；`plugin_apply_update` 根据 `origin.downloadUrl` 下载/复制更新包并在用户确认后覆盖安装目录。
