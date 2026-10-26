# zcode 引擎：思考/工具调用流式适配 spec

> 状态：2026-10-26 **已实施并验证**。zcode 引擎主对话端到端打通（会话创建/流式回显/续聊）；
> 本轮补齐：推理折叠（thinking_delta）、工具调用工具面板（toolcall_start/end → ToolCallBlock）、
> 收尾状态机（sessionFinalized）。验证方式见 §9；遗留：真实模型在场的 UI 全链路复验（当日模型网关上游限流，见 §9.3）。

## 1. 背景与目标

- **目标**：主对话 ZCode 会话中，推理（reasoning_delta）折叠展示、工具调用显示在现有工具面板（ToolCallBlock），正文完整流式输出。
- **现状**：engine.js 把 ZCode `text-delta`（含 reasoning/tool_input/tool_call/result 等 kind）**全部当作正文 text_delta 转发**，导致推理混入正文；工具调用 events 被丢弃；turn 收尾逻辑遇工具多轮时正文丢失。

## 2. 实测事件结构（zcode-full-events.tmp.json，sess_43b885b5 真实会话）

### 2.1 事件 kind 全集（桥 /api/chat/events 返回）

```
misc / turn-started / text-delta / turn-complete
```

`text-delta` 的 `payload.kind` 细分：`reasoning_delta`（推理）、`text_delta`（正文）、
`tool_input_start` / `tool_input_delta` / `tool_input_end`（工具输入流）、`tool_call`（含完整 input）。

**工具执行事件走 `misc` kind（不是 text-delta！）**，payload.kind：`scheduled` / `started` /
`progress` / `result` / `batch` / `tool_result`。两处 kind 语义不同，engine.js 必须分别处理
（曾按同一处处理导致 toolcall 帧发不出来）。

### 2.2 工具生命周期样例（真实数据，首个逻辑轮 180 事件实测）

```js
// text-delta 事件（payload.kind）
{ kind:"reasoning_delta", delta:"The user's message is..." }        // 推理
{ kind:"text_delta", delta:"我先看一下改动相关的内容..." }          // 正文
{ kind:"tool_input_start", toolCallId:"call_xxx" }
{ kind:"tool_input_delta", toolCallId:"call_xxx", delta:'{"command":"cd ..."}' }  // 片段，须忽略
{ kind:"tool_input_end", toolCallId:"call_xxx" }
{ kind:"tool_call", toolCallId:"call_xxx", input:{command:"...", description:"..."} }  // 完整 input

// misc 事件（payload.kind）
{ kind:"scheduled", toolCallId, toolName:"Bash", inputOmitted:true }
{ kind:"started", toolCallId, toolName:"Bash", startedAt, readOnly }
{ kind:"progress", toolCallId, elapsedMs, pid, stdoutBytes, ... }
{ kind:"result", toolCallId, duration, result:{ success:true, content:"..." } }  // 嵌套结构！
{ kind:"tool_result", anchorId, attemptId, ... }
```

**`result` 的 success/content 嵌套在 `p.result` 下**（早期记录误写为扁平 `{success, content}`），
engine.js 做了两种形态兼容。

**真实时序陷阱**：`tool_call`(text-delta，带 input) → `turn-complete(tool-calls)` →
`scheduled` → `started` → `result`。即 toolcall_start 发射点（started）在 turn-complete
**之后**——工具轮收尾分支里绝不能清 toolBuffer，否则 started 拿不到 input（实测踩坑）。

`turn-complete` payload：`{content, stopReason, contextWindow, usage:...}`，
`stopReason: "tool-calls"` 表示本轮是工具调用（正文在后续 turn）。

## 3. PiRpc 工具帧契约（engine.js → pi_parser）

PiRpc `message_update` 的 `assistantMessageEvent.type` 现有契约：`text_delta` / `thinking_delta`。
扩展两个工具子事件：

