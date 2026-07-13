# SimpleAI 压缩修复 + 内容字段兼容 + maxTokens/contextWindow 配置（最终版实施方案）

> 状态：**最终版，待指令实施**。
> 依据：2026-07-13 ding 网关（`120.79.164.155:9850`）实测 + 全链路代码走读 + 用户实测反馈（窗口普遍支持 1M，不可写死，须可配置）。
> 探测脚本可复跑：`.polaris/tmp/probe_providers.py`、`probe_more.py`。

---

## 〇、结论摘要

| 事项 | 结论 |
|---|---|
| 新配置字段 | `ModelProfile` 增加 **`maxTokens`**（单次输出上限）与 **`contextWindow`**（上下文窗口，驱动压缩触发）两个可选字段，前端表单高级选项区可编辑 |
| 窗口默认值 | `DEFAULT_CONTEXT_WINDOW` 由写死 128_000 改为 **1_000_000**（用户实测供应商普遍支持 1M）；小窗口供应商用户按 profile 配小即可，不影响可用性 |
| 压缩修复 | 触发指标改为**最近一轮 input_tokens**；压缩后清零防连触 + 无效即熔断；范围选择重构为**尾部保留 K 条**（修复单 user agentic 场景压不到的缺陷） |
| 内容丢失修复 | 流式 thinking 兼容 `reasoning_content → reasoning → thinking`；摘要请求显式 max_tokens + 截断检测重试；SSE `data:` 宽松匹配 |
| 不改 | `services/proxy/*`（claude/codex CLI 转发路径，且当前有未提交改动）；reasoning 不回传历史的现状（DeepSeek 约束） |

### 已定案的决策（原待确认项）

1. ✅ 压缩范围新语义：user 任务描述可进入摘要（codex 同款，摘要指令保留 task state）。
2. ✅ 尾部保留 `COMPACT_KEEP_RECENT=6`，custom_env `SIMPLE_AI_COMPACT_KEEP_RECENT` 可覆盖。
3. ✅ `contextWindow` 做成正式字段（本轮用户反馈），默认 1M，可配置。
4. ✅ 一次 PR 全做（P0+P1+P2，改动互相关联，均在 SimpleAI 自有模块内）。

---

## 一、实测证据（依据）

### 1.1 网关模型流式 delta 字段矩阵

| 模型 | 内容字段 | 思考字段 | 现状 |
|---|---|---|---|
| qusc / glm-5.2 / deepseek-v4-flash | `content` | `reasoning_content` | ✅ 已支持 |
| **sensenova-6.7-flash-lite** | `content` | **`reasoning`** | ❌ 思考全部静默丢失（实测 1869 字符） |
| gpt-5.5 / 5.4 / 5.4-mini / 5.6-sol | `content` | 无 | ✅ 正常 |
| gpt-5.6-luna / ZhipuAI/GLM-5.2 | — | — | 网关 404 / 502（供应商侧） |

### 1.2 非流式（compact 摘要场景）

- qusc 预算充足（`finish=stop`）：`content` + `reasoning_content` 均在，正常。
- qusc 被截断（`finish=length`）：message **只有 `reasoning` 字段、无 `content` key** → 现有 `extract_summary_text` 拿空 → 静默 fallback。
- `build_openai_chat_body` 目前不传 `max_tokens`（网关默认宽松），Anthropic 分支写死 8192，Responses 分支未设输出上限。

### 1.3 Anthropic 协议

- qusc / glm-5.2 流式：标准 `thinking`/`text` block，现有解析完整支持。
- gpt-5.6-terra 流式：稳定 500/超时（网关 Responses 桥故障，**模型特异，非 Polaris 问题**）。

### 1.4 压缩误触发（日志复盘）

