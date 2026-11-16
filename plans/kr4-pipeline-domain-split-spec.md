# K-R4：流水线域（nexus/form/context）目录化拆分 spec

日期：2026-11-16 ｜ 波次：K-R4（host-kernel-roadmap.md） ｜ 目标：3,231 行六个平铺文件 → 三个目录化子模块域

## 现状盘点（2026-11-16 实测）

| 文件 | 行数 | 职能 | 主要消费方 |
|---|---|---|---|
| `nexus_pipeline.rs` | 1,073 | 专家团编排（RosterPipeline/plan_waves/advance/dispatch） | simple_ai/agent、ask_listener(listener/dispatch)、commands/nexus、ipc |
| `nexus_verdict.rs` | 204 | 结果裁决 schema（qa-pass/gate-keeper 等） | nexus_pipeline、ask_listener/dispatch、commands/dispatch |
| `context_core.rs` | 379 | 上下文记忆存储（ContextMemoryStore） | state.rs、bus_mcp_server、context_capability、integration_tests |
| `form_flow.rs` | 538 | 表单 hold/submit/skip 流程 | state.rs、ask_mcp_server、ai_chat_capability、ask_listener |
| `form_core.rs` | 633 | 表单字段校验/合并核 | form_flow、form_template、ask_listener/form、ai_chat_capability |
| `form_template.rs` | 404 | 表单模板存取 | ask_listener/form、ai_chat_capability |

合计 **3,231 行**。全部被 Rust 核心链路（引擎/编排/capability）消费，**不具外迁条件**（同 K-R3 结论：与 AppState/引擎循环强耦合）。

## 拆分方式（对齐 K-R3/K-R6 范式：目录化 + 纯再导出，消费方零改动）

1. `services/nexus_pipeline.rs`(1,073) → `services/nexus_pipeline/`：按 pub 符号切
   `types.rs`（MemberState/LoopState/Escalation/LaterGroup/RosterPipeline/AdvanceResult）、
   `waves.rs`（plan_waves/append/record_summary 等）、`advance.rs`（advance/escalation/dispatch）、
   mod.rs 纯再导出。`nexus_verdict.rs` 并入该目录为 `verdict.rs`。
2. `services/form_flow.rs` + `form_core.rs` + `form_template.rs`（1,575）→
   `services/form/`：`flow.rs`（FormHold/build_hold/build_component_hold/submit_form/
   cleanup_expired/build_skip_receipt）、`core.rs`（字段校验/合并）、`template.rs`（模板存取）、
   mod.rs 纯再导出（`services::form_flow::*` 旧路径经 mod.rs `pub use` 保持）。
3. `services/context_core.rs`(379) → `services/context_core/`：`types.rs`（全部 pub 结构/枚举）、
   `store.rs`（ContextMemoryStore impl）、mod.rs 再导出。
4. 不改任何函数签名与逻辑；消费方约 20 文件经再导出零 diff。

## 验收

- [ ] cargo check / cargo check --no-default-features --bin polaris-web --bin polaris-mcp 通过
- [ ] clippy 无新增 warning
- [ ] 前端 tsc + vitest 全绿（前端不感知）
- [ ] 消费方文件零 diff
