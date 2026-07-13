# Claude CLI 斜杠命令集成方案

> 2026-07-14 · 基于 Claude Code CLI **2.1.205** 实测（与 Polaris 完全一致的调用方式：
> `claude -p --verbose --output-format stream-json --input-format stream-json --permission-mode bypassPermissions`，
> 消息经 stdin 以 `{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}` 发送）。
> 原始测试数据见 `temp/slash-test/out/*.jsonl`。

## 1. 核心结论

1. **CLI 在 headless（stream-json）模式下原生支持斜杠命令**：只要用户消息文本以 `/` 开头
   （首字符，不允许前导空格），CLI 就把整条消息按命令解析——包括换行后的内容都会被当作参数。
   **以 `/` 开头的消息永远不会到达 LLM**；未知命令本地返回 `Unknown command: /xxx`（约 40ms，零 API 消耗）。
2. **命令输出以合成 assistant 消息返回**（`message.model == "<synthetic>"`），Polaris 现有解析链
   恰好能渲染 —— 这就是 `/mcp` "碰巧可用"的原因。
3. **`/compact` "有时无效"的两个根因**：
   - 空会话执行返回 `Error: No messages to compact`（assistant 消息，可见）；
   - **成功时的输出全部是 Polaris 当前会丢弃的事件**（见 §3），界面零反馈 → 用户以为没生效。
     实际压缩成功：session_id 不变，续接验证记忆保留。
4. **权威命令清单来自 `system/init` 事件的 `slash_commands` 字段**，每轮对话（每次进程启动）都会下发，
   含内置命令 + skill + 用户自定义命令（`.claude/commands/*.md`）。
   `/reload-skills` 触发的 `system/commands_changed` 事件还带 `description/argumentHint/aliases` 全量元数据。

## 2. 实测命令矩阵（2.1.205）

| 命令 | headless 行为 | 耗时/消耗 | Polaris 现状 | 集成处理 |
|---|---|---|---|---|
| `/mcp` | 本地：MCP server 状态摘要 | ~20ms / 0 | ✅ 可见 | 建议列表 |
| `/mcp reconnect` 等子命令 | 本地报错 "MCP controls aren't available"（TUI 专属） | ~25ms / 0 | ✅ 可见 | 文档注明只读 |
| `/context` | 本地：上下文占用 Markdown 表格 | ~500ms / 0 | ✅ 可见 | 建议列表 |
| `/usage`（别名 `/cost` `/stats`） | 本地：本会话成本/时长统计 | ~30ms / 0 | ✅ 可见 | 建议列表 |
| `/compact [指令]` | **LLM 压缩**：status(compacting) → init → compact_boundary → 摘要回放(user/字符串) → `<local-command-stdout>Compacted</local-command-stdout>` → result(空) | ~7s / 1次摘要调用 | ❌ 成功时不可见 | **事件补齐 + 分隔条渲染 + 建议列表** |
| `/compact`（空会话） | 本地：`Error: No messages to compact`（assistant） | ~20ms / 0 | ✅ 可见 | — |
| `/model` | 本地：显示当前模型与可用别名 | ~25ms / 0 | ✅ 可见 | 建议列表（注明只读；带参设置会被 Polaris 每轮 `--model` 覆盖） |
| `/recap` | 本地/轻量：生成一行会话回顾 | ~70ms | ✅ 可见 | 建议列表 |
| `/clear`（别名 `/reset` `/new`） | 发出 `conversation_reset` 事件 + 空 assistant + 空 result；CLI 侧新开对话 | ~250ms / 0 | ❌ 不可见且 **与 Polaris 界面历史脱钩** | **发送前拦截**，提示改用 Polaris 新建会话 |
| `/rename <名>` | 本地：改 CLI 侧会话名 | ~260ms / 0 | ✅ 可见 | 放行不建议（Polaris 有自己的标题体系） |
| `/config` | 本地：用法 + 可配置键列表；`key=value` 可写 CLI 配置 | ~30ms / 0 | ✅ 可见 | 放行不建议 |
| `/effort` | 本地：用法提示 | ~30ms / 0 | ✅ 可见 | 放行不建议（Polaris 每轮 `--effort` 覆盖） |
| `/color` | 本地：设置 TUI 提示条颜色（对 Polaris 无意义） | ~30ms / 0 | ✅ 可见 | 放行不建议 |
| `/fast` | 本地：`Fast mode is not available in the Agent SDK` | ~20ms / 0 | ✅ 可见 | 放行不建议 |
| `/agents` | 本地：wizard 已移除的说明文本 | ~30ms / 0 | ✅ 可见 | 放行不建议 |
| `/heapdump` | 本地：**向桌面写 .heapsnapshot 文件** | ~2.7s / 0 | ✅ 可见 | 放行不建议（有副作用） |
| `/insights` | **LLM 报告生成**，写 HTML 到用户目录 | **~145s / 1 turn** | ✅ 可见 | 放行不建议（高耗时） |
| `/reload-skills` | 本地：重载 skill + 发 `commands_changed` 事件 | ~45ms / 0 | ✅ 可见 | 放行不建议 |
| skill 命令（`/init` `/review` `/code-review`…） | 展开为 prompt，正常 LLM turn | 正常对话成本 | ✅ 完整渲染 | 已有 skill 建议覆盖 |
| 自定义命令（`.claude/commands/*.md`，实测 `/ping`） | 展开为 prompt，正常 LLM turn | 正常对话成本 | ✅ 完整渲染 | 动态建议（init 清单减去已知项） |
| 未知命令（`/nonexistent`） | 本地：`Unknown command: /xxx` | ~40ms / 0 | ✅ 可见 | — |
| `  /mcp`（前导空格） | 不是命令 → 正常发给 LLM | 正常对话成本 | — | 建议触发条件与 CLI 语义对齐 |

