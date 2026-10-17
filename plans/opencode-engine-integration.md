# opencode 引擎接入方案

> 目标：把 opencode CLI（v2.0.30，npm 全局包）作为第三个内置 AI 引擎接入 Polaris，支持基础 AI 对话 + 模型选择。
> 与 claude-code / simple-ai 同级，复用 EngineRegistry + AIEvent 管线。

## 一、接入形态

opencode 走**编译期内置引擎**路线（与 ClaudeEngine 同构），新增 `src-tauri/src/ai/engine/opencode.rs`，实现 `AIEngine` trait。

### 与 ClaudeEngine 的差异

| 维度 | ClaudeEngine | OpencodeEngine |
|---|---|---|
| 消息传递 | stdin stream-json（规避 Windows 32K 限制） | 命令行参数 `opencode run "<msg>"`（需处理长消息） |
| 输出格式 | stream-json（`text_delta`/`tool_start`/`tool_end`） | JSONL（`text`/`tool_use`/`step_finish`） |
| 续接标志 | `--resume <id>` | `--session <id>` |
| 事件解析 | `StreamEvent` → `EventParser` | 独立 `OpencodeEvent` → 直接构造 `AIEvent` |
| CLI 检测 | npm 包装脚本 vs 独立 exe 复杂检测 | npm 全局包，直接 `opencode` 命令 |
| 权限 | `--permission-mode bypassPermissions` | `--auto` |
| 模型 | `--model <anthropic-model>` | `--model <provider>/<model>`（如 `opencode/glm-5.3-flash-free`） |

## 二、opencode JSONL 事件 → AIEvent 映射

实测 `opencode run --format json` 输出（逐行 JSONL）：

```
{"type":"step_start", "sessionID":"ses_xxx", "part":{"type":"step-start", ...}}
{"type":"text", "sessionID":"ses_xxx", "part":{"type":"text", "text":"回复内容", "time":{...}}}
{"type":"tool_use", "sessionID":"ses_xxx", "part":{"type":"tool", "tool":"read", "state":{"status":"completed", "input":{...}, "output":"..."}, ...}}
{"type":"step_finish", "sessionID":"ses_xxx", "part":{"type":"step-finish", "reason":"...", "cost":0, "tokens":{"input":101,"output":54,...}}}
{"type":"error", "sessionID":"ses_xxx", "error":{"type":"provider.auth", "message":"...", "status":401}}
```

映射表：

| opencode 事件 | AIEvent | 说明 |
|---|---|---|
| `step_start` | （提取 sessionID 更新映射） | 首行即带真实 sessionID |
| `text` | `AssistantMessage(delta=true)` | `part.text` 为增量文本 |
| `tool_use` (status=running/pending) | `ToolCallStart` | `part.tool` + `part.state.input` |
| `tool_use` (status=completed/error) | `ToolCallEnd` | `part.tool` + `part.state.output` + success 判定 |
| `step_finish` | `Usage` + `Result` | `part.tokens` → Usage；无独立 result，发 Result 结束本轮 |
| `error` | `Error` | `error.message` |
| stdout EOF | `SessionEnd(Completed)` | 无 session_end 事件，EOF 即完成 |

## 三、模型选择

opencode 模型来自 `opencode models` 命令（纯文本一行一个，476 个）。后端新增 Tauri 命令 `get_opencode_models` 解析输出，**免费模型排前**，`opencode/glm-5.3-flash-free` 排第一。

排序规则：
1. `opencode/*-free`（免 key，11 个）—— 按字母序，glm 优先
2. `openrouter/*:free`（免 key，15 个）
3. 其余付费模型（需 API key）

默认模型：`opencode/glm-5.3-flash-free`。

## 四、实现清单

### 后端（src-tauri/src/）

1. **`ai/traits.rs`**：`EngineId` 加 `OpenCode` 变体 + `known()` + `aliases()` + `as_str()` + `display_name()`
2. **`ai/engine/opencode.rs`**（新）：`OpencodeEngine` 实现 `AIEngine`
   - `OpencodeEvent` 枚举解析 JSONL
   - `build_command()`：`opencode run "<msg>" --format json --print --model <m> [--session <id>] --auto`
   - `spawn_event_reader()`：逐行 stdout → `OpencodeEvent` → AIEvent
   - `start_session` / `continue_session` / `interrupt` / `send_input`
   - `metadata()`：能力矩阵
3. **`ai/engine/mod.rs`**：导出 `OpencodeEngine`
4. **`ai/mod.rs`**：导出 `OpencodeEngine`
5. **`lib.rs`**：注册 `OpencodeEngine`（两处：桌面 + web）
6. **`commands/`**：新增 `get_opencode_models` 命令（解析 `opencode models` 输出，排序）

### 前端（src/）

1. **模型选择 UI**：opencode 引擎选中时，从 `get_opencode_models` 拉取模型列表（区别于 claude/simpleai）
2. **引擎元数据消费**：`EngineId` 类型加 `open-code`（已由后端 metadata 自动暴露）

## 五、验收

- [ ] `cargo check` 通过
- [ ] `pnpm exec tsc --noEmit` 通过
- [ ] `pnpm lint` 通过
- [ ] dev 启动后，选择 opencode 引擎 + glm-5.3-flash-free 模型，能完成一次对话
- [ ] 模型列表免费模型排前，glm 排第一

## 六、边界与风险

1. **长消息截断**：opencode 消息走命令行参数，Windows 32767 字符限制。初版接受此限制，超长消息报错提示。后续可探索 stdin 传递。
2. **中断粒度**：opencode 可能有后台服务进程，进程树 kill 需验证是否彻底。用 `--standalone` 模式规避后台服务依赖。
3. **无历史回填**：opencode `--session` 续接会重复计费历史 token；初版当无状态执行器，历史由 Polaris dialogStorage 管。
4. **provider 注入**：初版用免费模型免 provider 配置；后续接 Polaris 模型 profile 需写临时 `opencode.json`。
