# K-R3：ask 域外迁评估与处理 spec

日期：2026-11-16 ｜ 波次：K-R3（host-kernel-roadmap.md）

## 现状盘点（2026-11-16 实测）

| 文件 | 行数 | 职能 |
|---|---|---|
| `services/ask_listener.rs` | 1,812 | 127.0.0.1 TCP listener：收 `ask` 帧 → 注册 PendingQuestion → 发 question 事件 → 等 answer oneshot → 回 `answer` 帧；含 dispatch 任务注册/continue、插件卡 outcome、表单 flow |
| `services/ask_listener_meta.rs` | 253 | 端口/token/pid 原子落盘（Bridge MCP 自愈） |
| `services/ask_mcp_server.rs` | 740 | 伴生进程 stdio MCP server（ask_user_question 工具，连 listener 的 TCP client 侧） |

合计 **2,805 行**（原估 7.4k 为 launch 参数误算）。

## 消费方（10 处，全部是 Rust 侧内部调用）

- `state.rs`：`AskAnswerEntry`/`FormAnswerEntry` 两张 oneshot 表的类型引用
- `lib.rs`：`spawn_ask_listener` 启动（2 处）
- `ai_chat_core/ask_question.rs`：`build_outcome_for_multiple_answers`（答案回填）
- `mcp_config_service.rs`(6)/`nexus_pipeline.rs`(6)/`commands/dispatch.rs`(2)/`launcher.rs`(1)：`AskListenerHandle`、`register_dispatch_task`、`DispatchTaskParams`、`trigger_dispatch_continue`、`emit_dispatch_request`
- `router/ai_chat_capability.rs`：`send_input`
- `router/ui_render_capability.rs`：`PluginCardOutcome`、`emit_plugin_card_event`
- `web/api/ipc.rs`：`DispatchTaskParams`（HTTP dispatch 入口）
- `bin/polaris_mcp.rs`：`run_ask_mcp_server`（伴生进程入口）

## 结论：**不做文件外迁，改为域内收口**

外迁评估：
1. ask_listener 是**进程内 TCP 服务 + AppState oneshot 表**，与 AppState 强耦合（答案回填、表单流、插件卡、dispatch 任务全在主进程内存里闭环）。外迁到独立 crate/进程需要把 4 张内存表+事件广播全部跨进程化，收益低风险高。
2. ask_mcp_server 是**伴生进程入口**（polaris_mcp bin 的分支），本身就独立于主 crate 运行时。
3. 行数收益 2.8k 对 50k 目标贡献有限，而消费方 10 处遍布核心链路（dispatch/编排/表单/插件卡）。

## 实施项（本波落地）

1. **目录化拆分**（对齐 K-R6 范式）：`services/ask_listener.rs`(1,812) → `services/ask_listener/` 子模块（listener/dispatch/plugin_card/form/emit/types），`ask_listener.rs` 改 `mod.rs` 纯再导出，消费方路径零改动。
2. `ask_listener_meta.rs`、`ask_mcp_server.rs` 保持独立（职责单一）。
3. 删除确认：无 0 消费命令（ask 域不经 tauri command，全部走 TCP/MCP）。

## 验收

- [ ] cargo check / no-default 双门禁通过
- [ ] clippy 无新增
- [ ] 消费方 10 文件零 diff（路径不变）

## 结果（2026-11-16 实施后回填）

- 拆分为 `services/ask_listener/`：mod.rs(64，纯再导出) + frames(协议常量/读写) + listener(TCP accept 循环) + dispatch(任务注册/continue) + plugin_card(插件卡 outcome) + form(表单 flow) + emit(事件广播) + answers(三类 AnswerEntry 构造)
- 消费方 10 文件零 diff；cargo check / no-default 门禁 / clippy（无新增）/ 前端 tsc+vitest 全绿
