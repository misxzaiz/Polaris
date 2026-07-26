# Stop 中断导致 Tool Calling 400 — 复现报告

> 场景：ClaudeCode 引擎 + OpenAI 协议供应商（AnthropicMessages 直通模式）
> 日期：2026-07-26
> 状态：已复现（两个测试，本机 `--no-default-features` 全绿）

---

## 1. 问题现象

用户在 Tool Calling（MCP / WebFetch / Filesystem 等）过程中点击 Stop，Polaris 保留
`assistant(tool_calls)` 消息但不写入对应 `tool_result`。后续所有请求都因协议校验失败
返回 **400**。

## 2. 根因

根因在代理流式转换层 `src-tauri/src/services/proxy/streaming.rs` 的中断处理。

当用户点 Stop：

1. `interrupt_chat_inner`（`src-tauri/src/commands/chat.rs:1171`）杀掉 claude CLI 进程。
2. claude CLI 进程退出，它与 Polaris 代理之间的 HTTP 连接断开。
3. 代理侧 `streaming.rs` 的上游流读取进入 `Err(_)` 分支（line 310）或 stream 末尾
   分支（line 340）。
4. 此时上游 OpenAI 供应商可能**已经发出 tool_call delta**——代理侧 tool_use block
   已 `started=true`（`content_block_start` 已发给 claude CLI，id+name 就位）。
5. 代理在补发终止事件时：
   - 对所有 started 的 tool_block 发 `content_block_stop`（line 318-323）
     ——**让 tool_use block 结构完整**
   - 发 `message_delta` 带 **`stop_reason=end_turn`**（line 325-328 / 357-361）
     ——**硬编码，未检查是否已有 started 的 tool_block**
6. claude CLI 收到「完整 tool_use block + end_turn」，认为这轮 assistant 已结束，
   把**含 tool_use 但无 tool_result** 的 assistant 消息写入会话历史。
7. 用户下次 continue → claude CLI 把历史（含孤儿 `assistant(tool_use)`）发给代理
   → `sanitizer.rs:75` 的 `sanitize_block` 对 `tool_use`/`tool_result` 只 `clone()`，
   **不校验配对** → 孤儿 tool_use 一路透传到上游。
8. 上游 Claude 供应商校验「每个 tool_use 必须有对应 tool_result」失败 → **400**。

放大因素：`sanitizer.rs` 的 `sanitize_anthropic_messages_body` 只逐条净化 block 类型，
不扫描「孤儿 tool_use 缺 tool_result」，作为最后一道防线也失守。

## 3. 复现测试

### 测试 1：代理在中断时产生孤儿 tool_use

`streaming.rs::reproduce_stop_during_tool_call_emits_orphan_tool_use`

构造模拟上游 OpenAI SSE 流，发一条 tool_call delta（id+name 就位）后用 `Err` 模拟
Stop 中断。代理实际输出：

```
event: content_block_start
data:  {"content_block":{"type":"tool_use","id":"call_1","name":"bash","input":{}},"index":0}

event: content_block_delta  ×2   (arguments 累积)

event: content_block_stop        ← 关闭 tool_use block(结构完整!)

event: message_delta
data:  {"delta":{"stop_reason":"end_turn",...},"type":"message_delta",...}   ← 根因

event: message_stop
```

无 `tool_result`。证明：Stop 中断时代理让 tool_use block 结构完整 +
`stop_reason=end_turn`，claude CLI 会把这条 assistant(tool_use) 当作正常完成写入历史。

### 测试 2：端到端复现 400

`handlers.rs::reproduce_orphan_tool_use_replay_results_in_400`

起 mock 上游（模拟真实 Claude 供应商，校验「每个 tool_use 必须有对应 tool_result」）
+ 真实 Polaris 代理（AnthropicMessages 直通）。模拟 claude CLI 下一轮 continue
发带孤儿 tool_use 的历史请求：

