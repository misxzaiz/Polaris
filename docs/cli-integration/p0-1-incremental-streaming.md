# P0-1：Claude 引擎真增量流式（打字机输出）

> 为 Claude Code 引擎接通 `--include-partial-messages`，实现逐字/分段的打字机式输出，并安全处理流式过程中的不完整 Markdown 渲染。

| 项 | 值 |
|---|---|
| 日期 | 2026-06-06 |
| 状态 | 实施中 |
| 影响层 | Rust 后端（解析 + flag）；前端零改动 |
| 风险 | 低（端点不支持 partial 时自动回退整段） |

---

## 一、问题背景

### 现状（实证）

Polaris 后端对 Claude 引擎固定使用 `--print --output-format stream-json --input-format stream-json`，**但未传 `--include-partial-messages`**。

Claude Code 的 stream-json 输出有两种文本形态：

- **不加** `--include-partial-messages`：每个 assistant turn 只输出一条**完整** `{"type":"assistant","message":{content:[...]}}`（整段）。
- **加** `--include-partial-messages`：额外输出一系列 `{"type":"stream_event","event":{...}}`，内含 Anthropic Messages API 的原始 SSE 增量（`content_block_delta` → `text_delta`），**随后仍会输出一条完整 assistant 消息**。

而 `models/events.rs` 的 `StreamEvent` 解析器只认 `text_delta` 这一**扁平**类型（`#[serde(rename="text_delta")]`），Claude 从不产生它（它出现在 `stream_event.event.delta.type` 里，是嵌套的）。因此：

- `event_parser.rs` 的 `TextDelta` 分支对 Claude 引擎是**死代码**；
- 用户实际体验为"思考中…→整段回复一次性出现"，**无打字机效果**。

### 目标

1. 接通 `--include-partial-messages`，让文本逐段流式渲染。
2. 流式过程中安全渲染不完整 Markdown（未闭合代码块、未配对行内标记、未完成表格/mermaid）。
3. 不破坏现有整段渲染路径，端点不支持 partial 时自动回退。

---

## 二、Claude partial messages 输出结构

一个含 thinking + text + 工具调用的 turn，事件顺序（已加 `--include-partial-messages`）：

```jsonc
{"type":"stream_event","event":{"type":"message_start","message":{...}}}
{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"让我想想"}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":0}}
{"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"# 标题\n"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"正文..."}}}
{"type":"stream_event","event":{"type":"content_block_stop","index":1}}
{"type":"stream_event","event":{"type":"message_delta","delta":{"stop_reason":"tool_use"}}}
{"type":"stream_event","event":{"type":"message_stop"}}
{"type":"assistant","message":{"content":[{"type":"thinking",...},{"type":"text",...},{"type":"tool_use",...}]}}  // ← 完整快照，始终发送
{"type":"user","message":{"content":[{"type":"tool_result",...}]}}
{"type":"result",...}
```

> 关键：`stream_event`（增量）与完整 `assistant`（快照）**两者都会发**。若前端对两者都做"追加"，文本会**翻倍**。

---

## 三、核心挑战