单轮实际 input 仅 37,728，但 `UsageAccumulator.total_input` 把单条用户消息内 8+ 轮工具循环的 input 重复累加到 325,017，对比写死的 window=128,000 → 从约第 3 轮起**每轮误触发**；压缩区间退化为"上次 summary 自摘要"（1条→1条），压后 input 反升，每轮空耗 ~4.5s。用户实测供应商窗口普遍为 1M，写死 128k 双重错误（指标错 + 窗口错）。

---

## 二、配置字段：maxTokens + contextWindow

### 2.1 后端字段 — `src-tauri/src/models/config.rs`（ModelProfile，serde camelCase）

```rust
/// 单次响应输出 token 上限（max_tokens）。
/// - None：OpenAI/Responses 协议不发该字段（供应商默认）；Anthropic 协议回退 8192（必填）。
/// - Some(v)：三协议均显式携带。
#[serde(default, skip_serializing_if = "Option::is_none")]
pub max_tokens: Option<u64>,
/// 上下文窗口（token），驱动 SimpleAI 压缩触发阈值（window × 0.75）。
/// None → SIMPLE_AI_CONTEXT_WINDOW（custom_env，向后兼容）→ 默认 1_000_000。
#[serde(default, skip_serializing_if = "Option::is_none")]
pub context_window: Option<u64>,
```

旧配置无字段 → 反序列化 `None` → **零迁移**。profiles 随 config 整体序列化持久化，无 command 层白名单需要同步。

### 2.2 生效规则

**maxTokens**（进请求体）— `build_request_body` 加第 5 参 `max_tokens: Option<u64>`（生产调用点仅 chat_loop.rs:147、compact.rs:102；另 4 处测试同步）：

| 协议 | 规则 |
|---|---|
| OpenAIChat | `Some(v)` → `body["max_tokens"] = v`；`None` → 不发（现状）。只发 `max_tokens` 不发 `max_completion_tokens`（ding 网关实测认前者，双发有冲突风险） |
| Anthropic | `body["max_tokens"] = v.unwrap_or(8192)`（替换写死的 `DEFAULT_MAX_TOKENS`） |
| Responses | `Some(v)` → `body["max_output_tokens"] = v`（当前完全未设，补齐） |

主对话传 `profile.max_tokens`；compact 摘要**不用** profile 值，用独立预算（见 3.4）。

**contextWindow**（不进请求体，仅压缩触发）— `chat_loop.rs` 窗口解析改为三级优先：

```rust
/// 默认上下文窗口：1M（用户实测主流供应商普遍支持；小窗口供应商在 profile 配小即可）。
pub(super) const DEFAULT_CONTEXT_WINDOW: u64 = 1_000_000;

let context_window = profile.context_window                       // 1. profile 正式字段（新）
    .filter(|v| *v > 0)
    .unwrap_or_else(|| read_env_u64(                              // 2. custom_env 兼容旧配置
        &profile.custom_env, "SIMPLE_AI_CONTEXT_WINDOW",
        compact::DEFAULT_CONTEXT_WINDOW,                          // 3. 默认 1M
    ));
```

**生效范围仅 SimpleAI 引擎**。claude/codex CLI 的代理转发（`services/proxy/*`）不注入：CLI 自主控制，转发层篡改有截断风险，且该目录当前有未提交改动，不触碰。

### 2.3 前端 — 类型 / store / 表单

- `src/types/modelProfile.ts`：`ModelProfile` / `CreateModelProfileParams` / `UpdateModelProfileParams` 各加 `maxTokens?: number` 与 `contextWindow?: number`。
- `src/stores/modelProfileStore.ts`：`addProfile` 白名单加两行；`updateProfile` 是 spread 合并，不需要改。
- `src/components/Settings/tabs/ModelProviderTab.tsx`（触点：`ProfileForm`/`EMPTY_FORM`/编辑回填 ~395 行/两处提交组装 ~149、~990 行/高级选项区 ~789 行）：
  - `ProfileForm` 加 `maxTokens: string`、`contextWindow: string`（表单态存字符串），`EMPTY_FORM` 初始 `''`。
  - 高级选项区并排两个 `<input type="number" min="1">`：
    - maxTokens placeholder："留空 = 供应商默认（Anthropic 协议为 8192）"
    - contextWindow placeholder："留空 = 1,000,000（1M）"
  - 提交组装：`parseInt` 后 `> 0` 才写入，否则 `undefined`（不落盘）。
