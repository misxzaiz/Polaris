# 精简优化方案 + 插件优先定案（2026-10-30）

> 用户定案：**后续新功能一律默认以插件开发**（走 cap 总线 / MCP，落 `Polaris-plugin` 仓），主仓核心只做缺陷修复、安全与性能治理。已同步写入 `AGENTS.md` §五「功能路由原则」。
> 本文档是全仓三路体检（前端 / Rust / 工程化，2026-10-29）之后**精简**下来的路线，取代逐项铺开的大计划。

## 原则

1. **核心冻结**：不改行为、不添功能；只修 bug / 安全 / 性能 / 门槛。
2. **新功能 = 插件**：插件侧有缺口先补 cap 契约（三处同步：router/ + 前端 service + 插件仓），再在插件仓实现。
3. **克制**：巨型文件不运动式拆分；clippy 存量不清零；session-v2 与 conversationStore 的双层结构是设计（日志即真相）而非重复。

## P0 防线修复（2026-10-30 已执行）

- [x] `lib.rs` 命令注册表：`provider_diagnostics::*` 6 命令重复注册去重；16 行堆叠 `#[cfg(feature = "lsp-index")]` 残留清除（该残留曾把模型 Profile 两命令误挂在 lsp-index 门控下；命令定义处本无此门控）。
- [x] `ci.yml`：新增 `rust-gate` job（web-only `--no-default-features` 检查为**阻塞**项；clippy `-D warnings -A dead_code` 为 advisory，存量 warning 清零后转阻塞）；`security:audit` 移除 `continue-on-error`；触发分支去除 `master` 残引（§〇 禁 master）。
- [x] 死配置清理：vite `lodash` 死分包规则（项目无 lodash/cva 依赖）；`tailwindcss`/`postcss`/`autoprefixer` 移入 devDependencies。
- [x] 核实并**保留**（探查误报修正）：`multi-instance` feature 非死物——`scripts/build-win.mjs` Windows 构建在用；插件仓 `origin/main..HEAD` 为 0，publish 脚本已随发随推，无积压。

## P1 精简保留项（按序，动前各补短 spec）

1. **router 咽喉 unwrap 治理**：`services/router/mod.rs`(32)、`web/api/ipc.rs`(36)、`services/session_state.rs`(22) 三文件换语义化错误——RouterBus 是全部插件流量的咽喉，此处 panic 即全线崩溃。其余 ~250 处生产 unwrap 维持现状。
2. **fs 读路径双轨合一**：`fs_capability.rs` 三动作 vs `commands/file_explorer.rs` / `file_io.rs`，按 `dataRootService.ts` 样板迁一个砍一个。
3. **git 域协议 camelCase 补齐**：`models/git.rs` ~24 类型 snake_case 直出前端（scheduler/plugin/todo/config 另约 8 个）；先盘点前端实际消费字段，再一域一域统一 `rename_all`。**排在 marketplace-mobile-fix 验收完成之后**（同触 git/移动端链路）。

## 缓办（按需触发，不主动排期）

- 测试补缺：触碰 `scheduler_daemon` / `terminalStore` / `schedulerStore` / `dynamic_capability.rs` 时顺带补，不专项铺开。
- `plans/` 归档：已实施文档移 `plans/archive/`，保持 spec-first 流程载体可导航。
- 插件仓 workspaces + 公共测试 harness：插件数量继续上涨后再做。
- CI clippy advisory → 阻塞：存量 warning 清理后移除 `continue-on-error`。
- CI 增加 `cargo test`（Linux runner 可行性待验证；本机 `cargo test --lib` 不可用）。
- 本地测试假失败：`fileService.test.ts` 直连 localhost:3000 产生 33 个 unhandled ECONNREFUSED（Windows 本地无监听；CI Test job 实证通过），触碰该测试文件时顺手 mock。

## 明确不做

- 大规模拆巨型文件（createConversationStore 2986 行等 4 个 2000 行级文件仅触碰时局部收敛）。
- clippy 全量清零（按 AGENTS.md §八三阶段策略走）。
- session-v2 / conversationStore 双层重写。
- hooks 层运动式改写（142 组件直连 store 维持现状，只立增量纪律：渲染路径用 hook、禁止 import store 内部初始化器）。