| 挑战 | 说明 |
|---|---|
| **文本翻倍** | 前端 `eventHandler` 对 `assistant_message` 无条件 `appendTextBlock`（追加，不读 `isDelta`）。delta 追加一遍 + 完整快照再追加一遍 = 翻倍。 |
| **thinking 顺序** | thinking content block 在 text 之前。若 thinking 仅从完整快照（turn 末）发出、text 走 delta（turn 中），则 thinking 块会错误地出现在 text 块之后。 |
| **thinking 碎片化** | 前端 `appendThinkingBlock` 每次 **push 新块**（不累积）。若直接逐条发 `thinking_delta`，会产生大量 thinking 碎块。 |
| **不完整 Markdown** | 流式中 content 可能是"半截 markdown"（``` 未闭合、`**` 未配对、`[x](` 不完整、表格未画完）。 |

---

## 四、方案设计：后端聚合，前端零改动

### 设计原则

把"去重 + 顺序 + 累积"全部收敛到 Rust 后端，前端沿用现有的"追加累积 + 流式安全渲染"，不改前端逻辑。

### 后端行为（`event_parser.rs`）

引入 per-session turn 状态：

```rust
stream_block_types: HashMap<u64, String>, // content_block index → "thinking"/"text"/"tool_use"
thinking_buffer: String,                  // 累积 thinking_delta
streamed_text_this_turn: bool,            // 本 turn 是否已通过 delta 发过文本
streamed_thinking_this_turn: bool,        // 本 turn 是否已通过 delta 发过 thinking
```

处理 `stream_event.event`：

| event.type | 处理 |
|---|---|
| `message_start` | 重置 turn 状态（清空 buffer/标志/index 表） |
| `content_block_start` | 记录 `index → content_block.type` |
| `content_block_delta` + `text_delta` | 发 `AssistantMessage(text, isDelta=true)`；`streamed_text_this_turn=true` |
| `content_block_delta` + `thinking_delta` | `thinking_buffer += thinking`；`streamed_thinking_this_turn=true` |
| `content_block_delta` + `input_json_delta` | 忽略（工具参数等完整快照统一处理） |
| `content_block_stop` | 若该 index 为 thinking 且 buffer 非空 → 发 `Thinking(buffer)` 整段，清空 buffer |
| 其他（message_delta/stop 等） | 忽略 |

修改完整 `assistant` 消息处理（`parse_assistant_event`）：

- **text**：仅当 `!streamed_text_this_turn` 才发（否则跳过，避免翻倍）；
- **thinking**：仅当 `!streamed_thinking_this_turn` 才发；
- **tool_use**：始终发（`ToolStart`，工具调用从权威快照取）；
- 处理完后**重置 turn 状态**（一条完整 assistant 消息 = 该 turn 输出结束）。

### 为什么 thinking 用"delta 累积 + stop 整段发"

- 在 thinking 的 `content_block_stop`（早于 text delta）时整段发出 → thinking 块顺序正确（在 text 前）；
- 整段一次发 → 不触发 `appendThinkingBlock` 碎片化；
- 与完整快照的 thinking 互斥（`streamed_thinking_this_turn`）→ 不翻倍。

### 前端为何零改动

- delta 文本 → `case 'assistant_message'` → `appendTextBlock`（追加累积）✓
- thinking 整段 → `case 'thinking'` → `appendThinkingBlock`（新块）✓
- 后端保证"要么全 delta、要么一条完整快照"，二者不并存 → 前端无脑追加即正确，无需读 `isDelta`、无需 reconcile。

---

## 五、Markdown 流式渲染策略（重点）

> 结论：前端 `src/utils/lightweightMarkdown.tsx` 已为流式不完整 Markdown 做了完整防御，本方案**直接复用**，前提是传入"累计全量字符串" + `completed={!isStreaming}`——而 `appendTextBlock` 累积的正是全量串，天然满足。

### 渲染链路

```
TextBlockRenderer (completed = !isStreaming)
  → ProgressiveStreamingMarkdown (lightweightMarkdown.tsx)
      ├─ 已完成段落（以 \n\n 切分）→ streamingMdCache.render（marked 完整渲染，带缓存）
      └─ 最后一段（流式中）→ LightweightMarkdown（行内容错渲染）
```

### 不完整 Markdown 的现有防御

| 情形 | 处理 | 位置 |
|---|---|---|
| 未闭合代码块 ``` | 仅匹配已闭合块；残余 ``` 段标 `completed:false`，不吞噬后续内容 | `splitByCodeBlocks` `lightweightMarkdown.tsx:280-400` |
| 行内代码 `` ` `` 未配对 | 降级为纯文本 | `parseInlineMarkdown:122-126` |
| 粗体 `**`/`__` 未配对 | 降级为纯文本 | `parseInlineMarkdown:134-138` |
| 斜体 `*`/`_` 未配对 | 降级为纯文本 | `parseInlineMarkdown:146-149` |
| 删除线 `~~` 未配对 | 降级为纯文本 | `parseInlineMarkdown:167-171` |
| 链接 `[x](` 不完整 | 仅匹配完整链接，否则输出字面 `[` | `parseInlineMarkdown:96-98` |
| Mermaid 未完成 | 流式中绝不自动渲染，仅显示"点击渲染" | `DeferredMermaidDiagram` |
| marked 渲染异常 | try/catch 退化为 HTML 转义 + `<br>` | `cache.ts:473-481` |

### 性能保护（已有，复用）

- **段落级缓冲**：`appendTextBlock` 闭包累积，遇 `\n\n` 或 200ms 超时才写入 Zustand（`createConversationStore.ts:233-261`）——把高频 delta 降频为段落级渲染，是打字机平滑度与性能的平衡点。
- **增量渲染缓存**：`MarkdownRenderCache.renderIncremental` 在"新内容以旧内容为前缀"时只渲染增量并拼接；未闭合代码块时自动放弃增量（`cache.ts:497-517`）。delta 累积始终是全量前缀，命中良好。
- **React.memo 门控**：`AssistantBubble` 流式时只比最后一个 text block 的 `content.length`；非流式永不重渲染。
- **Virtuoso**：流式 `followOutput=true` 瞬时跟随。

### 设计取舍

- **不做字符级逐字动画**：纯逐字重渲染 markdown 抖动大、性能差。段落级 flush + 现有圆点动画已是体验/性能的最优平衡，且让"半截 markdown"窗口最小化。
- delta 的颗粒度由 CLI/模型决定，前端缓冲层会重新归整为段落，无需后端控制颗粒度。

---

## 六、改动清单

| 文件 | 改动 |
|---|---|
| `src-tauri/src/models/events.rs` | `StreamEvent` 新增 `StreamEventChunk { event }`（`rename="stream_event"`） |
| `src-tauri/src/ai/event_parser.rs` | `EventParser` 加 turn 状态字段；`parse()` 加分支；新增 `parse_stream_event_chunk()`；改 `parse_assistant_event()` 去重 |
| `src-tauri/src/ai/engine/claude.rs` | `build_command` 两分支在 `--input-format stream-json` 后追加 `--include-partial-messages` |
| 前端 | 无（复用现有累积与渲染） |

---

## 七、回退与兼容

- 端点不支持流式/partial → CLI 不发 `stream_event` → `streamed_*_this_turn` 恒为 `false` → 完整 assistant 消息照常发 text/thinking → **行为与改动前一致**。
- Codex 引擎走独立 `codex_parser.rs`，不受 `StreamEvent` 新变体影响。
- `StreamEvent` 为 internally tagged enum，新增变体不破坏既有解析；未知 `stream_event` 行此前被静默丢弃，现被正确消费。

---

## 八、验证方法

1. **编译**：`cargo check`（Rust）、`pnpm run build`（tsc + vite）。
2. **真实端点实测**（需可用 Anthropic/兼容端点）：
   ```bash
   claude -p "用 markdown 写一段含代码块和列表的示例" \
     --output-format stream-json --verbose --include-partial-messages
   ```
   确认输出含 `{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta",...}}}`，且末尾仍有完整 `assistant` 消息。
3. **GUI 验证**：发一条会产生长 markdown（代码块 + 表格 + 列表）的消息，观察：① 文本分段流式出现；② 流式中代码块未闭合不破版；③ 结束后渲染与流式态无跳变；④ 内容不翻倍。

> 注：本机当前第三方端点 `coder-model` 处于 `ConnectionRefused`，第 2 步待端点恢复后复验；第 1 步与代码静态正确性不受影响。
