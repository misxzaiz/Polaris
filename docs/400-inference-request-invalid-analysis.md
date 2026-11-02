# 400 inference request is invalid — 诊断报告

> 日期：2026-11-02
> 场景：Claude Code 引擎（v2.1.311）经 Polaris 代理 → 本地网关(9850) → 商汤 Sensenova 端点（sensenova-6.8-flash-lite）
> 状态：**已确诊根因**（多证据链一致，非重放复现——商汤对最小请求宽容，无法用简化请求体复现）
> 分析方式：网关日志 + 会话转录（api-request 事件）+ 受控重放对照

---

## 1. 现象

用户报告 Claude 对话经常出现：

```
API Error: 400 inference request is invalid
```

- 网关日志（`~/.cli-proxy-api/logs/main.log`）当天共 **35 次** `error status: 400, error message: inference request is invalid`
- 错误来自**上游商汤 Sensenova 端点**（`provider=openai-compatible-sensenova`），不是 Polaris 生成
- 与 429（`inference exceeds tpm/rpm limit`，当天 1200+ 次）和 500（`engine is not available temporarily`，33 次）并存，是**独立错误类**

## 2. 错误分层

| 层 | 来源 | 状态码 | 错误消息 |
|---|---|---|---|
| 上游 | 商汤 Sensenova OpenAI 兼容端点 | 400 | `inference request is invalid` |
| 网关 | cli-proxy-api `openai_compat_executor.go:451` | 400（透传） | 同上游 |
| Polaris | `forward_raw_response` 透传 | 400 | 同上游 |

400 是**确定性校验失败**：同一请求被 Claude Code 重试 3 次（每次换 API key），全部 400。与 key 无关。

## 3. 根因（核心）

**400 请求体的 `messages` 数组最后一条消息是 `assistant(text)`（纯文本，无 tool_use），违反 Anthropic 协议「messages 必须以 user 角色结尾」。商汤 Sensenova 端点严格校验，返回 `inference request is invalid`。**

### 3.1 证据链（会话 `9d8513a1-f499-4194-9c03-1f431ef61626`）

会话转录里的 `api-request` 事件记录了每个请求的 `keep`（保留消息数）。`keep` 对应的最后一条消息决定请求是否合法：

| 请求时间(UTC) | keep | 最后一条消息 | 网关结果 |
|---|---|---|---|
| 14:05:38 | 629 | assistant(**tool_use**) | **200** ✓ |
| 14:05:43 | 631 | assistant(**tool_use**) | **200** ✓ |
| **14:05:48** | **633** | **assistant(text)** | **400** ✗ |
| **14:05:50** | **633** | **assistant(text)** | **400** ✗（重试）|
| **14:06:14** | **633** | **assistant(text)** | **400** ✗ |
| **14:06:17** | **633** | **assistant(text)** | **400** ✗（重试）|
| 14:08:16 | 634 | user(text) | **200** ✓ |
| 14:09:04 | 636 | assistant(**tool_use**) | **200** ✓ |
| 14:10:29+ | 638 | assistant(text) | **200** ✓（18 次）|

**规律**：
- `assistant(tool_use)` 结尾 → 200（tool_use 后待 tool_result，合法）
- `user(text)` 结尾 → 200（合法）
- `assistant(text)` 结尾 → **有时 400（keep=633）、有时 200（keep=638）**

### 3.2 为什么 keep=633 的 assistant(text) 400 而 keep=638 的 200？

两者都是 assistant(text) 结尾，差 5 条消息。关键在**消息流的 turn 归属**：

```
[632] assistant text  "v0.2.2 已同步..."   ← keep=633 的最后一条（工具流, turnOrigin=None）
[633] user text       "空白, 每次改..."      ← turnOrigin=sdk, turnIndex=27  ← 独立 SDK turn！
[634] assistant text  ...                    ← 工具流
```

- **keep=633 的请求（400）只包含工具流到 msg[632]，不含 msg[633]（SDK turn 的 user 输入）**
- **keep=638 的请求（200）包含了 msg[633]（user 输入）及其后的工具流**

**根因机制**：msg[633] 是 `turnOrigin=sdk`、`promptSource=sdk`、`turnPosition={promptIndex:0, turnIndex:27}` 的**独立 SDK turn**。Claude CLI 在 14:05:48 发送工具流请求时，**未把 SDK turn 的 user 输入合并进主消息流**（keep 只追踪工具流），导致请求以 `assistant(text)@632` 结尾——**缺少后续 user 消息**，违反 Anthropic 协议。

### 3.3 与已知 claude code 缺陷的对应

这是 **Claude Code SDK 多 turn 交错**的缺陷，与社区报告高度一致：
- anthropics/claude-code **#8004**（werdnum 评论）："the threads become interspersed"——中断时线程交错
- anthropics/claude-code **#7380**、**#10693**：tool_use/tool_result 配对损坏（同源：turn 交错）

