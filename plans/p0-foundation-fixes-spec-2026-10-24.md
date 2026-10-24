# P0 地基修复实施 spec（p0-foundation-fixes）

> 来源：`plans/plugin-cap-plugin-system-audit-2026-10-24.md` §5 第一梯队（X1/X2/X3/X4/X5）。
> 分支：`fix/plugin-cap-p0-foundation`（独立 worktree `D:\space\base\Polaris-p0`）。
> 原则：只修地基，不做功能扩展（L2/L3、skill、样式布局不在本 spec 范围）。
> 日期：2026-10-24

---

## X1 动态转发洗白 Remote deny（安全 P0）

**根因**：`DynamicCapability::invoke` 转发时无条件把 source 改写为 `Source::Plugin{caller:"dynamic:<id>"}`（`dynamic_capability.rs:122-130`）。内置 Remote deny 基线只 deny Remote，于是远程调用方可经 `cap.registry` 注册指向 `cap.bash/cap.fs/cap.http/cap.data_root/cap.plugin*` 的别名，以 Plugin 身份过 gate。

**修复**：转发 Envelope 保留**原始调用方 source**（`ctx.source().clone()`，`Context::source()` 契约已有、`RealContext` 已实现）。转发仍重入 `RouterBus.dispatch` → 目标 cap 的权限 gate 以真实 source 裁决 → Remote 调用别名转发到敏感 cap 会被拒。不变量：**转发不得提权**。

**不做**：不把 `cap.registry` 加入 Remote deny 基线（Remote 注册污染面属管理面策略，随 P2 OVERRIDE_LEVELS 分级授权统一裁决，本 spec 不改权限表）。

**验收**：新增回归测试——Remote source 经动态别名转发到被 Remote-deny 的 cap，得到「权限拒绝」错误。

## X2/X3 插件服务停止竞态 + 应用退出孤儿进程（可靠性 P0）

**根因**（`plugin_service_manager.rs`）：① watcher 启动即 `child.take()` 拿走子进程，`stop_service` 随后 `take()` 恒得 `None`，kill 分支跳过 → 停止/重启后进程不死、端口被提前释放再分配 → 僵尸占端口、双进程；② `restart` = stop(不杀)+start → 双进程；③ 主窗口关闭 `std::process::exit(0)`（`lib.rs:867`），`stop_all` 无调用方 → 孤儿进程；④ 自动重启路径每次泄漏一个已分配端口（Error/Stopped 终态从不释放）；⑤ `restart_count` 只增不减；⑥ Starting 态可被并发 start 双拉。

**修复设计**（watcher 持有者负责 kill，端口真退出后才释放）：
- `spawn_process_watcher` 改为**参数持有 child**，`tokio::select! { stop 信号 → start_kill + wait；child.wait() → 自然退出 }`（tokio `Child::wait` cancel-safe）。`ManagedService.child` 字段删除（不再做所有权交接）。
- `ManagedService` 新增 `stop_signal: Arc<Notify>`（stop→watcher）与 `finalize: watch::Sender<bool>`（watcher→stop，终态置 true；发送方存活期间无竞态）。
- `stop_service`：置 Stopping + `auto_restart_enabled=false` → `notify_one`（permit 语义，先通知后等待无丢失）→ 订阅 watch 等 finalize，上限 5s → 返回快照。不再直接 kill（不拥有 child）。
- **端口释放移入 watcher 终态收尾**（自然退出不重启 / 用户停止 / 超 maxRestarts Error 三条路径都释放），杜绝「端口已释放但进程仍占」与重启端口泄漏。
- 自动重启退避 sleep 后**复查 `auto_restart_enabled`**（停止请求落在退避窗口内时收敛为 Stopped 而不是继续拉起）。
- `restart_count`：服务稳定运行 ≥60s 后自然退出 → 清零再计；手动 start（前态 Stopped/Error）→ 重置 0；自动重启窗口（前态 Starting）→ 保留计数。
- `start_service_internal` 并发守卫从「Running 才返回」扩为「Running|Starting 都返回」。
- `lib.rs` 主窗口 CloseRequested：退出前 `tauri::async_runtime::block_on(timeout(3s, psm.stop_all()))`，超时仍退出（不阻塞用户退出；极退避窗口内的服务由 kill_on_drop + 后续 P1 治理兜底）。

**边界（不做）**：Windows Job Object（宿主崩溃场景的完全孤儿防护）、healthCheck 接状态机、Web 模式管理放行、更新停服——属 P1 生命周期治理。

## X4 审计补全（审计 P0）

**根因**：① dispatch 同步句柄 miss 后回退流式表的整段（cap.ai.chat 同步动作高频路径）零审计（`router/mod.rs:540-579`）；② 主路径 invoke 失败也落 `dispatch.ok`（`:513-522` 无条件）；③ `AuditEntry` 无资源/时长信息（答不出「cap.bash 跑了什么动作、耗时多久」）；④ 三处 `let _ = audit.append(...)` 静默吞错（磁盘满 → 审计无声断流）。

