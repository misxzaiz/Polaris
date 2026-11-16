# K-R6：ai_chat_core 拆分 spec

日期：2026-11-16 ｜ 波次：K-R6（host-kernel-roadmap.md） ｜ 目标：2,928 行单文件 → 目录化子模块，核心编排 ≤ ~800 行

## 现状盘点（2026-11-16 实测）

`src-tauri/src/services/ai_chat_core.rs` 2,928 行，单一 `pub mod ai_chat_core`，15 个 pub 符号。
消费方仅 3 个文件：`router/ai_chat_capability.rs`（15 符号，主消费）、`router/history_capability.rs`
（interrupt_chat_inner）、`router/ui_render_capability.rs`（注释引用 respond_plugin_card）；
`web/api/ipc.rs` 与 commands 层**不直接引用**（聊天入口全部走 cap.ai.chat）。

## 分区结构（现有注释分区 → 子模块映射）

| 现分区（行区间） | 行数 | 新子模块 |
|---|---|---|
| Attachment/ChatRequestOptions 类型（30-143） | ~113 | `types.rs` |
| 附件处理 process_attachments 等（143-557） | ~340 | `attachments.rs` |
| AppPaths/ChatCallbacks/apply_model_profile_options（557-860） | ~286 | `callbacks.rs`（AppPaths/ChatCallbacks）+ `profile_options.rs` |
| 供应商分组路由 failover（860-1106） | ~230 | `provider_routing.rs` |
| start_chat_inner（1126-1752） | ~627 | `start_chat.rs` |
| continue_chat_inner（1752-2162） | ~411 | `continue_chat.rs` |
| interrupt_chat_inner（2162-2237） | ~76 | `interrupt.rs` |
| 事件广播 helper（2237-2266） | ~30 | `events.rs` |
| session_events 影子写入（2266-2266+） | ~45 | `events.rs` |
| AskUserQuestion pending（2311-2544） | ~233 | `ask_question.rs` |
| PlanMode pending（2544-2717） | ~174 | `plan_mode.rs` |
| send_input（2717-2928） | ~212 | `send_input.rs` |
| route_failover_tests（2740-2928 内嵌） | ~190 | 随 `provider_routing.rs` 走（`#[cfg(test)]` 子模块） |

## 拆分方式（纯机械移动，零行为变更）

1. 新建目录 `src-tauri/src/services/ai_chat_core/`，`ai_chat_core.rs` 改为 `mod.rs`
   （仅 `pub mod` 声明 + `pub use` 再导出全部既有 pub 符号——**对外路径
   `services::ai_chat_core::X` 不变**，3 个消费方零改动）。
2. 各子模块 `use super::*` 级共享导入下沉到各自文件；跨子模块引用经 `super::` 或
   再导出符号。
3. `route_failover_tests` 移入 `provider_routing.rs` 的 `#[cfg(test)]`。
4. 不改任何函数签名、不改任何逻辑；`pub use` 保证 `ai_chat_capability.rs` 的
   `core::xxx` 调用零改动。

## 验收

- [ ] `cargo check` / `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 通过
- [ ] `cargo clippy --lib` 无新增 warning
- [ ] 前端 `tsc --noEmit` + vitest 821 全绿（前端不感知）
- [ ] `ai_chat_core/mod.rs` ≤ ~120 行（纯 mod 声明与再导出）
- [ ] 消费方 3 文件零 diff

## 后续（非本 spec）

拆分后 `start_chat.rs`/`continue_chat.rs` 仍各 ~600/400 行，属编排逻辑本体；
K-R6 不做进一步函数级拆分（无收益）。真正的减法在 K-R3（ask_listener 外迁）、
K-R1（simple-ai 出仓）等域级波次。