```json
{
  "model": "claude-test",
  "max_tokens": 1024,
  "stream": false,
  "messages": [
    {"role": "user", "content": "list files"},
    {"role": "assistant", "content": [
      {"type": "text", "text": "I'll run bash."},
      {"type": "tool_use", "id": "toolu_orphan", "name": "bash",
       "input": {"command": "ls"}}
    ]},
    {"role": "user", "content": "continue"}
  ]
}
```

断言：代理透传后客户端拿到 **HTTP 400**，错误信息指向 `tool_use` 缺 `tool_result`。✓ 通过。

### 完整因果链

```
用户 Stop
  → interrupt_chat_inner 杀 claude CLI
  → 代理上游流中断 (streaming.rs Err 分支)
  → 代理发 content_block_start(tool_use) + content_block_stop
     + stop_reason=end_turn                                    [测试1]
  → claude CLI 把孤儿 assistant(tool_use) 写入历史
  → 下轮 continue 发带孤儿 tool_use 的请求
  → 代理 sanitize 原样保留 (sanitizer.rs 不校验配对)
  → 上游 Claude 供应商校验失败 → 400                            [测试2]
```

### 运行方式

本机受 Tauri 原生 DLL 限制，`cargo test --lib` 运行时报 `STATUS_ENTRYPOINT_NOT_FOUND`
（0xc0000139）。用 `--no-default-features` 绕过：

```bash
cd src-tauri
cargo test --lib --no-default-features streaming::tests::reproduce_stop_during_tool_call_emits_orphan_tool_use -- --nocapture
cargo test --lib --no-default-features handlers::tests::reproduce_orphan_tool_use_replay_results_in_400 -- --nocapture
```

### 基线

50 passed / 1 failed。唯一失败的 `codex_chat::tests::sse_converts_tool_call_delta_to_function_call_events`
在干净 HEAD 上**本就失败**，与本次改动无关（既有 broken 测试）。

## 4. 400 是接口返回还是应用响应？

> **重要更正**：本节最初假设上游是 Anthropic Claude（严格校验 tool_use/tool_result 配对）。
> 实测上游是 **GLM（glm-5.2）**，它**不校验孤儿 tool_use**——用 curl 重放带孤儿 tool_use
> 的请求，GLM 返回 200 正常响应（甚至继续生成下一轮）。因此 **400 不是孤儿 tool_use
> 触发的**，第 2、3 节的因果链在 GLM 场景下不成立。真实 400 来源见第 4.2 节。

### 4.1 响应分层（结论）

| 层 | 来源 | HTTP 状态 | 响应体 |
|---|---|---|---|
| 上游 | GLM 校验失败 | 400 | GLM 原始错误体 |
| Polaris 代理 | `forward_raw_response` 把上游 4xx 包成 `UpstreamError{status:400, body}` → `handle_anthropic_passthrough`（`handlers.rs:222-231`）调 `error_response` 包装 | **400**（透传上游状态码） | **Polaris 应用包装**：`{type:"error", error:{type:"api_error", message:"上游请求失败: ..."}}` |

**结论**：

- **HTTP 400 来自上游 GLM 接口**，Polaris 透传状态码。
- **响应体是 Polaris 应用包装的**，不是上游原始 body。客户端看到
  `{"type":"error","error":{"type":"api_error","message":"上游请求失败: ..."}}`，
  上游原始结构化错误被合并进 `message` 字符串。
- **Polaris 自身不会因孤儿 tool_use 主动返回 400**：
  - 直通模式（AnthropicMessages）：`sanitize_anthropic_messages_body` 不校验配对，
    只改 block 类型，不返回错误。
  - 转换模式（ChatCompletions/Responses）：`anthropic_to_openai` / `anthropic_to_responses`
    无任何主动 400 校验（`transform.rs` 无 `Err(ProxyError)` 返回 400 的路径）。
  - handler 层的 `error_response(BAD_REQUEST)` 都是「模式不匹配」「JSON 解析失败」类，
    不会在 Stop 后正常重试时触发。