**修复**：
- `contracts::AuditEntry` 增 `detail: Option<String>`（payload 动作摘要 `action=<x>`，字符级截断 64）与 `duration_ms: Option<u64>`，`#[serde(default, skip_serializing_if=...)]` 向后兼容；全部构造点补字段（router/mod.rs ×3、prompt_snippet_capability、ui_render_capability、测试）。
- `audit_sink.rs`：`AuditRecord`/`AuditRecordCore` 同步增字段（**追加在既有五字段之后**、Option skip 序列化）——旧记录 canonical JSON 不变 → 旧链 `verify_chain` 仍通过；新记录的哈希覆盖新字段（防篡改不降级）。
- 主同步路径：action 按结果取 `dispatch.ok`/`dispatch.error`；记录 duration；回退流式表分支补同款审计；stream start 审计补 detail。
- `audit_deny` 拒绝原因编码进 action（`dispatch.deny:permission` / `dispatch.deny:prompt`，沿用本模块既有编码风格）。
- append 失败：`tracing::error!` 落日志（能力 id + 错误），**行为仍 fail-open**（dispatch 结果不因审计磁盘故障被丢弃），但不再无声。

**验收**：`verify_chain` 对「旧格式记录 + 新格式记录」混合链校验通过（新增测试）；回退分支审计有记录（测试）。

## X5 dispatch 超时护栏（可靠性 P0）

**根因**：同步 `dispatch` 无界阻塞（`spawn_blocking` 池可被占满）；流式泵任务在能力永不断流时永不广播 `dispatch.end`（`router/mod.rs:301-317`），前端 lifecycle 挂起。

**修复**（护栏不是同步 bug 的遮羞布——每个超时都有显式事件与日志）：
- 常量 `router::DISPATCH_SYNC_TIMEOUT = 900s`（> cap.bash 内建 600s 上限，只兜「永不返回」不截断合法长操作）、`router::STREAM_IDLE_TIMEOUT = 300s`。v1 常量 + 文档注释，配置化留给 P2。
- 入口（`commands/router.rs` `router_dispatch`、`web/api/ipc.rs` 同名入口）：`tokio::time::timeout` 包 spawn_blocking，超时返回显式错误（调用方解除阻塞；blocking 线程由能力自行完成或泄漏至常量上限——同步契约无法强杀，注释说明）。
- 流式泵：`recv()` 包 idle 超时；超时 → 广播 `dispatch.end{status:error, error:"stream idle timeout"}` + 审计 `dispatch.stream.timeout` → 退出泵任务（通道 drop，能力侧 send 失败自止）。
- MCP 帧（dispatch_mcp/bus_mcp）不加：AI 客户端侧已有 tools/call 180s 超时兜底，服务端双保险留 P2。

---

## 验证门槛（AGENTS.md 清单）—— 实际执行结果（2026-10-24）

- [x] `cargo check`（工作区）—— ✅ 0 error
- [x] `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` —— ✅ 0 error
- [x] `cargo clippy --lib` 无新增 warning —— ✅（改动文件中被 clippy 点名的 3 处均为存量代码：`ServiceType::from_str`、commands/router.rs 旧 `map_err` 闭包 ×2；新代码零告警）
- [x] 新增单测：X1 回归（dynamic_forward_preserves_remote_source）、审计混合链兼容（mixed_old_and_new_format_chain_verifies）—— **编译通过**（测试目标 13min 全量构建成功），**本机无法运行**：`cargo test --lib router::` 死于 `STATUS_ENTRYPOINT_NOT_FOUND`（Tauri DLL 启动限制，与 AGENTS.md 九记载一致，主仓同样受限）。测试执行留待 CI/具备环境的机器。
- [x] 前端无改动（无需 typecheck；`psm.stop_all` 为后端内部调用）
- 附注：worktree 无前端 dist，构建时以占位 `dist/index.html` 满足 tauri-build（不影响 lib 检查，未提交该占位——已在 .gitignore 覆盖范围）。

## 提交拆分 —— 实际

1. `8ff3709f fix(router): 动态能力转发保留原始调用方 Source，封堵 Remote deny 洗白`（X1）
2. `f0ae25ca fix(router): 审计补全与 dispatch 超时护栏（审计 X4/X5）`（X4+X5 合并——mod.rs 中两处改动交织于同一函数，拆分无收益）
3. `aba91319 fix(plugins): 插件服务停止竞态与退出孤儿进程修复（审计 X2/X3）`
4. `93aca7b8 docs(plans): 插件与 Cap 机制审计报告 + P0 地基修复实施 spec 归档`

> 注：实施期间 main 两度前进（AI 会话域修复，零文件冲突），分支最终变基至 `6ee1b2ef` 并复跑全部门槛（cargo check / web-only 门控均 0 error）。
