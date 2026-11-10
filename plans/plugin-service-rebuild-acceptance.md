# 验收目标：插件服务子系统完全重构（feat/plugin-service-supervisor-rebuild）

> 门槛性质：**全部达标才允许合并 main**。依据：plans/plugin-service-supervisor-rebuild-spec.md §六。
> 每条验收在完成后追加「证据」行（命令 + 结果摘要），未验证 = 未达标。

## A. 自动化门槛（CI 级，阻塞合并）

| # | 验收 | 验证方法 | 证据 |
|---|---|---|---|
| A1 | diff 动作矩阵每行至少 1 个单测；auto-restart 回归场景（进程死后 tick 真实 re-spawn）为固定用例 | `cargo test`（supervisor 模块测试） | ☐ |
| A2 | 孤儿清杀用例：registry 无记录的 plugins/ 路径进程 → tick 判孤儿 → 清杀动作 | 同上（fake 进程表） | ☐ |
| A3 | 重复进程去重用例：同 pluginId 多 epoch → 保新杀旧 | 同上 | ☐ |
| A4 | MCP 注册联动用例：期望/实际变化 → 注册/摘除动作产出 | supervisor→MCP 门控接口单测 | ☐ |
| A5 | `cargo check` 零错误零新增 warning | 命令输出 | ☐ |
| A6 | `cargo clippy --lib` 零新增 warning（存量 dead_code 豁免口径同 CI） | 命令输出 | ☐ |
| A7 | web-only 门控：`cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过 | 命令输出 | ☐ |
| A8 | 前端 `pnpm exec tsc --noEmit` 通过（status 协议未破坏） | 命令输出 | ☐ |
| A9 | 存量前端测试不回归：`pnpm test:run` 相关套件通过 | 命令输出 | ☐ |

## B. 行为门槛（可自动化则自动化，否则标注人工验证方式）

| # | 验收 | 验证方法 | 证据 |
|---|---|---|---|
| B1 | 强杀宿主 → 0 残留（Job Object） | 自动化受限（需真机杀宿主）：编译期验证 assign 全覆盖（spawn 点清单核对）+ 人工冒烟脚本 | ☐ |
| B2 | kill -9 单服务进程 → tick 周期内重拉 | 单测（fake observer 投递退出事件 → tick 断言 spawn 动作） | ☐ |
| B3 | 禁用插件 → 进程终止 + MCP 摘除 + 快照标注 | 单测 | ☐ |
| B4 | 三数据根同启无跨根请求 | spawn env 注入断言（单测：POLARIS_HOST/PORT/TOKEN/EPOCH 存在）；跨根隔离由 registry per dataRoot 结构保证 | ☐ |
| B5 | 孤儿（registry 无记录）→ tick 清杀 | A2 | ☐ |
| B6 | 退出路径：CloseRequested 置期望+唤醒，无 3s block_on，无 exit(0) 矛盾 | 代码审查 + lib.rs diff 核对 | ☐ |
| B7 | 卸载流程：期望删除→tick 收敛→清杀兜底→删目录 | 卸载链路单测/代码审查 | ☐ |

## C. 完成度清单（交付物）

| # | 交付物 | 证据 |
|---|---|---|
| C1 | PR-1：sysinfo 依赖 + Job Object 收容模块（cfg(windows)）+ 清杀模块，现有 spawn 已接入 assign | commit + A5/A6/A7 |
| C2 | PR-2：ServiceSupervisor + Reconciler + registry + 协议 v2（{{hostPid}}+env 全家桶）；旧实现删除（plugin_service_manager 旧状态机、wmic 清杀、BOOT_GRACE） | commit + A1-A3 |
| C3 | PR-3：MCP 健康门控 + MCP spawn 失败显性化 + cap 快照（最近动作环形日志）+ 卸载接线 + ServiceStatus 新增字段（epoch/lastAction/unavailableReason） | commit + A4/A8/A9 |
| C4 | 三 PR 合并为分支完整历史，fast-forward/merge 进 main 后 A 全绿复验 | merge commit + 复验输出 | ☐ |

## 合并规则

1. A1-A9 全部有证据行（命令真实执行、结果真实粘贴/引用）。
2. B 项至少 B2/B3/B4/B5 自动化达标；B1/B6/B7 有代码级核对记录。
3. 合并动作：main 上 `git merge --no-ff feat/plugin-service-supervisor-rebuild`，合并后复跑 A5-A8 冒烟。
4. 不 push（推送留用户）。