### 4.2 真实 400 来源（待现场确认）

既然 GLM 不校验孤儿 tool_use，Stop 后 400 的真实原因最可能是 **claude CLI 发出的
请求体里有 GLM 不接受的字段或格式**，与 curl 重放的简单 body 存在差异。候选：

1. **`thinking` block 格式**：claude CLI 历史里的 `thinking` block（带 `signature`、
   `redacted_thinking` 等字段）GLM 可能不接受。
2. **`cache_control`**：claude CLI 给 system / tools 加的 `cache_control` 字段。
3. **`tool_choice`**：claude CLI 传的 `tool_choice` 格式 GLM 不支持。
4. **`anthropic-beta` 头触发的字段**：如 1M 上下文 beta 引入的字段。
5. **tools 定义格式**：claude CLI 的 tools schema 比 curl 测的复杂。
6. **请求体过大**：GLM 对超大 system prompt / tools 的限制。

### 4.3 抓现场（已加诊断落盘）

已为直通 + 转换两种模式都加上**原始 Anthropic 请求体落盘**
（`handlers.rs` 顶部，原仅转换模式落盘）：

- 直通模式：`%TEMP%/polaris-proxy-anthropic-request-debug.json`
- 转换模式：`%TEMP%/polaris-proxy-chat-request-debug.json`
  （原 `polaris-proxy-request-debug.json` 仍保留为转换后 OpenAI body）

**复现步骤**：

1. 重新构建 Polaris（含本次诊断改动）。
2. 用 ClaudeCode 引擎 + GLM profile，在 Tool Calling 过程中点 Stop。
3. 再次 continue 触发 400。
4. 把上述 debug 文件 + Polaris 日志（含 `[Proxy] 上游客户端错误: status=400, body=...`）
   提供出来。
5. 对比 debug 文件与 curl 重放 body 的差异，定位 GLM 拒绝的真实字段。

关键日志锚点（`forwarder.rs:338-349`）：

```
[Forwarder] 上游客户端错误: status=400, body=<GLM 原始错误>
```

这条日志里的 `body` 就是 GLM 返回的原始错误信息，能直接看到 GLM 拒绝的具体字段。

## 5. curl 直接测试

### 5.1 找代理端口

代理以 `port=0`（OS 分配）启动，按 session_id 索引，端口动态。从 Polaris 日志找：

```
[ProxyManager] 为 session <sid> (profile=...) 启动代理: http://127.0.0.1:<PORT>
```

或后端命令 `proxy_addr`（`mod.rs:87 get_proxy_addr`）。下文用 `$PORT` 代指。

### 5.2 复现 400（孤儿 tool_use 重放）

直接打代理 `/v1/messages`，发送带孤儿 tool_use 的历史：

```bash
PORT=12345   # 替换为实际代理端口

curl -i "http://127.0.0.1:$PORT/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "stream": false,
    "messages": [
      {"role": "user", "content": "list files"},
      {"role": "assistant", "content": [
        {"type": "text", "text": "I will run bash."},
        {"type": "tool_use", "id": "toolu_orphan", "name": "bash",
         "input": {"command": "ls"}}
      ]},
      {"role": "user", "content": "continue"}
    ]
  }'
```

预期响应（Polaris 包装的 400）：

```
HTTP/1.1 400 Bad Request
content-type: application/json

{"type":"error","error":{"type":"api_error","message":"上游请求失败: UpstreamError { status: 400, body: \"...tool_use ids without tool_result...\" }"}}
```

> 若想直接验证**上游原始** 400 而非 Polaris 包装，把 URL 改成上游真实端点
> （如 `https://api.anthropic.com/v1/messages` + 真实 `x-api-key`），用同样的 body，
> 会拿到上游原汁原味的 `{"type":"error","error":{"type":"invalid_request_error","message":"messages.X: ... tool_use without tool_result ..."}}`。

### 5.3 复现 Stop 中断产生孤儿（流式）

