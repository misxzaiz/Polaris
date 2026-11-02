# 修复：Claude Code 发送 assistant 结尾请求导致上游 400「inference request is invalid」

> 状态：待实现（2026-11-03）
> 前置诊断：`docs/400-inference-request-invalid-analysis.md`（已确诊根因 + 证据链）
> 范围：`src-tauri/src/services/proxy/sanitizer.rs`（+1 函数 +3 单测）
> 类型：网关层防御性净化（与既有 `repair_orphan_tool_use` 同思路）

---

## 1. 背景

Claude Code 引擎（v2.1.311）经 Polaris 代理 → 本地网关(9850) → 商汤 Sensenova 端点，
对话经常报 `API Error: 400 inference request is invalid`（当天 35 次）。

## 2. 根因（已确诊）

**Claude Code 客户端发送的请求体，`messages` 最后一条是 `assistant(text)`（纯文本，无 tool_use），
违反 Anthropic 协议「messages 必须以 user 角色结尾」。商汤 Sensenova 端点严格校验，
检测到最后一条是 assistant 文本，返回 `inference request is invalid`（400）。**

触发机制：Claude Code 在 **SDK turn 交错**时（`turnOrigin=sdk` 的独立 turn 未合并进主消息流），
发送了以 assistant 结尾的请求。这是 claude code 客户端已知缺陷
（GitHub #8004 werdnum 评论 "the threads become interspersed"）。

**400 是确定性校验失败**：同一请求重试 3 次（每次换 key）全部 400，与 key 无关。

## 3. 修复方案

在 `sanitize_anthropic_messages_body` 末尾调用新增函数 `repair_trailing_assistant`：

- 扫描 `messages`，若**最后一条消息的 `role == "assistant"`**，追加一条
  `{"role": "user", "content": [{"type": "text", "text": ""}]}`
- 使请求以 user 结尾，满足 Anthropic 协议，拦截上游 400
- **不改变正常请求**（最后一条是 user 时不动）

## 4. 接口与行为

### 4.1 函数签名

```rust
/// 修复「最后一条是 assistant」：Anthropic 协议要求 messages 以 user 结尾。
/// Claude Code SDK turn 交错时会发送 assistant 结尾请求（GitHub #8004），
/// 商汤 Sensenova 严格校验返回 400「inference request is invalid」。
/// 出口补一个空 user 消息，让请求以 user 结尾，400 不再发生。
fn repair_trailing_assistant(body: &mut Value)
```

### 4.2 行为表

| 输入（最后一条消息 role） | 输出 |
|---|---|
| `assistant` | 追加空 `user` 消息（`content: [{"type":"text","text":""}]`） |
| `user` | 不变 |
| 非 assistant（system 等） | 不变 |
| `messages` 缺失 / 为空 | 不变 |

### 4.3 防御性

- `content` 用**数组形态** `[{"type":"text","text":""}]`（Anthropic 接受空 text block，已验证重放 200）
- 不依赖 `messages` 存在，`get_mut("messages")` 为 None 直接返回
- 只追加，不删除/改写任何既有消息，无副作用

## 5. 验证

1. `cargo check`（本机 `cargo test --lib` 因 Tauri DLL 无法启动，用 check 兜底）
2. 单测（`sanitizer.rs` 测试区段，新增 3 个）：
   - `repairs_trailing_assistant_by_appending_user` — assistant 结尾 → 补 user
   - `leaves_trailing_user_untouched` — user 结尾 → 不动
   - `handles_missing_messages` — 无 messages → 不 panic
3. 对照重放（已执行）：空 `user` text 结尾请求 → 商汤 **200**（`v-fixed.json` 重放验证通过）

## 6. 不做的事

- **不**修复「连续 assistant / 连续 user」结构损坏（claude code 内部状态问题，出口强行重排 ROI 低）
- **不**动 `repair_orphan_tool_use` 已有逻辑
- **不**加自愈/重试逻辑（违反 AGENTS.md §二.5「不用超时掩盖同步问题」）

## 7. 责任归属与价值

| 维度 | 结论 |
|---|---|
| 400 直接来源 | 商汤 Sensenova 端点校验失败 |
| 根因 | claude code 客户端 SDK turn 交错（非 Polaris 引入） |
| Polaris 价值 | 出口拦截，把 400 变成「自动补 user 后继续」——claude code 自己修不干净时的最后防线 |