事件形态要点：

- 本地命令输出：`{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"..."}]}}`，
  随后 `result.result` 携带同样文本；**没有 stream_event 增量**。
- `/compact` 成功链：`system/status {status:"compacting"}` → `system/status {status:null,compact_result:"success"}`
  → `system/init`（会话重初始化）→ `system/compact_boundary {compact_metadata:{trigger:"manual",pre_tokens,post_tokens,...}}`
  → user(字符串 content，摘要全文回放) → user(`<local-command-stdout>Compacted </local-command-stdout>`，isReplay:true)
  → `result`（`result` 字段为空）。自动压缩（CLI `autoCompact`，触发时 trigger 为 `auto`）走同一事件链。

## 3. Polaris 解析层现状（缺口定位）

| CLI 事件 | 现有处理（src-tauri/src/ai/event_parser.rs） | 结果 |
|---|---|---|
| assistant（synthetic） | `parse_assistant_event` → AssistantMessage | ✅ 正常渲染 |
| `system/status` | subtype 不在映射表、无 `message` 字段 → 丢弃 | ❌ 压缩进行中无提示 |
| `system/compact_boundary` | 同上 → 丢弃 | ❌ 压缩完成无痕迹 |
| user（字符串 content） | `extract_text_content` 只支持数组 content → 空 → 丢弃 | ➖ 摘要回放不渲染（可接受，避免刷屏） |
| `result`（文本在 `result` 字段） | `parse_result_event` 只读 `output` 字段 → 无 Result 事件 | ➖ 前端本就忽略 result |
| `conversation_reset`（顶层类型） | serde tag 不认识 → parse_line None | ➖ 由发送前拦截规避 |
| init 的 `slash_commands` | 未提取 | ❌ 前端拿不到命令清单 |
| `cli_init` AIEvent | 前端 AIEvent 联合类型缺失 → eventHandler default 警告日志 | ❌ cliInfoStore 的 `listen('cli_init')` 在桌面端收不到（Rust 只 emit `chat-event`） |

## 4. 集成方案（最小改动）

### 4.1 后端（Rust）

1. `models/ai_event.rs`
   - `CliInitEvent` 增加 `slash_commands: Vec<String>`（serde camelCase → `slashCommands`）。
   - 新增 `ContextCompactedEvent { type:"context_compacted", session_id, trigger, pre_tokens, post_tokens }`
     + `AIEvent::ContextCompacted` 变体。
2. `ai/event_parser.rs`
   - `parse_init_event` 提取 `slash_commands`。
   - `parse_system_event`：
     - `status`：`extra.status == "compacting"` → `Progress("🗜️ …")`（瞬态进度条文案）；其余忽略。
     - `compact_boundary`：提取 `compact_metadata` → `ContextCompacted` 事件（手动/自动压缩都覆盖）。

