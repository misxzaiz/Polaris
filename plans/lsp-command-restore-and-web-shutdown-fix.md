# LSP 命令注册恢复 + Web IPC 桥接 & polaris-web 关闭修复

> 来源：需求库 #030（LSP 配置保存无效）、#031（polaris-web 关闭报错）。
> 2026-11-06 根因修复，claude 会话。

## 一、#030 LSP 配置保存无效

### 根因（双缺陷）

1. **桌面端命令注册丢失（2026-08-19 起）**
   - `41d7fdb5`（feature 网格改造）误把 `generate_handler!` 里 16 条
     `commands::lsp::*` 命令名替换为 16 行堆叠 `#[cfg(feature = "lsp-index")]` 属性，
     命令名全部丢失。
   - `d8ef9855`（2026-10-30 清理）把堆叠属性判为「纯残留」删除，未恢复命令名。
   - 此后桌面端 LSP 全部命令未注册，invoke 报 command not found。

2. **Web IPC 无路由**
   - `web/api/ipc.rs` 的 match 从无 `lsp_config_*` 条目，HTTP invoke 落
     `_ => NotFound`。`tauri:dev:web`（HTTP 传输）下 LSP 设置页保存/开关/删除
     全部静默失败；前端 store 乐观更新 + 刷新后拉回旧配置，表现为「保存无效」。

### 修复

- `lib.rs` generate_handler!：恢复 16 条 lsp 命令注册（配置五命令 + 进程管理四命令
  + 命令校验 + 索引七命令）。命令定义处已有 `#[cfg(feature = "tauri-app")]` 门控。
- `web/api/ipc.rs`：
  - `lsp_config_*` 五命令：**每次调用新建 `LspConfigRepository`**（现读磁盘），
    不复用 `state.lsp_config` 长驻缓存——桌面主实例与 Web clone 实例可能同时编辑
    同一 `lsp/servers.json`，长驻缓存的整表覆盖写会拿陈旧快照 clobber 对方。
  - `lsp_check_command`：同桌面实现（`which_command`，无 AppHandle 依赖）。
  - `lsp_index_*` 七命令：feature 门控 + `performance.lspIndex` 开关 + 未就绪回退
    regex_fallback，与桌面命令语义一致。
  - `lsp_start/send/stop/list_sessions`：Web 模式显式 4xx（依赖 tauri-app 事件通道）。

### 验收

- 桌面：LSP 设置页添加/开关/删除 → 刷新后仍生效；`lsp_check_command` 检测可用。
- Web（tauri:dev:web）：同上全链路；`lsp-config-upsert` HTTP 200。
- `cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。

## 二、#031 polaris-web 关闭报错

### 根因

- `bin/polaris_web.rs:20` 的 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`
  从桌面 `main.rs` 复制而来。release exe 因此为 **GUI 子系统**（PE 取证 Subsystem=GUI(2)，
  debug 为 CONSOLE(3)），不附着控制台：
  - Ctrl+C 控制台事件永远到不了 `tokio::signal::ctrl_c()`（lib.rs run_web_server）；
  - `taskkill /PID`（温和）报「只能强制终止这个进程(带 /F 选项)」——无窗口消息泵。
  - 即 release 版**没有任何优雅关闭通道**，用户「关闭报错」即此。
- 全数据根日志仅见 `Starting web server`，从无 `Received shutdown signal` 记录。

### 修复

- `bin/polaris_web.rs`：移除 `windows_subsystem = "windows"`（headless 服务器程序
  需要控制台子系统；桌面 main.rs 保留该属性语义正确）。
- `lib.rs` run_web_server：关停等待 `handle.task` 加 **10s 超时**——axum graceful
  shutdown 被 WS 长连接拖住时不再无限等待，超时后直接退出。

### 验收

- release `polaris-web.exe` PE Subsystem=CONSOLE(3)。
- 控制台运行 → Ctrl+C → 日志出现 `Received shutdown signal` + `Shutdown complete`。
- `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。