- i18n：`locales/zh-CN|en-US/settings.json` 加 `modelProfile.maxTokens`、`modelProfile.contextWindow` + 各自 placeholder，共 4 key × 2 语言。

### 2.4 配置建议（ding 网关）

- profile #4（qusc）：`maxTokens=16384`（reasoning + 正文富余）或留空；`contextWindow` 留空（1M）。
- profile #5（anthropic 协议）：maxTokens 按所选模型上限配置，留空维持 8192。

---

## 三、修复方案（最终版）

### 3.1 触发指标改造（P0）— `compact.rs`

```rust
pub(super) struct UsageAccumulator {
    pub total_input: u64,   // 仅统计/日志（花费口径），不再参与触发
    pub last_input: u64,    // 触发依据：最近一轮 usage.input_tokens ≈ 当前上下文大小
}

impl UsageAccumulator {
    pub fn add(&mut self, input_tokens: u64) {
        self.total_input = self.total_input.saturating_add(input_tokens);
        self.last_input = input_tokens;
    }
    /// 压缩后清零，待下一轮真实 usage 重新填充（天然一轮冷却）。
    pub fn reset_last(&mut self) { self.last_input = 0; }
    /// last_input 为 0（尚无 usage 或供应商不回 usage）时用字符估算兜底（总字符 / 4）。
    pub fn should_compact(&self, window: u64, messages: &[Value]) -> bool {
        let current = if self.last_input > 0 { self.last_input } else { estimate_tokens(messages) };
        current >= ((window as f64) * COMPACT_THRESHOLD) as u64
    }
}
```

对齐业界：codex-rs 以最近请求 prompt tokens 对比窗口触发；Claude Code 以当前上下文用量（~92%）触发。均不用跨轮累计值。

### 3.2 防循环熔断（P0）— `chat_loop.rs`

```rust
let mut rounds_since_compact: Option<u32> = None;  // None = 本 turn 尚未压过
let mut compact_exhausted = false;

// 循环内、发请求前：
if !compact_exhausted && usage_acc.should_compact(context_window, messages) {
    if rounds_since_compact == Some(1) {
        // 上一轮刚压缩过、新 usage 仍超阈 → 压不动，本 turn 熔断，仅靠 truncate 兜底
        compact_exhausted = true;
        tracing::warn!("[SimpleAI] 压缩无效（input 未降），本轮任务内不再压缩");
    } else {
        compact::compact_history(messages, profile, event_callback, session_id).await?;
        usage_acc.reset_last();
        rounds_since_compact = Some(0);
    }
}
// 每轮流结束、usage_acc.add() 之后：
if let Some(r) = rounds_since_compact.as_mut() { *r += 1; }
```

### 3.3 压缩范围重构（P0）— `compact.rs`

**现行缺陷**：`select_compact_range` 以"最近一条 user 之前"为 `end`。最常见的爆窗场景是**单条 user + 长串 assistant/tool 轮**（agentic 任务），此时 `last_user == 1` 直接返回 `None`、真正该压的工具轮一条都压不到；退化场景则反复自摘要。

**新规则**（codex 同语义：全历史可入摘要 + 保留最近交互；user 任务描述进摘要已定案接受）：

