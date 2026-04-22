# 模块：MCP 服务管理

> ID: mcp | 复杂度: 中 | 变更频率: 中
> 依赖: ipc-bridge, config-settings | 被依赖: Claude Code 会话, 前端 MCP 管理面板

## 概述

两层 MCP 管理架构：**配置生成层**（mcp_config_service.rs）负责解析内置 MCP 二进制路径并生成工作区配置文件；**运行时管理层**（mcp_manager_service.rs）通过 Claude CLI 桥接读取多源配置并执行健康检查。前端通过聚合视图呈现所有 MCP 服务器的配置来源与连接状态，支持增删改查和 OAuth 认证。

## 核心组件

### 后端 — 配置生成层

| 组件 | 文件 | 职责 |
|------|------|------|
| WorkspaceMcpConfigService | `src-tauri/src/services/mcp_config_service.rs` | 工作区 MCP 配置生成：解析二进制路径、写入 `.polaris/claude/mcp.json` |
| resolve_mcp_executable_path | 同上 | 三级路径回退：bundle → env var → dev/release |
| write_json_atomically | 同上 | 原子写入：先写 `.json.tmp` 再 rename |

### 后端 — 运行时管理层

| 组件 | 文件 | 职责 |
|------|------|------|
| McpManagerService | `src-tauri/src/services/mcp_manager_service.rs` | 聚合配置读取 + CLI 健康检查，无状态服务 |
| mcp_manager (commands) | `src-tauri/src/commands/mcp_manager.rs` | 7 个 Tauri IPC 命令薄包装 |
| McpTransport / McpScope / McpServerInfo / McpHealthStatus / McpServerAggregate | `mcp_manager_service.rs` | 类型定义（serde camelCase） |

### 前端

| 组件 | 文件 | 职责 |
|------|------|------|
| McpStore | `src/stores/mcpStore.ts` | Zustand 状态：服务器列表、健康检查、操作状态 |
| mcpService | `src/services/mcpService.ts` | 7 个 invoke 薄封装 |
| McpPanel | `src/components/Mcp/McpPanel.tsx` | 主面板容器：筛选栏 + 卡片列表 + 状态栏 |
| McpServerCard / McpServerDetail | `src/components/Mcp/` | 服务器卡片与展开详情 |
| McpAddServerDialog | `src/components/Mcp/McpAddServerDialog.tsx` | 添加服务器对话框 |
| McpTopologyDiagram | `src/components/Mcp/McpTopologyDiagram.tsx` | Mermaid 拓扑图（动态 graph TD） |
| useMcpHealthPolling | `src/components/Mcp/hooks/useMcpHealthPolling.ts` | 30s 轮询 Hook |
| McpTypes | `src/types/mcp.ts` | 前端类型定义（与 Rust 对齐） |

## 架构模式

### 1. 双层管理架构

配置生成层和运行时管理层完全解耦。前者只关心二进制路径解析和 JSON 写入，后者只关心配置读取和 CLI 调用。两者通过文件系统（`.polaris/claude/mcp.json`）间接通信。

```
App 启动
  ↓
WorkspaceMcpConfigService.prepare_workspace_config()
  → 解析 4 个内置 MCP 二进制路径
  → 写入 .polaris/claude/mcp.json
  ↓
Claude Code 读取 mcp.json 启动 MCP Server 进程
  ↓
McpManagerService.list_servers()
  → 读取 4 个配置源（不依赖 mcp.json）
  → 调用 claude mcp list 获取运行时状态
  → 聚合返回
```

### 2. 三级二进制路径回退

每个内置 MCP Server 按以下顺序查找可执行文件：
1. **Bundle 路径**: `{resource_dir}/bin/{name}{EXE_SUFFIX}` 或 `{resource_dir}/{name}{EXE_SUFFIX}`
2. **环境变量覆盖**: `POLARIS_{NAME}_MCP_PATH`
3. **开发路径**: `{app_root}/src-tauri/target/debug/{name}{EXE_SUFFIX}` → `release/` 回退

todo MCP 是必选的（解析失败返回错误），requirements/scheduler/knowledge 是可选的（解析失败跳过并 warn）。

### 3. 四源配置聚合

`list_config_paths()` 读取 4 个配置源，同一服务器可能出现在多个源中：

| 源 | 路径 | McpScope |
|---|---|---|
| 全局 | `~/.claude/settings.json` | Global |
| 项目 | `<workspace>/.mcp.json` | Project |
| 用户 | `<workspace>/.claude/settings.json` | User |
| 本地 | `<workspace>/.claude/settings.local.json` | User |

聚合时按服务器名称分组，`McpServerAggregate.configs` 数组可包含来自不同作用域的多个配置条目。

### 4. CLI 桥接模式

所有运行时操作（健康检查、添加、删除、认证）都通过调用 `claude mcp` 子命令实现，而非直接与 MCP Server 通信。优点是复用 Claude CLI 的 MCP 管理逻辑，缺点是依赖 CLI 已安装且输出格式稳定。

### 5. 原子 JSON 写入

`write_json_atomically` 先写入 `.json.tmp` 临时文件，成功后 `rename` 覆盖原文件。确保并发读取不会看到半写入的 JSON。

