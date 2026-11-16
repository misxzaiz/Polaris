# K-R5：commands/ 旧层清退 spec（薄壳指向 RouterBus 后删除）

日期：2026-11-16 ｜ 波次：K-R5（host-kernel-roadmap.md） ｜ 目标：commands/ 6,488 行 → ~1k

## 现状盘点（2026-11-16 实测）

- `commands/` 30 文件 6,488 行、104 个 `#[tauri::command]`；lib.rs 注册 148 个 handler。
- 三条消费通道并存：① 桌面 tauri invoke（generate_handler）② Web `/api/ipc` 分发（ipc.rs 121 个分支，1924 行）③ cap 总线（router/ 34 文件 18,427 行）。
- 前端直调 79 个命令名，其中 65 个 web ipc 已覆盖；14 个仅桌面（多为窗口/服务器管理，属保留核）。

## 清退原则（对齐 AGENTS.md §3.2）

1. **实现体下沉 services/ 或 capability inner，commands/ 只留薄壳或删除**。
2. 前端已走 `router_dispatch` 的域（config/data_root/app.update/autolaunch/history/session/fs 大部）不再保留桌面 invoke 旧命令；web ipc 分支同步删。
3. 无消费者命令直接删（附证据）。
4. 每删一批跑：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + 前端 `tsc --noEmit` + vitest。

## 分批清单（按风险从低到高）

### 批 A：纯删除（无前端/无 cap 消费，证据已核）
- `detect_claude`（lib.rs:505）——前端 0 消费（启动风暴记忆已修），web ipc 有分支但无调用方。删命令+web 分支。
- `find_claude_paths` / `validate_claude_path`——前端 0 消费。同上。
- `get_cli_info`——后端已无实现，仅 main.tsx 白名单残留字符串。删白名单项。
- `history_index.rs`（33 行 3 命令）——cap.history 已有 query/search/mark（history_capability.rs:222/239/251），前端 0 直调。删文件+注册。
- `workspace.rs` 的 `get_home_dir/validate_workspace_path/get_directory_info`——前端仅 CreateWorkspaceModal（get_home_dir+read_directory）与 fileService（validate/get_directory_info）。**先迁 cap.fs 动作**（批 B）再删。

### 批 B：cap.fs 补动作后删桌面旧命令
- cap.fs 增动作：`getHomeDir`、`validateWorkspacePath`、`getDirectoryInfo`、`readCommands`、`watchStart/watchStop/watchStatus`（fs_watch 三兄弟，web ipc 现为 no-op/占位）。
- 前端消费方改走 `router_dispatch cap.fs`：fileService.ts（validate/get_directory_info/read_directory/get_file_content/create_file/... 全部 19 个直调命令）、commandStore.ts（read_commands）、CreateWorkspaceModal（get_home_dir/read_directory）。
- 删桌面 invoke：file_explorer.rs 19 命令、file_watcher.rs 3 命令、workspace.rs 3 命令；lib.rs 对应 use+注册；web ipc 对应分支（read_directory 等已有 cap.fs 的，web 走 ipc 分支的要保留到 web 端切 cap 为止——web 端 fetch 也走 /api/ipc，需要同步切 router_dispatch）。
- file_explorer.rs 的纯函数（read_directory_inner/complete_file_info/search 系）**下沉 `services/fs_store.rs`**（新），fs_capability 与 web ipc 都改调 services 层。

### 批 C：dialog_storage 域
- 8 命令已有 `_inner` 纯函数；cap.history 增 dialog 动作（write/read/list/list_meta/append/read_page/delete/consolidate 直通 inner）。
- 前端 dialogBackend.ts 8 个 invoke 改 `router_dispatch cap.history`。
- 删 dialog_storage.rs 的 8 个 `#[tauri::command]` 薄壳（保留 `_inner`，turn_persist/history_capability/ipc.rs 在用）；web ipc 8 分支改调 cap 或保留（web 也应走总线——ipc.rs 的 dialog 分支改为内部调 cap.history handler）。