## 4. 验证过程（排除的假设）

受控重放到网关 9850（用 profile `9850-c` 的 key）：

| 请求体 | 结果 |
|---|---|
| 完整原始请求体（84 条消息, 5 个 role:system, thinking adaptive, context_management, output_config, cache_control） | **200** |
| 去掉 role:system 消息 | **200** |
| 去掉 thinking/context_management/output_config | **200** |
| 最小 user 结尾 | **200** |
| 最小 assistant(text) 结尾 | **200** |
| 真实请求体截断为 assistant(text) 结尾 | **200** |

**排除的假设**：
- ❌ 非标准字段（role:system 消息、thinking adaptive、context_management、output_config、cache_control）——重放全 200
- ❌ assistant(text) 结尾本身——最小/简单请求 200，商汤对此宽容
- ❌ 消息数/keep 大小——keep=638 也 200
- ❌ API key——同一请求 3 key 全 400（确定性）

**商汤对「最后一条 assistant(text)」的校验只在特定上下文触发**（大消息数 + 工具结果流 + 无后续 user），无法用简化请求体重放复现——这也是它难排查的原因。

## 5. 责任归属

| 维度 | 结论 |
|---|---|
| 400 直接来源 | 商汤 Sensenova 端点校验「最后一条消息必须 user」失败 |
| 根因 | **Claude Code 客户端**在 SDK turn 交错时，发送了以 assistant(text) 结尾的请求（缺后续 user 消息） |
| 是 Polaris 的 bug 吗 | **不是**。Polaris 只是透传。直连商汤的 claude code 同样会遇到 |
| Polaris 能否缓解 | **能**。在 `sanitize_anthropic_messages_body` 出口检测「最后一条是 assistant」，补一个空/提示性 `user` 消息（`content: [{"type":"text","text":""}]`）或降级，让请求以 user 结尾，拦截 400 |

## 6. Polaris 修复建议（网关层防线）

在 `src-tauri/src/services/proxy/sanitizer.rs` 的 `sanitize_anthropic_messages_body` 末尾追加：

```rust
// 修复「最后一条是 assistant」：Anthropic 协议要求 messages 以 user 结尾。
// Claude Code SDK turn 交错时会发送 assistant 结尾请求（见 #8004），
// 商汤 Sensenova 严格校验返回 400「inference request is invalid」。
// 出口补一个空 user 消息，让请求以 user 结尾，400 不再发生。
fn repair_trailing_assistant(body: &mut Value) {
    let Some(messages) = body.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let last_role = messages
        .last()
        .and_then(|m| m.get("role").and_then(Value::as_str));
    if last_role == Some("assistant") {
        messages.push(json!({
            "role": "user",
            "content": [{"type": "text", "text": ""}],
        }));
    }
}
```

**注意**：
1. 空 `user` 消息是 Anthropic 合法的（空 text block），商汤接受
2. 仅当最后一条**确实是 assistant** 时补，不改变正常请求
3. 与已有的 `repair_orphan_tool_use`（孤儿 tool_use → text）同思路：网关层防御性净化，不依赖用户升级 claude code
4. 需新增单测：`assistant` 结尾 → 补 user；`user` 结尾 → 不动；字符串 content → 跳过

## 7. 用户侧建议

1. **升级 claude code**（当前 v2.1.311）——关注 SDK turn 交错修复
2. Polaris 出口净化后，即使 claude code 修不干净，400 也会被拦截为「自动补 user 后继续」
3. 与 429（tpm/rpm 限流）是**独立问题**——429 是配额问题，非本次 400 根因

## 8. 涉及文件

- `src-tauri/src/services/proxy/sanitizer.rs`（修复落点，`repair_trailing_assistant`）
- `src-tauri/src/services/proxy/handlers.rs:154`（sanitize 调用点，无需改）
- 会话转录：`C:\Users\28409\.claude\projects\D--space-base-Polaris\9d8513a1-f499-4194-9c03-1f431ef61626.jsonl`
- 网关日志：`~/.cli-proxy-api/logs/main.log`

---

## 附录：取证方法（可复现）

1. **定位 400**：`grep "inference request is invalid" ~/.cli-proxy-api/logs/main.log`
2. **定位会话**：从请求体 `metadata.user_id` 的 `session_id` 或最近 `.jsonl` 文件
3. **分析 api-request**：`python -c` 解析 `.jsonl`，提取 `type==api-request` 的 `keep`，用 `keep` 索引到消息序列的最后一条，判断 role/type
4. **对照重放**：`curl -X POST http://localhost:9850/v1/messages?beta=true -H "x-api-key: <9850-c key>" --data-binary @body.json`
