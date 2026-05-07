# 1. 已完成内容与当前架构

## 已完成提交

- `759b2be8 feat: add plugin registry and settings controls`
  - 前端插件类型、注册表、内置插件声明、图标映射。
  - Todo 作为首个内置插件案例。
  - ActivityBar、RadialMenu、App 接入插件 UI contributions。
  - 设置页新增 Plugins 标签，可控制插件、UI 模块、MCP 能力开关。

- `e4b44cca feat: add plugin mcp contribution aggregation`
  - 前端聚合插件 MCP contributions。
  - 根据插件状态计算启用/禁用的 MCP server。
  - 设置页展示插件 MCP server 数量和启用状态。

- `ab850a58 feat: honor disabled plugin mcp servers`
  - 聊天请求携带 `disabledMcpServers`。
  - 后端生成 Claude/Codex MCP 配置时跳过被禁用的 MCP server。

- `07503c73 fix: restore session config typecheck`
  - 修复已有 TypeScript 类型检查问题。

- `8c0c8d81 feat: persist plugin state in backend`
  - 插件状态持久化到应用配置目录 `plugins/state.json`。
  - 前端启动加载后端状态，变更时保存。
  - Web HTTP IPC 支持插件状态读写。

- `bf407ff7 feat: show plugin mcp runtime status`
  - 设置页展示插件 MCP runtime 状态。
  - 复用已有 `mcp_health_check`。

- `4812c356 refactor: define builtin mcp servers declaratively`
  - 后端内置 MCP server 改为声明式定义表。
  - 为后续插件式 MCP server 扩展打基础。

## 当前关键文件

- 前端插件系统：
  - `src/plugin-system/types.ts`
  - `src/plugin-system/registry.ts`
  - `src/plugin-system/mcp.ts`
  - `src/plugin-system/builtinPlugins.ts`
  - `src/plugins/todo/manifest.ts`

- 插件状态：
  - `src/stores/pluginStore.ts`
  - `src/services/pluginStateService.ts`
  - `src-tauri/src/models/plugin_state.rs`
  - `src-tauri/src/services/plugin_state_service.rs`
  - `src-tauri/src/commands/plugin_state.rs`

- MCP 配置与运行状态：
  - `src-tauri/src/services/mcp_config_service.rs`
  - `src-tauri/src/services/mcp_manager_service.rs`
  - `src/services/mcpHealthService.ts`
  - `src/components/Settings/tabs/PluginTab.tsx`

## 当前架构边界

前端插件 manifest 已经可以声明 UI 和 MCP contribution，但后端 MCP 配置生成仍主要依赖 Rust 内置定义表。当前两端通过 server id/name 对齐，例如 Todo 使用 `polaris-todo`。

聊天链路已经支持禁用插件 MCP server，但还没有支持“任意插件新增 MCP server 后自动进入后端配置生成”的完整闭环。

## 当前验证状态

- `npx tsc --noEmit`：已通过。
- 插件相关 Vitest：已通过。
- `cargo check --lib`：已通过。
- Rust 单测在本机运行阶段有既有 `STATUS_ENTRYPOINT_NOT_FOUND`，当前只能确认编译通过，不能依赖本机 Rust test binary 运行结果。

