# Claude CLI 可视化分析与设计文档（深度修订版）

**分析日期**: 2026-04-15
**CLI 版本**: 2.1.104 (Claude Code)
**项目**: Polaris (Tauri + React + TypeScript)
**版本**: v2.0 — 基于 stream-json 实测数据全面修订

---

## 文档目录

| 文档 | 说明 | 核心发现 | 状态 |
|------|------|---------|------|
| [01-命令全景/CLI命令全景.md](./01-命令全景/CLI命令全景.md) | CLI 所有命令、选项、输出格式完整分析 | **stream-json init 事件是核心数据源** | ✅ v2.0 |
| [02-现状分析/已实现vs未实现.md](./02-现状分析/已实现vs未实现.md) | Polaris 源码逐行对照分析 | **PRESET_AGENTS 有 bug，code-reviewer ID 不匹配** | ✅ v2.0 |
| [03-功能规划/实施路线图.md](./03-功能规划/实施路线图.md) | 分阶段实施计划、后端接口、缓存策略 | **混合数据获取策略 (独立命令 + init 事件)** | ✅ v2.0 |
| [04-交互原型/界面设计.md](./04-交互原型/界面设计.md) | UI 线框图、组件设计、交互流程 | **MCP 两种来源区分设计** | ✅ v2.0 |
| [05-数据结构/stream-json分析.md](./05-数据结构/stream-json分析.md) | stream-json 事件完整数据结构 | **init 事件包含 13 个字段的全量数据** | ✅ 新增 |

---

## 核心发现

### 1. stream-json init 事件（最重要）

`claude -p --output-format stream-json --verbose` 在每次会话启动时输出 `init` 事件，包含：

| 字段 | 数据 | 前端价值 |
|------|------|---------|
| `agents[]` | 8 个 Agent ID | **替代硬编码 Agent 列表** |
| `tools[]` | 28 个工具名 | **工具权限管理** |
| `mcp_servers[]` | 4 个 MCP + 状态 | **MCP 状态监控** |
| `skills[]` | 39 个技能名 | 技能浏览 |
| `plugins[]` | 8 个活跃插件 | 插件状态同步 |
| `model` | 当前模型名 | 模型指示器 |
| `claude_code_version` | 版本号 | 版本显示 |

**关键结论**: 无需额外 API 调用，init 事件已包含全部动态数据。

### 2. 现有代码硬编码问题

| 问题 | 位置 | 影响 |
|------|------|------|
| `code-reviewer` Agent ID 不存在 | `sessionConfig.ts` L113 | CLI 找不到该 Agent |
| 缺少 4 个 Plugin Agent | `sessionConfig.ts` | 用户无法选择插件 Agent |
| 缺少 `statusline-setup` Agent | `sessionConfig.ts` | Agent 列表不完整 |
| 缺少 `max` effort 级别 | `sessionConfig.ts` L163-179 | 功能缺失 |
| 认证状态完全缺失 | 无 | 用户不知道是否登录 |
| MCP 无法独立管理 | PluginTab 内嵌 | 无法增删 MCP 服务器 |

### 3. MCP 管理架构发现

```
MCP 服务器有两种来源:
  1. 插件管理: plugin:figma:figma 等
     → claude mcp get/remove 无法操作
     → 只能通过插件启用/禁用控制

  2. 用户手动: chrome-devtools 等
     → claude mcp add/remove/get 完整操作
     → 可独立管理

UI 必须区分这两种来源！
```

---

## 实施路线

| Phase | 工时 | 核心交付物 |
|-------|------|-----------|
| **Phase 0: 紧急修复** | 0.5天 | 修正 PRESET_AGENTS、增加 max effort |
| **Phase 1: 核心动态化** | 2-3天 | cli_info 后端 + cliInfoStore + 动态 Agent/Model + 认证状态 |
| **Phase 2: MCP 管理** | 3-4天 | MCP 独立管理 Tab + 两种来源区分 |
| **Phase 3: 高级功能** | 2-3天 | 工具权限面板 + 预算控制 + AI 规则审查 |

**总计**: 8-11 个工作日

---

## 技术架构

### 数据流

```
启动时:
  claude agents → Rust 后端 → cliInfoStore → SessionConfigSelector (动态)
  claude auth status → Rust 后端 → cliInfoStore → AIEngineTab (认证状态)

首次消息时:
  stream-json init → Rust 后端 (emit) → cliInfoStore (补充 tools/mcp/skills)

手动刷新:
  重新执行启动命令
```

### 新增后端接口

```rust
// Phase 0: 无需新增
// Phase 1: cli_info.rs
get_cli_agents(cli_path) → Vec<CLIAgent>
get_cli_auth_status(cli_path) → AuthStatus
get_cli_version(cli_path) → String

// Phase 2: mcp.rs
list_mcp_servers(cli_path) → Vec<McpServer>
get_mcp_server(cli_path, name) → McpServerDetail
add_mcp_server(cli_path, config) → ()
remove_mcp_server(cli_path, name, scope) → ()
```

### 新增前端文件

| 文件 | Phase | 说明 |
|------|-------|------|
| `src/stores/cliInfoStore.ts` | 1 | CLI 动态数据 Store |
| `src-tauri/src/commands/cli_info.rs` | 1 | CLI 信息查询后端 |
| `src/components/Settings/AuthStatusBadge.tsx` | 1 | 认证状态组件 |
| `src/components/Settings/tabs/MCPTab.tsx` | 2 | MCP 管理 Tab |
| `src/components/Settings/MCP/AddMCPServerModal.tsx` | 2 | 添加 MCP 弹窗 |
| `src/components/Settings/MCP/MCPServerCard.tsx` | 2 | MCP 服务器卡片 |
| `src/stores/mcpStore.ts` | 2 | MCP 状态管理 |
| `src/types/mcp.ts` | 2 | MCP 类型定义 |
| `src/components/Settings/ToolPermissionPanel.tsx` | 3 | 工具权限面板 |
| `src/components/Settings/BudgetControl.tsx` | 3 | 预算控制组件 |

---

## 注意事项

1. **CLI 文本输出格式不稳定**: `claude agents` 和 `claude mcp list` 是文本输出，需容错解析
2. **Agent ID 命名空间**: 内置用简名 (`Explore`)，插件用 `plugin:agent` 格式
3. **插件 MCP 不可通过 mcp 命令管理**: `claude mcp get plugin:figma:figma` 返回 "not found"
4. **MCP 健康检查耗时**: `claude mcp list` 会触发健康检查，可能需要 3-5 秒
5. **MCP 认证需浏览器**: HTTP 类型 MCP 的 OAuth 认证需要打开系统浏览器
6. **stream-json 需 --verbose**: `--output-format stream-json` 不加 `--verbose` 会报错
7. **init 事件无需额外成本**: 是 stream-json 的副产品，不增加 API 调用
