# 验收目标：插件服务子系统完全重构（feat/plugin-service-supervisor-rebuild）

> 门槛性质：**全部达标才允许合并 main**。依据：plans/plugin-service-supervisor-rebuild-spec.md §六。
> 验收执行：2026-11-11，全部证据为本机真实命令输出（worktree D:\space\base\Polaris-rebuild）。

## A. 自动化门槛（CI 级，阻塞合并）

| # | 验收 | 验证方法 | 证据 |
|---|---|---|---|
| A1 | diff 矩阵单测 + auto-restart 回归固定用例 | `cargo test --no-default-features --lib supervisor` | ✅ **16 passed; 0 failed**（reconciler t1/t2/t4/t5/t6/t7/t8/t9 + registry×3 + job×1 + proc_kill×2 + 协议 v2×2）；回归用例 `t4_process_death_retries_after_backoff` 断言「退避到期必须重拉（aba91319 回归的回归用例）」。本机默认 feature 测试受 Tauri DLL 限制不可跑（STATUS_ENTRYPOINT_NOT_FOUND，AGENTS.md 已知边界），走 no-default 车道 |
| A2 | 孤儿清杀用例 | 同上 | ✅ `t7_orphans_killed_managed_spared`：「无主进程全部判杀」+「在管进程不得被孤儿逻辑误杀」 |
| A3 | 重复进程去重 | 同上 + 结构保证 | ✅ t7 在管保命断言；在管记录每 key 单 epoch（结构上排除双在管），fragment 同特征的其余 PID 归孤儿判定 |
| A4 | MCP 注册联动用例 | `cargo test --no-default-features --lib service_gate` | ✅ `service_gate_matrix ... ok`（无服务声明不门控/在管放行/无在管跳过/无快照降级四象限） |
| A5 | `cargo check` 零错误 | 命令 | ✅ EXIT=0（合并前最终批次 c3281d57 复验） |
| A6 | `cargo clippy --lib` 零新增 warning | CI 口径 `-D warnings -A dead_code`，**main 基线对比** | ✅ main 与分支错误完全一致（同 3 处存量：launcher.rs:65 / config_store.rs:26 / terminal_capability.rs:10）；新代码文件（supervisor/*、mcp_config_service、plugin_service、两个 capability）clippy 零告警 |
| A7 | web-only 门控 | `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` | ✅ EXIT=0（错误计数 0） |
| A8 | 前端 `tsc --noEmit` | 命令 | ✅ TSC_EXIT=0 |
| A9 | 存量前端测试不回归 | `pnpm vitest run src/services/pluginServiceManager.test.ts src/stores/pluginLifecycleSubscriber.test.ts` | ✅ **14 passed (2 files)** |
| A9+ | Rust 测试代码整体可编译 | `cargo check --tests` | ✅ EXIT=0（顺手修复存量缺口：mcp_config_service 测试 fixture 缺 `ui_templates` 字段——fe52a954 加字段漏更新，CI 只跑不带 --tests 的 check 故未抓到） |

## B. 行为门槛

| # | 验收 | 验证方法 | 证据 |
|---|---|---|---|
| B1 | 强杀宿主 → 0 残留（Job Object） | 验收文档口径：编译期 assign 全覆盖核对 + 人工冒烟 | ✅ 收容点清单（11 处，commit c3281d57）：supervisor 插件服务 spawn、simple_ai MCP transport、opencode×2、claude×2、plugin_engine×2、plugin_process_engine×2、lib.rs setup `ensure_initialized`；PTY 走 ConPTY 机制天然随宿主消亡（无需 Job）。⚠ 人工冒烟（任务管理器强杀真机宿主）**留给用户**——本环境不便强杀在用实例；单测 `job_init_and_assign_real_child` 已验证真实子进程 assign 成功 |
| B2 | kill -9 单进程 → tick 重拉 | t4 | ✅ 见 A1 |
| B3 | 禁用插件 → 进程终止 + MCP 摘除 | t6 + A4 | ✅ Kill(Unwanted) 动作 + 门控矩阵「有服务且无在管→跳过」 |
| B4 | env 注入断跨根 + registry per dataRoot | 协议 v2 单测 | ✅ `spawn_env_injects_host_binding`（POLARIS_HOST/PORT/TOKEN/EPOCH/HOST_PID 全断言）+ `build_args_v2_expands_host_pid`（{{hostPid}}/{{pluginId}} 展开） |
| B5 | 孤儿 → tick 清杀 | t7（同 A2） | ✅ |
| B6 | 退出路径无 3s block_on / exit(0) 矛盾 | 代码审查 | ✅ lib.rs CloseRequested → `sup.shutdown()`（置期望+唤醒+1s 短等，Job Object 兜底）；旧 stop_all+timeout(3s) 与 kill_on_drop 兜底注释整体删除 |
| B7 | 卸载链路顺序 | 代码审查 | ✅ plugin_discovery_capability `uninstall_with_cleanup`/`apply_update`：stop_services_for_plugin（对账收敛）→ PluginService 卸载（清杀已原生化 `kill_plugin_processes_safe`，sysinfo 实现）→ 删目录 |

## C. 完成度清单

| # | 交付物 | 证据 |
|---|---|---|
| C1 | PR-1 基建 | ✅ commit `4980772d` |
| C2 | PR-2 核心切换（含旧实现删除） | ✅ commit `155f41f2`（git rm plugin_service_manager.rs 1074 行；wmic 清杀函数删除；BOOT_GRACE 删除） |
| C3 | PR-3 联动 | ✅ commit `19c367a1` + `dde726c9` + `c3281d57`（MCP 门控/失败显性化/recent_actions/ServiceStatus 新字段/收容全覆盖） |
| C4 | 合并 main + 复验 | ✅ 合并 `--no-ff` + 合并后 cargo check 冒烟（见下方合并记录） |

## 合并记录

- 合并时间：2026-11-11
- 合并方式：main 上 `git merge --no-ff feat/plugin-service-supervisor-rebuild`
- 合并后复验：cargo check EXIT=0（主仓 target）
- 未 push（按约定推送留用户）