| engine.js 发送 | pi_parser 解析 | 上层 AIEvent |
|---|---|---|
| `assistantMessageEvent.type="toolcall_start"`, 含 `tool_call_id`、`tool`(工具名)、`input`(object) | → ToolCallStart | `AIEvent::ToolCallStart` |
| `assistantMessageEvent.type="toolcall_end"`, 含 `tool_call_id`、`tool`、`output`(string)、`success`(bool) | → ToolCallEnd | `AIEvent::ToolCallEnd` |

（字段命名对齐现有 `ToolCallStartEvent` camelCase：`call_id/tool/args`；前端 ToolCallBlock 消费。）

插件引擎 `event_callback(ev)` 原样透传所有 AIEvent → 前端工具面板渲染。**plugin_engine.rs 无需改动。**

## 4. engine.js 适配

### 4.1 状态机改造

- 维护 `tools` Map：`toolCallId → {name, input, output, success}`。
- `reasoning_delta` → `thinking_delta` 帧（折叠）；**不再当正文**。
- `tool_input_start` → emit `toolcall_start`（name 暂用未知，input 用后续 tool_call 补全）。
- `tool_call` → 更新 input（name 来自 `toolName` 或 input 字段推测）。
- `result` → emit `toolcall_end`（output=content, success）。
- `progress` → 忽略（可选：toolcall_update 留待后续）。
- `turn-complete`：
  - `stopReason == "tool-calls"` → 本轮无正文（content 是推理摘要），**不 emitMessageEnd/turnEnd**，继续下一轮。
  - 否则（有正文且无工具）→ `emitMessageEnd + turnEnd`。
- `turn-started` 重置单轮状态；每轮内 role：首文本 delta 前 emitMessageStart。

### 4.2 正文完整性问题（根因）

之前 turn-complete 收尾依赖 `turnStartedOnce`，遇工具调用轮 content=推理摘要时
误收尾。改为**按 stopReason 判断是否收尾**，工具轮不去 emitMessageEnd，
让最终正文轮自然收尾。空 content 纯推理收尾仍忽略（已验证行为）。

## 5. pi_parser.rs 修改

`message_update` 分支 `_ => {}` 加两个子事件分支：

```rust
"toolcall_start" => {
    let tool = ame.get("tool")...unwrap_or("tool");
    let call_id = ame.get("tool_call_id")...;
    let args = ame.get("input").and_then(|v| v.as_object())
        .map(|o| o.clone()).unwrap_or_default();
    out.events.push(AIEvent::ToolCallStart(
        ToolCallStartEvent::new(current_sid, tool, args).with_call_id(call_id)));
}
"toolcall_end" => {
    let tool = ...; let call_id = ame.get("tool_call_id")...;
    let success = ame.get("success").and_then(|v| v.as_bool()).unwrap_or(true);
    let result = ame.get("output").and_then(|v| v.as_str()).unwrap_or("");
    out.events.push(AIEvent::ToolCallEnd(
        ToolCallEndEvent::new(current_sid, tool, success, result).with_call_id(call_id)));
}
```

需确认 `ToolCallEndEvent::new` 签名（session, tool, success, result）。aliasing 用插件现有名。

## 6. 收尾与验证

- 改完 pi_parser 跑 `cargo check`（本机不可 cargo test --lib，AGENTS.md §7 约束）。
- pi_parser 已有文本增量回归测试；补 toolcall_start/end 解析单测（沿用 parse() 直接调用测）。
- engine.js 改完用真实 ZCode 会话驱动 `drive-cmd-launcher.js`（或直接 UI 会话）看：
  - 推理折叠、工具调用出现在面板、正文完整收尾。

## 7. 不做

- 不做 toolcall_update / progress 流式进度（工具执行中态留待后续）。
- 不改为 opencode 的 tool_use JSONL 协议（PiRpc 帧是当前插件引擎契约）。
- 不动 plugin_engine.rs / plugin_process_engine.rs（事件透传已够）。

## 8. 相互引用

