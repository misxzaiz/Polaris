# 启动/审计/楔死根治 — 实施复核与加固 spec

> 2026-10-31 复核。对照 `audit-startup-firsttoken-root-cure-spec.md` P0 实施逐项核查，
> 发现 4 处可加固点（非新回归，均为实施精度/副作用）。本文件记录加固方案与验收。

## 复核结论

| # | 项 | 复核结论 | 处置 |
|---|---|---|---|
| 1 | SimpleAI MCP 15s 超时是否泄漏子进程 | **撤销**：`McpClient::Drop`→`shutdown_sync`→`StdioTransport::kill_sync`→`child.start_kill()`，超时路径上 `client` 已构造（同步 struct，无 await 点在 Drop 前），future 取消触发 drop 链杀进程。不泄漏。 | 不修 |
| 2 | A2 多实例交错写断链未根治 | 确认：仍单文件 `dispatch.jsonl`，spec P1-1 范围（分段分实例），本次未涉及。归档竞态日志不可观测（rename 失败与未超限同返 None）。 | 加固归档日志；分段留 P1-1 |
| 3 | BOOT_GRACE 起算点 | 确认：`booted_at = Instant::now()` 在 `PluginServiceManager::new()`，位于 `create_app_state` 内——早于窗口创建/插件 discover 10-15s。spec §D.2 要求"从宿主 setup 完成起算"。 | 修：改 `OnceLock<Instant>`，setup 末尾 `mark_setup_done()` |
| 4 | launcher 每条消息读盘 config.json | 确认：`prepare_mcp_config` 在 `ai_chat_core` 两处 + `manager` 一处调用，每次 `load_session_mcp_whitelist` 同步 `read_to_string`+`serde_json::from_str`。ClaudeCode stream-json 单发模式每条消息调一次。 | 修：mtime 守卫的进程级缓存 |
| 5 | sqlite/audit 慢观测 warn 无节流 | 确认：`with_conn` 每次调用≥1s 落 warn；kv 60 条/秒若卡在 1s+ → 每秒 60 条 warn，反向制造日志洪水。 | 修：域级时间窗去重（每域每 10s 最多 1 条） |
| 6 | dispatch watchdog 快路径 spawn 10s sleep task | 确认：每次 dispatch spawn 一个睡 10s 的 task，正常快路径仍睡满 10s 才退出。cap.kv 60 条/秒 = 600 睡着的 task。 | 修：`select!` 包 dispatch+sleep，快路径立即取消 |
| 7 | `FileAuditSink::count()` 语义变更 | 降级：唯一生产侧消费者是 `state.rs` 启动日志（打印一次）；前端审计查看器走 `tail_lines` 独立路径。 | 补文档注释（已补） |

## 加固方案

### H-1 BOOT_GRACE 起算点修正（问题 3）

`PluginServiceManager`：
- `booted_at: Instant` → `setup_done_at: OnceLock<Instant>`（None = 未标记，宽限从 `Instant::now()` 兜底）
- 新增 `pub fn mark_setup_done(&self)`：lib.rs setup 闭包末尾调用
- `boot_grace_remaining()`：`setup_done_at.get()` 为准，未标记时回退 `booted_at`（防御：setup 异常未标记也不丢失宽限）

lib.rs `.setup(|app| { ...; state.mark_setup_done(); Ok(()) })`。

### H-2 launcher 白名单 mtime 缓存（问题 4）

`load_session_mcp_whitelist` 加进程级 `OnceLock<Mutex<Option<(SystemTime, Vec<String>)>>>`：
- 命中条件：config.json `modified()` 未变 → 直接返回缓存
- 未命中/变了 → 重读重解析、刷新缓存
- 每条消息只 `metadata()`（微秒级 stat），不读不解析

### H-3 慢观测 warn 域级去重（问题 5）

sqlite `with_conn` + audit `append`：域级 `Mutex<HashMap<String, Instant>>`，每域 10s 窗口内最多 1 条 warn。窗口内重复只在 debug 落计数，不 warn。

### H-4 dispatch watchdog select! 化（问题 6）

`commands/router.rs` + `web/api/ipc.rs`：watchdog task 改 `select!`——dispatch 完成的通知分支立即返回，sleep 分支才报警。快路径零沉睡 task。

### H-5 归档日志可观测（问题 2 局部）

`archive_oversized_legacy` 返回 `enum ArchiveOutcome { Archived(PathBuf), NotOversized, RenameFailed }`，调用方按变体落不同日志。

## 验收

- H-1：`mark_setup_done` 后 `boot_grace_remaining()` 起算点 = 调用时刻（单测：构造后立即 mark，剩余 ≈ BOOT_GRACE）
- H-2：缓存命中时 `read_to_string` 调用 0 次（单测：两次调用间不改 config.json，第二次 metadata 命中）
- H-3：连续 100 次 1.5s 慢操作只 1 条 warn（单测：模拟慢操作，断言 warn 计数）
- H-4：快路径 dispatch 无睡着 task（逻辑保证：select! 完成 dispatch 即返回）
- H-5：归档三种状态日志可区分

本地验证门：`cargo check` + `cargo clippy --lib`（无新增 warning）+ 新增单测实际执行。