### 4.2 前端

1. `src/ai-runtime/event.ts`：AIEvent 联合类型补 `CliInitEvent`、`ContextCompactedEvent`。
2. `eventHandler.ts`：
   - `case 'cli_init'` → `useCliInfoStore.updateFromInit`（顺带修复既有 default 警告）。
   - `case 'context_compacted'` → `appendContextCompactBlock`。
3. `types/chat.ts`：新增 `ContextCompactBlock { type:'context_compact', id, trigger, preTokens?, postTokens? }`。
4. `createConversationStore.ts`：`appendContextCompactBlock`（无 currentMessage 时自举，复用 finishMessage 提交链）。
5. `chatBlocks/`：`ContextCompactRenderer` —— 居中细分隔条：`⇅ 上下文已压缩 29.7k → 1.0k tokens`。
6. `cliInfoStore.ts`：`slashCommands: string[]` + `updateFromInit` 提取。
7. **命令目录** `src/config/cliSlashCommands.ts`（唯一新增配置文件）：
   - 实测过的内置命令元数据（i18n 描述、argumentHint、`suggest` 分级）；
   - `suggest`: `compact` `context` `usage` `mcp` `model` `recap`；
   - `blocked`: `clear`（+ 别名 reset/new）→ 发送前拦截；
   - 其余：不建议但放行（CLI 自行响应）。
   - 合并 init 动态清单：排除 curated 全集、skillStore 已建议的 skill、`__` 内部命令 → 剩余（自定义命令）以通用描述展示。
8. `ChatInput.tsx`：
   - 仅当活跃会话引擎为 `claude-code` 时，`/` 触发的建议列表插入 CLI 命令组（snippet 之后）；
   - 触发条件与 CLI 语义对齐：只在**输入框首字符**为 `/` 时建议 CLI 命令（任意位置的 `/xxx` 仍走 snippet/skill/MCP 建议）；
   - 选中插入 `/name `（不自动发送）；
   - `handleSend` 拦截 `/clear|/reset|/new`（claude-code 会话）→ toast 提示改用 Polaris 新建会话。
9. `FileSuggestion.tsx`：`SuggestionItem` 增加 `'cli-command'` 类型 + 渲染分支（名称 + 参数提示 + 描述）。
10. i18n：`chat.json`（zh-CN / en-US）补命令描述与压缩分隔条文案。

### 4.3 刻意不做（避免过度设计）

- 不消费 `commands_changed`（init 每轮都发，天然刷新）；
- 不自动把 `/clear` 映射为"新建会话"（涉及会话生命周期副作用，v1 只拦截提示）；
- 不做工具栏压缩按钮 / 上下文用量仪表（后续可基于 `context_compacted` + `/context` 输出做）；
- 不动 `stores/commandStore.ts` + `types/command.ts` 的 `builtinCommands`（无消费者的死代码，命令均为虚构，建议后续清理）；
- 其它引擎（codex/mimo/SimpleAI）不注入 CLI 命令建议（语义不通）。

## 5. 使用建议（给用户）

- **`/compact`**：上下文过长时输入 `/compact`（可带聚焦指令，如 `/compact 保留代码改动相关内容`）。
  压缩约需数秒（一次 LLM 摘要调用），完成后聊天流出现"上下文已压缩"分隔条；session 不变，可继续对话。
  空会话/刚压缩过会返回 "No messages to compact"。
- **`/context`**：查看当前上下文构成（系统提示词/工具/记忆/消息占比）。
- **`/usage`**：查看本会话成本与 token 消耗。
- **`/mcp`**：查看 MCP server 连接状态（只读；重连请在 Polaris 插件面板操作）。
- **`/model`**：查看当前生效模型（切换模型请用 Polaris 的模型 Profile）。
- 消息以 `/` 开头就会被 CLI 当命令解析（多行也一样，换行内容成为参数）。
  注意 Polaris 发送前会对输入做 trim，因此"行首加空格"无法绕过；
  要把以 `/` 开头的内容发给模型，可在前面加任意文字（如 `路径 /etc/hosts ...`），
  或把内容放进代码块/引用附件。