- 桥协议：`mcp/engine.js`（本改动主要对象）
- 解析层：`src-tauri/src/ai/engine/pi_parser.rs`
- AIEvent 类型：`src-tauri/src/models/ai_event.rs`（ToolCallStart/ToolCallEnd）
- 前端块：`src/types/chat.ts` ToolCallBlock
- 里程碑：`Polaris-plugin/plugins/zcode-bridge/PLAN-engine-plugin.md` §5 阶段 4

## 9. 实施结果（2026-10-26）

### 9.1 改动清单

- **pi_parser.rs**：`message_update` 加 `toolcall_start`/`toolcall_end` 分支 → `AIEvent::ToolCallStart/End`
  （`tool_call_start(sid, tool, args)` / `tool_call_end(sid, tool, success)` + `.with_call_id/.with_result`）；
  补单测 `test_zcode_toolcall_start_end_via_message_update`。`cargo check --tests` 通过。
  plugin_engine.rs `event_callback` 原样透传，无需改动。
- **mcp/engine.js**（仓库版为权威，已同步生产 `D:/app/polaris-s/.../mcp/engine.js`）：
  - `zcodeEventToPi` 状态机：`reasoning_delta → thinking_delta`；工具输入流 `tool_input_delta/end` 显式忽略
    （曾掉进 else 被当正文流出）；`tool_call` 缓存 input；misc 分支处理 `scheduled/started/result`
    发 `toolcall_start/end`；`result` 兼容嵌套 `{result:{success,content}}` 与扁平结构。
  - `turn-complete`：`stopReason=='tool-calls'` 不收尾；否则收尾并置 `sessionFinalized`。
    **工具轮分支不清 toolBuffer**（started 在 turn-complete 之后才到）。
  - `drainZcode`：退出唯一依据 `sessionFinalized`（空闲型 180s 兜底，事件到达即重置——
    agentic 长任务不被绝对上限砍断）；`abort` 置位退出并补收尾帧。
  - `turn_start` 曾在重写中丢失（`emitTurnStart` 无调用点）——现于 `ensureMessageOpen` 惰性开启，
    保持「纯工具轮不产生空 turn」。
  - 新会话 create 后 resume 重试激活（ZCode 会话异步落盘，实测 -32004/"Session not found"）。

### 9.2 验证

- **回放回归测试**：`Polaris-plugin/plugins/zcode-bridge/test/engine-replay.cjs`
  （内嵌 mock 桥回放 `test/fixtures/zcode-first-turn.json`——真实会话首个逻辑轮 180 事件、
  5 个完整工具调用；spawn 仓库版 engine.js 走完整管线）**12/12 断言通过**：
  thinking 全部分离、toolcall_start 带真实工具名+完整 input、toolcall_end 带非空 output、
  start→end 顺序与 callId 配对、正文无工具 JSON 泄漏、收尾非超时、续聊轮正常。
- `cargo check --tests` 通过（pi_parser 含新单测）。

### 9.3 已知边界与遗留

- **真实模型在场的 UI 全链路复验未做**：2026-10-26 深夜模型网关（localhost:9850 →
  deepseek-v4-flash）上游持续 429 限流，ZCode 轮内 9+ 次重试无产出、prompt 悬挂
  （第二轮 send 报 `-32010 A prompt is already running`，engine 正确把错误透出为正文+agent_end）。
  待配额恢复后在 UI 新建 ZCode 会话发一个触发工具的 prompt 复验面板渲染即可
  （帧契约已由回放测试覆盖，风险低）。
- abort 后 ZCode 侧生成不会停止（桥无 session/stop 通道），仅停止向 UI 转发；宿主 kill 兜底。
- PiRpc 引擎「会话结束后未找到落盘文件」warn 为误报噪音（engine.js 用自己的
  `<session-dir>/<temp_id>.json` 映射，续聊已实测可用）。
- `Polaris-plugin/plugins/zcode-bridge/` 整个目录在插件仓库**仍未提交**（含本轮 launcher 修复、
  engine.js 全部改动与回归测试）——需要一次 `feat(zcode-bridge): ...` 提交固化。