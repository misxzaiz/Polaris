# K-R1：simple-ai 引擎出仓评估 spec

日期：2026-11-16 ｜ 波次：K-R1（host-kernel-roadmap.md 最后一波）

## 现状盘点（2026-11-16 实测）

- `ai/engine/simple_ai/` 21 文件 **9,059 行** + `ai/engine/simple_ai_protocol.rs` **1,967 行** = **11,026 行**（占 Rust 侧 ~11%）。
- 组成：mod(SimpleAIEngine 实现 AIEngine trait, 762)、chat_loop(731)、compact(1,294)、tools/(fs/apply_patch/search/plan/bash/computer/file_state, ~2.4k)、mcp/(client/transport, ~1.2k)、protocol(请求体构建/wire 协议, 1,967)、agent/history/context/retry/store/skill。
- 消费方：
  - `lib.rs` ×2：`engine_registry.register(SimpleAIEngine::new(config))`（引擎注册，核心生命周期）
  - `ai/engine/mod.rs`：`pub use simple_ai::SimpleAIEngine`
  - `ai/launcher.rs` / `state.rs`：`resolved_simple_ai_servers`（mcp_config_service 内置 MCP，**非 simple_ai 模块本身**）
  - `ai/traits.rs`：`EngineId::SimpleAI` 字符串别名（纯枚举）
  - 前端 `AIEngineTab.tsx`：`simple-ai` 引擎展示项（纯字符串）
  - `simple_ai_protocol_check` bin：协议自检工具
- 外部耦合：reqwest(上游 HTTP)、serde、MCP client、AppState（配置/用量/审计）。

## 可行性评估结论：**进程内目录化收口（同 K-R3/R4/R6），不做跨进程出仓**

1. simple-ai 是 `AIEngine` trait 的**进程内实现**，经 EngineRegistry 注册分发；事件经
   AIEvent → EventBroadcaster 出站。跨进程出仓（独立进程/插件）需重写引擎-宿主
   通信协议（事件流/stdin/中断/审批），风险与工作量远超收益——与 K-R2/R3 评估同结论。
2. 行数收益 11k 对 50k 目标显著，但该域是「AI 引擎实现」——属于宿主不可替换核
   （roadmap 定义：插件系统 + cap 总线 + transport/鉴权 + 会话存储 + 应用生命周期；
   引擎实现是产品能力核）。**真外迁 = 产品形态变更（引擎插件化），单独立项**。
3. 本波落地：目录化拆分（simple_ai 21 文件已是目录结构，主要问题在
   simple_ai_protocol.rs 1,967 行单文件与 mod.rs 762 行）+ 死代码/警告收尾。

## 实施项

1. `simple_ai_protocol.rs`(1,967) → `simple_ai_protocol/` 目录化：`types.rs`（协议枚举/
   CliModelSuffix）、`request.rs`（build_request_body* / thinking/cache）、
   `openai.rs`（build_openai_chat_body）、`anthropic.rs`（build_anthropic_body）、
   `responses.rs`（build_responses_body）、`stream.rs`（StreamState/finish_*）、mod.rs 再导出。
2. `simple_ai/` 内部已分层（tools/mcp），维持。
3. 死代码/警告收尾（clippy 基线对照）。

## 验收

- [ ] cargo check / no-default 双门禁通过（含 simple_ai_protocol_check bin）
- [ ] clippy 无新增
- [ ] 前端 tsc + vitest 全绿
- [ ] 消费方零 diff（engine/mod.rs、lib.rs 仅路径级调整）

## 结果（2026-11-16 实施后回填）

- simple_ai_protocol 目录化完成（1,967 → mod/types/request/openai/anthropic/
  responses/stream 7 文件），simple_ai/ 引擎目录维持。
- 双门禁/clippy/前端 tsc+vitest 全绿。
- 真外迁（引擎进程化）明确不在 K-R1 范围，留待产品级立项。