### 批 D：session_state/session_messages
- 19+8 命令：前端 0 直调（P6 后）；消费方=lib.rs 注册、ipc.rs 19 分支、ai_chat_core/ai_chat_capability/history_capability 内部调用 inner。
- 动作：`#[tauri::command]` 全删（inner 保留）；lib.rs 注册删；ipc.rs 19 分支改为调 inner（web 端仍需这些语义）；cap.session 已覆盖读面，写面在 cap.ai.chat——不动 cap。

### 批 E：小域收口
- `mcp_manager.rs`（7 命令）：cap.mcp 增 `health`/`health_one`/`list_servers`/`get_server`/`add`/`remove`/`start_auth` 动作；前端 mcpHealthService 改走总线；删 7 命令+ipc 3 分支。
- `usage.rs`（5 命令）：新增 `cap.usage` 或并入 cap.history（用量属审计域）——**并入 cap.history**（action: usage_summary/usage_model_stats/usage_engine_stats/usage_daily_trends/usage_recent_logs）；前端 tokenAnalyticsStore 改总线；删 5 命令+ipc 5 分支。
- `agent_corpus.rs`（7 命令）：新增 `cap.agents`（rosters/list/save/delete/user_roster_save/user_roster_delete/simple_ai_list_agents）；前端 agentCorpusService 改总线；删 7 命令+ipc 分支。
- `cli_info.rs`（6 命令）：新增 `cap.cli`（version/version_for/agents/auth_status/check_installed/find_paths）；前端 cliInfoStore 改总线；删 6 命令+ipc 5 分支。
- `engine_metadata.rs`（1）/`model_profile.rs`（2）：并入 `cap.cli` 同批（metadata_list/test_connection/fetch_models）；main.tsx 白名单同步。
- `plugin_state.rs`（2）/`plugin_config.rs`（2）→ 并入 cap.plugin（已有 cap.pluginDiscovery/pluginServiceManager；plugin_state 有独立 capability 文件——核对后并入）。
- `claude_settings.rs`（4 命令）→ `cap.cli` 或独立 `cap.claude_settings`；前端 claudeSettingsService 改总线。
- `engine_install.rs`（3 命令）→ `cap.engines`（install/uninstall/detect_version）；前端 EngineInstallActions 改总线。
- `plugin_engine.rs`（3 命令 register/unregister/list）→ `cap.engines` 同批。
- `nexus.rs`（4 命令）→ 前端仅 chatCommandRouter 直调 nexus_start_roster；并入 `cap.ai` 或新 `cap.nexus`。
- `provider_diagnostics.rs`（6 命令）→ 前端 0 直调；查 web ipc；无消费直接删。
- `mobile_config.rs`（get/set_server_config）→ transport/auth 与 index 在用（远程连接配置）。**保留**（属 transport/鉴权核）或并入 cap.config——并入 cap.config（action: server_config.get/set），前端 transport 改总线。
- `data_root_cmd.rs`（open_path_in_explorer）→ 并入 cap.data_root（action: open_path）；前端 0 直调？核对后删或留。

### 批 F：终态
- `commands/` 仅剩：`mod.rs`（re-export 精简）、`router.rs`（router_dispatch/list_caps/audit——总线入口本身）、`terminal.rs`（PTY 核心，cap.terminal 在用）、`file_io.rs`（3 个无域归属工具）、`dispatch.rs`（2 命令，查消费后决定）、`session_messages.rs`/`session_state_commands.rs`（inner 实现，若批 D 选择"inner 留在原处"）。
- 预期 ~1k 行。

## 验收
- [ ] `cargo check` / `cargo clippy --lib` 无新增 warning
- [ ] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 过
- [ ] 前端 `tsc --noEmit` + vitest 全绿
- [ ] `commands/` 总行数 ≤ 1,200
- [ ] 真机 9827：文件树、对话、设置、插件管理冒烟

## 风险
- web ipc.rs 与桌面 invoke 是两套入口，删桌面命令时 web 分支若仍有调用方会 404——每批同步核对 `/api/ipc` 分支与前端 httpTransport。
- main.tsx `HOST_INVOKE_ALLOWLIST` 是插件桥白名单，删命令须同步删白名单项。
- session_state/messages 的 inner 是热路径（ai_chat_core 事件回调），只删命令壳不动实现。