### 6. 文本解析状态推断

前端通过 `inferStatus()` 从 `health.status` 文本推断连接状态（`connected` / `needsAuth` / `disconnected`），匹配关键词 `auth` / `认证` / `authenticate`。后端 `parse_mcp_list_output` 解析 `✓` / `!` / `✗` 前缀标识。

## 数据流

### 配置生成流

```
App 启动 → WorkspaceMcpConfigService::from_app_paths()
  → resolve_mcp_executable_path() × 4 (todo 必选, 其余可选)
  → 构造 Vec<ResolvedMcpBinary>

打开工作区 → prepare_workspace_config(workspace_path)
  → 创建 .polaris/claude/ 目录
  → 校验所有 binary.executable_path.exists()
  → 构建 BTreeMap<String, ClaudeMcpServerConfig>
  → write_json_atomically → .polaris/claude/mcp.json
```

### 健康检查流

```
McpPanel 渲染 → useMcpHealthPolling (30s 间隔)
  → McpStore.healthCheck()
  → invoke('mcp_health_check')
  → McpManagerService::new(claude_path).health_check()
  → execute_claude(["mcp", "list"])
  → parse_mcp_list_output() — 逐行解析 ✓/!/✗ 前缀
  → 合并到 servers[].health
  → UI 根据 inferStatus() 着色
```

### 添加服务器流

```
McpAddServerDialog 提交 → McpStore.addServer()
  → invoke('mcp_add_server')
  → McpManagerService.add_server()
  → execute_claude(["mcp", "add", "--transport", ..., name, command, "--", ...args])
  → refreshAll() 重新加载
  → storeEventBus.emit('TOAST_REQUESTED')
```

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 健康检查方式 | CLI 桥接 (`claude mcp list`) | 复用 CLI 已有的连接管理逻辑，避免重复实现 MCP 协议握手 |
| 配置写入路径 | `.polaris/claude/mcp.json` (工作区内) | Claude Code 的工作区配置约定，每个工作区独立 |
| 二进制路径解析 | 三级回退 + 环境变量覆盖 | 适配 bundle/release/dev 三种部署环境 |
| 内置服务器命名 | 固定前缀 `polaris-` | 防止与用户自定义服务器名称冲突 |
| JSON 写入方式 | 原子写入 (tmp + rename) | 避免并发读取看到半写入状态 |
| 配置聚合源 | 4 个文件源合并 | 覆盖 Claude CLI 的所有配置位置，提供完整视图 |
| 输出排序 | BTreeMap (字母序) | 确保配置文件内容确定性，减少不必要的 git diff |
| 状态推断 | 文本关键词匹配 | 后端 CLI 输出非结构化，前端用模式匹配提取语义 |

## 已知陷阱

1. **配置生成 ≠ 配置读取**: `mcp_config_service` 只写 `.polaris/claude/mcp.json`，但 `mcp_manager_service` 从 4 个不同源读取配置（包含 `~/.claude/settings.json` 和 `.mcp.json`），两边管理的配置范围不完全重叠

2. **McpManagerService 无状态**: 每次 IPC 命令都 `McpManagerService::new(claude_path)` 创建新实例，`list_servers` 每次调用执行 `claude mcp list` CLI 子进程，无缓存

3. **CLI 输出格式脆弱**: `parse_mcp_list_output` 和 `parse_mcp_get_output` 依赖 Claude CLI 的输出格式（`✓`/`!`/`✗` 前缀、`" - "` 分隔符），CLI 版本升级可能导致解析失败

4. **健康检查性能**: `list_servers()` 同时调用 `list_configs`（读 4 个文件）+ `health_check`（执行 CLI 子进程），每次刷新至少 1 次 CLI 调用

5. **可选二进制静默跳过**: requirements/scheduler/knowledge MCP 二进制不存在时仅 `tracing::warn`，不报错。用户可能不知道某些功能不可用

6. **scope 字符串不匹配**: `add_server` 中 scope 参数与 `McpScope` 枚举不一致（CLI 用 `"local"` 但枚举是 `User`/`Project`/`Global`），传递时需注意映射

7. **operatingServer 防并发不完整**: `operatingServer` 阻止同一服务器并发操作，但组件卸载时不重置，如果操作中途面板关闭会卡住

8. **认证 URL 解析**: `handleAuth` 用正则从 `health.status` 文本中提取 URL，如果状态文本格式变化会提取不到

9. **BTreeMap 序列化键名**: Rust `BTreeMap` 通过 `#[serde(rename_all = "camelCase")]` 序列化为 `mcpServers`（不是 `mcp_servers`），与 Claude CLI 约定一致

10. **Knowledge MCP scope 扩展**: index.v2.json 中 mcp 模块的 scope 包含 `crates/polaris-knowledge-mcp/**`，但 knowledge 系统本身有独立的模块文档（ipc-bridge 不在 scope 内但被依赖）

## 最近变更

- 2026-04-20: 初始创建
- 2026-04-22: 从 C 级升级到 A 级 — 补全架构模式(6)、数据流(3)、设计决策(8)、陷阱(10)
