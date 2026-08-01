# 工具执行中间输出实时显示 — TODO

> 分析日期：2025-08-01
> 背景：四个引擎（Pi / Claude Code / Codex / SimpleAI）的 bash 执行结果目前都是等命令完全结束后才一次性返回，无法实时显示中间输出。

---

## TODO 1：Rust 端新增 `ToolCallUpdate` 事件变体

**文件：** `src-tauri/src/models/ai_event.rs`

- 在 `AIEvent` 枚举中新增 `ToolCallUpdate(ToolCallUpdateEvent)` 变体
- 新增 `ToolCallUpdateEvent` 结构体，包含：
  - `session_id: String`
  - `call_id: Option<String>`
  - `tool: String`
  - `output: String`（当前累积的中间输出）
  - `is_partial: bool`（`true` = 还有更多，`false` = 最终结果）
- 更新 `AIEvent` 的所有 match 分支（`event_type()`、`session_id()`、`extract_tool_info()` 等）

**依赖：** 无（独立新增，不影响现有事件）

---

## TODO 2：Pi 解析器透传 `tool_execution_update`

**文件：** `src-tauri/src/ai/engine/pi_parser.rs` 第207-209行

- 当前代码：
  ```rust
  "tool_execution_update" => {
      // 工具执行进度（流式输出）；当前不透出，避免噪声
  }
  ```
- 改为：解析 `data` 字段中的文本输出，构造 `AIEvent::ToolCallUpdate` 事件推送
- 注意：Pi RPC 的 `tool_execution_update` 可能带 `partial: true` 标记，需映射到 `is_partial`
- 添加单元测试覆盖 `tool_execution_update` 的解析

**依赖：** TODO 1

---

## TODO 3：SimpleAI bash 工具改为异步流式执行

**文件：** `src-tauri/src/ai/engine/simple_ai/tools/bash.rs`

- 当前 `run_bash()` 使用 `std::process::Command::output()` 同步阻塞
- 改为：
  - 使用 `tokio::process::Command` 异步 spawn
  - 逐行读取 stdout，通过回调/通道推送中间输出
  - 最后发送最终结果（`is_partial: false`）
- 需要考虑：输出截断策略（中间输出也受 32KB 限制？还是单独限制？）

**依赖：** TODO 1；同时需要修改 `Tool::execute` 签名或 `ToolContext` 以支持中间回调

---

## TODO 4：前端新增 `ToolCallUpdateEvent` 类型

**文件：** `src/ai-runtime/event.ts`

- 新增 `ToolCallUpdateEvent` 接口：
  ```typescript
  export interface ToolCallUpdateEvent {
    type: 'tool_call_update'
    sessionId: string
    callId?: string
    tool: string
    output: string
    isPartial: boolean
  }
  ```
- 加入 `AIEvent` 联合类型
- 实现 `createToolCallUpdateEvent()` 工厂函数
- 实现 `isToolCallUpdateEvent()` 类型守卫
- 更新 `event-bus.ts` 的 `EventType` 枚举

**依赖：** TODO 1（前后端事件类型需对齐）

---

## TODO 5：前端聊天 UI 渲染工具中间输出

**文件：** `src/components/Chat/AgentRunBlockRenderer.tsx` 及相关组件

- 当前 `AgentRunBlockRenderer` 只渲染 `tool_call_start` 和 `tool_call_end`
- 新增 `tool_call_update` 事件处理：
  - 工具执行期间显示实时输出区域（类似终端滚动）
  - 支持文本追加（累积增量）
  - 可选的：`isPartial` 标志控制是否显示"执行中..."动画
- 考虑：对于长输出，是否需要虚拟滚动或截断策略

**依赖：** TODO 4

---

## TODO 6：Claude Code / Codex 解析器支持工具增量

**文件：** `src-tauri/src/ai/event_parser.rs`（Claude）、`src-tauri/src/ai/engine/codex_parser.rs`（Codex）

- 调研 Claude CLI 的 `--output stream-json` 是否支持工具执行的增量输出事件
- 调研 Codex CLI 的 `--output-format stream-json` 是否支持类似事件
- 如果支持：在对应解析器中添加 `tool_output` / `tool_update` 事件的解析
- 如果不支持：记录为"上游限制"，需等待 CLI 版本升级

**依赖：** TODO 1；需要先做调研再决定实施

---

## 优先级建议

| TODO | 优先级 | 工作量 | 说明 |
|------|--------|--------|------|
| 1. Rust ToolCallUpdate | 🔴 高 | 小 | 整条管道的基础，没有它后面都做不了 |
| 2. Pi 解析器透传 | 🔴 高 | 小 | Pi 协议已支持，改动最小收益最高 |
| 4. 前端事件类型 | 🔴 高 | 小 | 与 TODO 1 对齐，同步完成 |
| 5. 前端 UI 渲染 | 🟡 中 | 中 | 核心用户体验，但依赖 TODO 4 |
| 3. SimpleAI 异步化 | 🟡 中 | 大 | 需要重构 Tool trait 签名 |
| 6. Claude/Codex 调研 | 🔵 低 | 小 | 先调研，可能受限于上游 CLI |