```rust
const COMPACT_KEEP_RECENT: usize = 6;  // 尾部保留条数（约 2-3 组工具对），SIMPLE_AI_COMPACT_KEEP_RECENT 可覆盖
const COMPACT_MIN_RANGE: usize = 4;    // 区间小于此规模不值得压（也天然挡住"仅剩上次 summary"的退化）

fn select_compact_range(messages: &[Value]) -> Option<(usize, usize)> {
    let len = messages.len();
    let mut end = len.saturating_sub(COMPACT_KEEP_RECENT);
    // 配对合法性（OpenAI 协议硬约束，违反会 400）：
    // a) 保留区首条不能是孤儿 tool（其 assistant(tool_calls) 被压走）→ 整组回退进保留区
    while end > 1 && role(&messages[end]) == "tool" { end -= 1; }
    // b) 摘要区间尾不能是孤儿 assistant(tool_calls)（其 tool 结果留在保留区）
    while end > 1 && is_assistant_with_tool_calls(&messages[end - 1]) { end -= 1; }
    if end <= 1 || (end - 1) < COMPACT_MIN_RANGE { return None; }
    Some((1, end))  // start=1：system 永不入摘要；上次 [compacted summary] 与新历史合并再摘要（信息演进，非自摘要退化）
}
```

`None` 时**直接跳过本轮压缩**（不发请求、不 fallback）——现行"历史太短→fallback 丢最早 turn"在短历史下丢的是有效上下文，删除该路径；`fallback_drop_oldest` 仅保留给"摘要请求失败"兜底。

### 3.4 摘要请求加固（P1）— `compact.rs`

```rust
const SUMMARY_MAX_TOKENS: u64 = 2048;
const SUMMARY_RETRY_MAX_TOKENS: u64 = 4096;
```

- `request_summary` 经 `build_request_body(..., Some(SUMMARY_MAX_TOKENS))` 显式设预算（不用 profile 值：摘要输出短，独立预算更稳）。
- 截断判定：`finish_reason == "length"`，或 `content` 空/缺失但 `reasoning`/`reasoning_content` 非空（实测 1.2 的截断态特征）。
- 命中截断 → 以 `SUMMARY_RETRY_MAX_TOKENS` + 指令追加"直接输出摘要，不要展示思考过程"重试一次；再失败 → WARN 带原因（替换现在的静默 fallback）+ `fallback_drop_oldest`。

### 3.5 流式 thinking 字段兼容（P0）— `simple_ai_protocol.rs` feed_openai_chat

```rust
let thinking = delta["reasoning_content"].as_str()
    .or_else(|| delta["reasoning"].as_str())      // SenseNova / OpenRouter / xAI / Groq
    .or_else(|| delta["thinking"].as_str());      // 少数变体
```

依序短路取首个非空 str（`reasoning` 为对象的变体 `as_str()=None` 自动跳过，安全）。仅影响 ThinkingEvent 展示，不入历史——与 DeepSeek"多轮回传 reasoning_content 会 400"的约束天然兼容。

### 3.6 非流式提取兼容（P1）— `extract_summary_text`

OpenAIChat 分支：`content` 为 str 直接用；为数组拼 `type=text` 的 parts；空/缺失时按 3.4 截断判定返回带原因的 `Err`（reasoning 内容**不**当摘要用）。

### 3.7 摘要序列化保真（P2）— `compact.rs` history_text 构造

- assistant 带 `tool_calls`：`[assistant] 调用 read_file({"path":"..."})`（每个参数截断 ~200 字符）。
- `tool` 角色：结果截断 ~1000 字符。
- 数组型 content：拼接 text parts。

### 3.8 SSE 宽松匹配 + finish_reason 诊断（P2）— `chat_loop.rs` / `simple_ai_protocol.rs`

- `strip_prefix("data: ")` → `strip_prefix("data:")`（后续已有 `trim`），兼容无空格网关（SSE 规范空格可选）。
- `StreamState` 记录流末 `finish_reason`（OpenAI: `choices[0].finish_reason`；Anthropic: `message_delta.stop_reason`；Responses: `response.incomplete_details`）。`length` 时 WARN"输出被 max_tokens 截断，可在供应商配置中调大 maxTokens"。
- 现有 WARN `"stream 提前结束（无 chunk）"` 是正常结束路径 → 降为 `debug!`。

---

## 四、改动文件清单