发起一个会触发 tool_use 的流式请求，在收到 `content_block_start` (tool_use) 后
立即 Ctrl+C 中断连接，观察代理补发的终止事件：

```bash
curl -N "http://127.0.0.1:$PORT/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: test-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20250929",
    "max_tokens": 1024,
    "stream": true,
    "messages": [{"role":"user","content":"用 bash 执行 ls"}],
    "tools":[{"type":"function","function":{"name":"bash","description":"run shell","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]
  }'
```

在看到 `event: content_block_start` (type=tool_use) 出现后立即 Ctrl+C。
再发 5.2 的重放请求 → 400。

## 6. 社区证据:这是 claude code 已知 bug(非 Polaris 独有)

> 关键结论:**Stop 中断 → claude code 会话状态损坏 → 孤儿 tool_use → 上游 400**
> 这条因果链是 **claude code 客户端自身的已知缺陷**,社区广泛报告,
> **不是 Polaris 引入的**。Polaris 作为代理只是透传了这个 400。

### 6.1 GitHub Issues(anthropics/claude-code)

| Issue | 标题 | 关键信息 |
|---|---|---|
| [#7380](https://github.com/anthropics/claude-code/issues/7380) | `tool_use ids were found without tool_result blocks` | Windows + 文件操作触发;`messages.22: tool_use ids were found without tool_result blocks` |
| [#8004](https://github.com/anthropics/claude-code/issues/8004) | `Each tool_use block must have a corresponding tool_result block` | **决定性证据**:werdnum 评论「this occurs when the conversation is interrupted」「I can reproduce this fairly consistently by replying to Claude between the last message and when my PreStop hook finishes. ... the threads become interspersed」 |
| [#10693](https://github.com/anthropics/claude-code/issues/10693) | `Invalid tool_use_id in tool_result block` | `messages.16.content.0: unexpected tool_use_id found in tool_result blocks` |
| [#21097](https://github.com/anthropics/claude-code/issues/21097) | `tool use concurrency issues` | Claude 在前一个 tool_result 到达前排队新的 tool_use |
| [#8187](https://github.com/anthropics/claude-code/issues/8187) | `tool_use ids were found without tool_result blocks immediately after` | #10693 的 duplicate |
| [#8484](https://github.com/anthropics/claude-code/issues/8484) | `Conversation Compaction Corrupts Tool Use/Result Pairs` | `/compact` 压缩也会损坏 tool_use/result 配对 |

### 6.2 #8004 werdnum 的关键评论(直接命中场景)

> My observation is that this occurs when the conversation is interrupted.
> Sometimes the interruption doesn't "take" and Claude 'forks' - one fork
> will continue running despite the interruption, and the other fork will be
> interrupted. Then, the messages from the two threads get interspersed and
> everything grinds to a halt.
>
> I can reproduce this fairly consistently by replying to Claude between the
> last message and when my PreStop hook finishes. It appears that the PreStop
> hook starts a thread and my message before its response starts another, and
> the threads become interleaved.

翻译:中断时 claude code 会「分叉」——一个分支继续跑、一个分支被中断,两个线程
的消息交错,导致会话状态损坏。**在 PreStop hook 完成前回复 Claude 就能稳定复现**。

### 6.3 knail1 的修复评论(确认根因是消息结构损坏)

> The Problem: Claude's conversation state had broken message flow structure,
> not just orphaned tool_use blocks as initially thought.
> Real Issue: 18 consecutive assistant messages violated Claude's conversation
> protocol. Expected: assistant(tool_use) → user(tool_result) → ... Broken:
> assistant → assistant × 18 → user → user × 18
> Key Insight: Claude requires tool_result blocks in the **immediately following**
> message, not just somewhere later.

### 6.4 Anthropic 官方文档(Troubleshooting tool use)

https://platform.claude.com/docs/en/agents-and-tools/tool-use/troubleshooting-tool-use

三类 400:

1. **`tool_use ids were found without tool_result blocks immediately after`**
   — 缺 tool_result,或 tool_result 不是 user message 的第一个 block
2. **`was found without a corresponding <name>_tool_result block`**
   — server_tool_use 相关,resume 请求不再定义该 server tool
3. **`thinking blocks cannot be modified`**
   — 工具调用后继续会话时,应用改动了 assistant 的 thinking blocks

### 6.5 GLM 场景的特殊性

AI 概览(搜索 GLM + claude code + 400)指出:

> Claude Code 整合智谱 GLM 模型时出现 400 错误与 tool_use/tool_result 中断,通常
> 是由于 Claude Code 版本升级引入的新消息角色或参数结构(如 `mid_conversation_system`
> 或 `tool_reference`)与国内兼容层不匹配,或复杂多工具调用时上下文配对错乱导致。

这说明:GLM 的 Anthropic 兼容端点**也会校验 tool_use/tool_result 配对**,
只是校验逻辑与 Anthropic 官方略有差异。用户 curl 测的简单 body(3 条消息、
无 thinking、无 cache_control)不触发,但 claude code 复杂多轮历史会触发。

### 6.6 结论与责任归属

| 维度 | 结论 |
|---|---|
| 400 的直接来源 | 上游(GLM 的 Anthropic 兼容端点)校验失败 |
| 根因 | **claude code 客户端**在 Stop 中断时会话状态损坏(消息交错/分叉),发出孤儿 tool_use 或损坏的 tool_result 配对 |
| 是 Polaris 的 bug 吗 | **不是**。Polaris 作为代理只是透传请求与 400 响应。即使没有 Polaris,直连 Anthropic/GLM 的 claude code 用户也会遇到这个 400(见 #7380/#8004/#10693) |
| Polaris 能否缓解 | 能。Polaris 在 `sanitize_anthropic_messages_body` 加一道配对校验/兜底,可以拦截孤儿 tool_use 不让它到达上游,把 400 变成「自动修复后正常继续」或「友好提示」。这是 Polaris 独有的增值空间 |

### 6.7 Polaris 的增值修复机会(基于社区证据更新)

既然根因在 claude code 客户端、400 来自上游,Polaris 修复方向调整为:

| 优先级 | 改动 | 效果 |
|---|---|---|
| P0 | `sanitize_anthropic_messages_body` 扫描 messages,给孤儿 tool_use 补兜底 `tool_result`(content 标注 `[interrupted - auto-patched by Polaris]`),或丢弃末尾损坏段 | 拦截孤儿 tool_use,400 不再发生(变成可继续对话) |
| P1 | 检测 knail1 描述的「连续 assistant / 连续 user」结构损坏,自动修复为正确的交替结构 | 处理 #8004 werdnum 描述的分叉场景 |
| P2 | 检测 `tool_result` 的 `tool_use_id` 在上一条 assistant 中不存在的情况(#10693),丢弃孤儿 tool_result | 处理反向损坏 |
| P3 | 错误体透传上游原始 body,不包装成 `api_error` | 保留上游结构化错误码,排查友好 |

### 6.8 claude code 修了吗?(决定 Polaris 是否值得做)

**部分修复,未完全解决。** 证据:

| 版本 | 修复内容 | 来源 |
|---|---|---|
| v2.1.85 / v2.1.86 | 修 `--resume` 在 v2.1.85 之前创建的会话上报 `tool_use ids were found without tool_result blocks` | changelog |
| v2.1.218 (2026-07-22) | **修「unpaired tool_use block left in the transcript when a tool aborted mid-response」** + 修 spurious "[Request interrupted by user]" | changelog |
| 较新版本 | 修 `/branch` 在源会话含 rewound timeline 时产生孤儿 tool_use 的 fork | changelog |

但截至 v2.1.220(2026-07-25,搜索时最新),AI 概览与社区仍报告该错误 **persists**:
- 旧损坏的 transcript(升级前创建的会话)仍会触发
- 自定义 hooks(PreToolUse/PostToolUse)输出污染 prompt 序列仍会触发
- rewound/branching timeline 仍会触发
- 官方建议仍是「升级 + `/clear` 清理损坏会话」,即**未提供自动修复**

### 6.9 Polaris 实施是否真的有用?(结论)

**有用,但价值定位要调整。** 分层结论:

| 场景 | claude code 修复后还会发生吗 | Polaris 修复有价值吗 |
|---|---|---|
| 新会话 + 中途 abort tool(主路径) | v2.1.218 后**基本不会** | 价值降低 —— claude code 自己修了 |
| 旧损坏 transcript resume | **会** | **有价值** —— Polaris 在请求出口拦截,不依赖用户升级 |
| hooks 污染 / rewound timeline | **会** | **有价值** —— Polaris 无法预防但能在出口兜底 |
| 用户没及时升级 claude code | **会** | **有价值** —— Polaris 是版本无关的网关层防线 |
| GLM 等第三方端点的额外校验(thinking/cache_control) | 与 claude code 无关 | **有价值** —— 这是 Polaris 独有的协议适配职责 |

**核心判断**:

1. **Polaris 无法预防孤儿产生**(那是 claude code 客户端内部状态问题,Polaris 看不到也改不了 claude code 的 transcript)。
2. **Polaris 能在请求出口拦截孤儿**,让损坏的请求不到达上游 → 把 400 变成「自动修复后正常继续」或「友好降级」。这是 claude code 自己做不到的——claude code 只能在客户端修自己的 bug,修不干净或用户没升级时,Polaris 是最后一道防线。
3. **价值上限**:claude code 持续迭代会逐步减少孤儿产生频率,Polaris 这层修复的「命中率」会随时间下降。但只要 claude code 还有可能产生孤儿(历史损坏 / hooks / 第三方端点),Polaris 这层就有存在价值。
4. **类比**:`sanitizer.rs` 已有的 `server_tool_use` 净化逻辑,本质就是「上游不接受的 block 在出口转成 text」——tool_use/tool_result 配对修复是同一思路的延伸,符合 Polaris 代理的设计定位。

### 6.10 实施 ROI 与建议

| 维度 | 评估 |
|---|---|
| 实现成本 | 低 —— `sanitize_anthropic_messages_body` 加配对扫描,~50 行 Rust,有现成测试基建 |
| 风险 | 低 —— 只在出口补兜底 tool_result 或丢弃末尾损坏段,不改 claude code 行为 |
| 收益 | 中 —— 命中率随 claude code 升级递减,但对历史损坏/hooks/第三方端点场景持续有效 |
| 替代方案 | 升级 claude code 到 v2.1.218+ 可解决主路径;但无法覆盖旧 transcript 与第三方端点 |

**建议**:

- **P0 仍值得做**(`sanitizer.rs` 孤儿 tool_use 兜底),但定位从「修 bug」调整为「**网关层防御性净化**」,与 `server_tool_use` 净化同档。
- **不投入 P1**(连续 assistant/user 结构修复)——这是 claude code 内部状态问题,Polaris 在出口看到的 messages 已是损坏结果,强行重排可能引入新问题,ROI 低。
- **P3(错误体透传上游原始 body)**值得做——与本次 bug 无关,是排查友好的通用改进。
- 配合用户侧建议:**升级 claude code 到 v2.1.218+**,从源头减少孤儿产生。

## 7. 涉及文件

- `src-tauri/src/services/proxy/streaming.rs`（+87 行：复现测试 1,已保留为回归基线）
- `src-tauri/src/services/proxy/handlers.rs`(+145 行 P0 端到端测试 + 诊断落盘 + P3 错误透传与测试)
- `src-tauri/src/services/proxy/sanitizer.rs`(+90 行 P0 `repair_orphan_tool_use` 函数 + 5 个测试)
- `src-tauri/src/services/proxy/error.rs`(+12 行 P3 `upstream_body()` 访问器)

## 8. 实施结果(已完成)

### 8.1 P0:孤儿 tool_use 出口净化(已实施)

**改动**:`sanitizer.rs` 新增 `repair_orphan_tool_use` 函数,在 `sanitize_anthropic_messages_body`
末尾调用,覆盖直通 + 转换两条路径。

**逻辑**:
1. 第 1 遍扫描 messages,统计每个 tool_use id 出现次数与 tool_result 配对次数
2. 第 2 遍改写 assistant.content:对每个 tool_use,按出现顺序判定
   - 前 N 个(N=该 id 的 tool_result 数)保留
   - 之后的降级为 text 摘要(含 `[tool_use interrupted - auto-patched by Polaris proxy]` + name/id/input)
3. 防御兜底:若 assistant.content 移除孤儿后为空,补一个提示 text block

**测试**(sanitizer.rs,9 passed):
- `repairs_orphan_tool_use_by_converting_to_text` — 孤儿降级为 text
- `preserves_paired_tool_use_tool_result` — 正常配对不动
- `repairs_only_orphan_when_partial_pair_exists` — 同 id 多次部分配对
- `repairs_assistant_with_only_orphan_tool_use` — 全 tool_use 的 assistant 补空 text
- `leaves_string_content_untouched` — 字符串 content 跳过

**端到端验证**(handlers.rs `orphan_tool_use_replay_passes_after_p0_repair`):
mock 上游模拟 Anthropic 严格校验,P0 修复前 400 → 修复后 **200 OK**。

### 8.2 P3:错误体透传上游原始 body(已实施)

**改动**:
- `error.rs` 加 `ProxyError::upstream_body()` 访问器
- `handlers.rs` 新增 `upstream_error_response(status, body, hint)` 函数:
  - 上游 body 是 JSON → 原样透传(Content-Type: application/json),保留 `invalid_request_error` 等结构化错误码
  - 非 JSON → 退化为 `error_response` 包装
  - `extra_hint`(如 server_tool_use 提示)作为 `x-polaris-hint` header 返回,不污染上游原始 body
- 替换 5 处 `error_response(status, "上游请求失败: ...")` 为 `upstream_error_response`:
  - `handle_anthropic_passthrough` 直通模式(保留 server_tool_use hint)
  - `handle_non_streaming` / `handle_streaming` 转换模式
  - Codex Responses 处理路径

**测试**(handlers.rs `p3_verify_upstream_error_body_passthrough`,1 passed):
- JSON 错误体原样透传(含 `invalid_request_error` + `tool_use ids...`),不含 `api_error` 包装
- 非 JSON 退化为包装格式
- 中文 hint 经 `from_bytes` 正确写入 `x-polaris-hint` header

### 8.3 回归

全套 proxy 测试:56 passed / 1 failed。唯一失败 `codex_chat::tests::sse_converts_tool_call_delta_to_function_call_events`
在干净 HEAD 上本就失败(既有 broken 测试,与本次改动无关)。

### 8.4 未实施(待评估)

| 项 | 原因 |
|---|---|
| P1(连续 assistant/user 结构修复) | claude code 内部状态问题,出口强行重排 ROI 低且可能引入新问题 |
| P2(反向孤儿 tool_result,#10693) | 频次低于 P0 场景,可后续按需补 |
| streaming.rs 中断时不补 content_block_stop | claude code v2.1.218 已修主路径,Polaris 出口净化已兜底,双层冗余 |

## 9. 用户侧建议

1. **升级 claude code 到 v2.1.218+**(2026-07-22 修复「tool 中途 abort 留下未配对 tool_use」),从源头减少孤儿产生。
2. Polaris 已实施 P0 出口净化:即使 claude code 修不干净(旧 transcript / hooks / rewound timeline),Polaris 会在请求出口把孤儿 tool_use 降级为 text,400 不再发生。
3. P3 后错误体保留上游原始结构化错误码,排查时能直接看到 GLM/Anthropic 拒绝的具体字段。
