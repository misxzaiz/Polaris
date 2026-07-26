# Personal Hub MCP Server 实现

> 日期: 2026-07-26
> 分支: `feat/agent-self-service`（未提交的工作）

## 概述

为 Personal Hub（个人空间）构建了一个**独立伴生 MCP server**（`polaris-ph-mcp`），让 AI agent 能够通过 MCP 工具直接对 Personal Hub 的书签、TODO、笔记、导航条目做 CRUD 操作，而无需通过 Polaris 主进程。

## 架构

```
┌─────────────────┐     MCP stdio JSON-RPC     ┌──────────────────────┐     Supabase REST API     ┌─────────────────┐
│  AI Agent       │ ◄────────────────────────► │  polaris-ph-mcp      │ ◄─────────────────────────► │   Supabase DB    │
│  (SimpleAI/CLI) │    via MCP Config Dir      │  (伴生进程)           │    Bearer token 认证         │   (links 表)     │
└─────────────────┘                            └──────────────────────┘                             └─────────────────┘
```

- `polaris-ph-mcp` 是一个**独立 `[[bin]]`**，通过 stdio 走 MCP JSON-RPC 2.0（协议版本 `2024-11-05`），与现有 browser/agnes/computer MCP 架构完全同构。
- 每次 tool 调用**重新加载 config**（`PhClient::from_config()`），因此前端对 config 的修改即时生效，无需重启 server。
- 认证：从 `config.json` 的 `personal_hub.sessionToken` 读取 Supabase access_token，以 `Authorization: Bearer <token>` 附加到 Supabase REST 请求。

## 文件变更清单

### 新增文件

| 文件 | 作用 |
|------|------|
| `src-tauri/src/bin/polaris_ph_mcp.rs` | 入口点，解析 `<config_dir> [workspace_path]` 参数并调用 `run_ph_mcp_server()` |
| `src-tauri/src/services/personal_hub_mcp_server.rs` | MCP server 核心：JSON-RPC loop、5 个工具、Supabase 客户端、CRUD 实现、单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src-tauri/Cargo.toml` | 新增 `[[bin]] polaris-ph-mcp`；新增 `cipher` crate feature（`block-padding`） |
| `src-tauri/src/services/mcp_config_service.rs` | 注册 `polaris.personal-hub` 插件 MCP server（builtin） |
| `src-tauri/src/services/personal_hub_crypto.rs` | 重构：引入 `cipher::block_padding::Pkcs7` 内置填充（替代手写 padding/unpadding），代码从 268 行压缩到 ~141 行 |
| `src-tauri/src/web/api/ipc.rs` | `get_config`/`health_check` 改用 `serde_json::to_value` 显式序列化（修复 APK 桥接序列化报错） |
| `src/services/tauri/configService.ts` | 新增 `setPersonalHubSession(token)` / `hasPersonalHubSession()` |
| `src/stores/personalHubAuthStore.ts` | 登录/恢复 session/状态变更时同步 token 到后端；登出时清除 |
| `src/types/config.ts` | `PersonalHubConfig` 新增 `sessionToken?: string` 字段 |

## MCP 工具列表（5 个）

| 工具 | 描述 | 关键参数 |
|------|------|----------|
| `ph_list` | 列出条目 | `type`/`status`/`tags`/`limit`/`sortBy`/`sortOrder` 过滤 |
| `ph_create` | 创建条目 | `title`+`type` 必填；`url`/`description`/`tags`/`priority`/`dueDate`/`completed` 可选 |
| `ph_get` | 查看单条 | `id` (UUID) |
| `ph_update` | 更新条目 | `id` 必填，其余字段按需更新 |
| `ph_delete` | 删除条目 | `id` (UUID) |

### Supabase 过滤器构建（`build_filters`）

- `type` → `type=eq.{value}`
- `status: "completed"` → `completed=eq.true`；`"pending"` → `or=(completed.is.null,completed.eq.false)`
- `tags: "rust,node"` → `tags=cs.{"rust"}` + `tags=cs.{"node"}`（JSON array contains）

### 加密 description

- `ph_get` 返回时若 `is_encrypted=true`，用 `personal_hub_crypto::decrypt_description()` 解密后展示
- 加密由前端负责，MCP server 只负责解密展示

## 认证链路

```
用户在设置页登录 Personal Hub
        │
        ▼
personalHubAuthStore.signIn() / 恢复 session
        │
        ▼
syncAuthToken() → setPersonalHubSession(access_token)
        │  invoke('set_personal_hub_session')
        ▼
config.json.personal_hub.sessionToken = "<token>"
        │
        ▼
polaris-ph-mcp 每次调用 reload config → Bearer token → Supabase REST
```

登出时调用 `clearAuthToken()` 将 token 置空。

## 设计决策

1. **每次调用 reload config 而非单例 client** — 前端登录后 token 写入 config 即时生效，无需重启 MCP 进程。代价是每次请求多一次文件读取（可接受，< 1ms）。

2. **与 browser/agnes/computer MCP 架构同构** — 独立 bin、`mcp_config_service.rs` 注册、`ConfigDirAndWorkspace` 参数模式、`run_*_mcp_server` 入口函数，后续维护模式一致。

3. **`personal_hub_crypto.rs` 重构用内置 padding** — 原来手写 PKCS7 pad/unpad + 字节一致性校验，改为 `aes::cipher::block_padding::Pkcs7`。安全性不变（AES-128-CBC + MD5 EVP），代码量减半，填充边界 case 由 crate 处理。

4. **IPC `get_config`/`health_check` 显式序列化** — 原来是 `json_result!` 宏（`serde_json::json!` 包装），APK/Web 端 `get_config` 返回的 Config 结构体某些字段序列化行为不一致导致连接报错。改为 `serde_json::to_value()` 直接序列化成 Value 后包装 Json 响应。

## 单元测试（10 个，全部通过）

- `initialize_returns_protocol_metadata` — 协议元数据正确
- `tools_list_contains_expected_tools` — 5 个工具齐全
- `create_requires_title_and_type` / `get_requires_id` / `delete_requires_id` — 参数校验
- `unknown_tool_returns_error` — 未知工具拒绝
- `notification_is_detected_when_id_field_is_absent` — JSON-RPC notification 不回复
- `build_filters_handles_all_types` / `build_filters_pending_status` — 过滤器构建
- `load_ph_config_uses_defaults_on_missing_file` — 缺失 config 不 panic

## 待办

- [ ] `try_refresh()` 目前未实现（`PersonalHubConfig` 未存储 `refresh_token`）— token 过期后 MCP 工具会返回 Supabase 401
- [ ] `encryption_key` 为空时 `ph_get` 解密 description 会返回占位符（与前端行为一致）— 已处理
- [ ] 后续可考虑 token 自动刷新机制（存储 refresh_token + 定时刷新）