| # | 文件 | 内容 | 规模 |
|---|---|---|---|
| 1 | `src-tauri/src/models/config.rs` | ModelProfile + `max_tokens` + `context_window` | ~8 行 |
| 2 | `src-tauri/src/ai/engine/simple_ai_protocol.rs` | build_request_body 签名 + 三协议注入；thinking 兼容；finish_reason；content 数组 | ~50 行 + 单测 |
| 3 | `src-tauri/src/ai/engine/simple_ai/chat_loop.rs` | 窗口三级解析；触发重构 + 熔断；SSE 宽松；日志调级 | ~35 行 |
| 4 | `src-tauri/src/ai/engine/simple_ai/compact.rs` | DEFAULT_CONTEXT_WINDOW=1M；UsageAccumulator；select_compact_range 重构；摘要预算 + 截断重试；提取兼容；序列化保真 | ~90 行 + 单测 |
| 5 | `src/types/modelProfile.ts` | 3 个 interface × 2 字段 | ~12 行 |
| 6 | `src/stores/modelProfileStore.ts` | addProfile 白名单 +2 | 2 行 |
| 7 | `src/components/Settings/tabs/ModelProviderTab.tsx` | 表单态/回填/两处提交/两个数字输入 | ~35 行 |
| 8 | `src/locales/zh-CN、en-US/settings.json` | 4 key × 2 语言 | ~8 行 |

合计约 240 行。**明确不改**：`services/proxy/*`、reasoning 入历史行为、`fallback_drop_oldest` 本体。

---

## 五、兼容性与风险

1. **旧配置零迁移**：无新字段 → `None`。maxTokens 行为与现状一致；contextWindow 走 custom_env → 默认链，**唯一行为变化**是未配置任何窗口时默认从 128k 变 1M（见风险 2）。
2. **默认 1M 对小窗口供应商的影响**：不配置时压缩几乎不触发，长任务最终撞供应商"上下文超限"报错终止——这是明确选择的取舍（用户实测主流已 1M；小窗口用户配置 `contextWindow` 即恢复，**不会完全不能用**）。缓解：finish_reason 诊断（3.8）+ 后续可做"上游 4xx 超限错误提示配置 contextWindow"（本次不做）。
3. **压缩语义变化**：user 消息可进摘要（已定案）。由显式预算 + 截断重试 + 保真序列化对冲质量风险；触发频率从"每轮误触发"收敛到"真正逼近窗口"。
4. **熔断保守性**：压不动时本 turn 放弃压缩，行为等同禁用压缩前，不引入新失败模式。
5. **web-only 打包**：纯数据字段/纯逻辑改动，无 `#[tauri::command]` 变更，不触发 feature 门控。
6. **`cargo test --lib` 本机跑不了**（Tauri DLL）→ `cargo check --lib` + 纯函数单测（protocol/compact 内，不依赖 Tauri）。

## 六、验证计划

**单测**（新增，纯函数）：
- protocol：`reasoning` delta → Thinking；`data:`（无空格）可解析；三协议 max_tokens 注入（Some/None × 3）；finish_reason 记录。
- compact：`should_compact` last_input 触发 / total 不触发 / reset 后不连触 / 估算兜底；`select_compact_range` 单 user 长工具链可选出区间、孤儿配对回退、<4 条 None。

**编译**：`cargo check --lib` + `npx tsc --noEmit`。

**实机**（ding 网关）：
1. sensenova-6.7-flash-lite 对话 → 思考流实时显示（当前完全不显示）。
2. qusc 长 agentic 任务（10+ 工具轮）→ 默认 1M 窗口下不再出现误触发压缩日志；将 `contextWindow` 配为 60000 人为逼近 → 压缩恰好触发一次、压后 input 显著下降。
3. profile 配 `maxTokens=16384` → 日志确认请求体携带；留空 → 不含该字段。
4. 设置页：两个字段保存后重启仍在（config.json 持久化）、留空不落盘。
