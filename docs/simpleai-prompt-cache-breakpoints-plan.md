# SimpleAI 提示词缓存命中率修复方案

> 状态：**已实施，待线上样本验证**（2026-10-20）
> 范围：`src-tauri/src/ai/engine/simple_ai_protocol.rs`（协议转换层）+ 2 个调用点
> 前置分析：同模型的 SimpleAI 引擎缓存命中率约 50%，Claude CLI 路径约 96%
> 实际收益：消除命中率的随机抖动（0%~70% → 稳定），稳定水位随规模变化（24k≈99%、70.7k≈69%）

---

## 1. 现象

同一模型、同一网关、同一时间窗，两个引擎的缓存命中率相差近一倍：

| model | simple-ai | claude（Claude CLI） |
|---|---|---|
| deepseek-v4-flash | **50.1%** (n=14979) | **96.6%** (n=12159) |
| glm-5.2 | **49.0%** (n=1406) | **97.8%** (n=1608) |
| glm-5.3-flash | — | 94.7% (n=60) |

命中率分布是**尖峰**而非弥散：14974 个样本中 94.6% 落在 45–60% 这一个 5 个百分点的桶内。这不是噪声，是稳定平衡态。

## 2. 根因机制（实测推翻直觉）

**初始假设（错）**：50% 是因为只吃网关自动前缀缓存、命中边界不透明。

**实际机制**：SimpleAI 请求体全程不含 `cache_control`，导致缓存条目不被固定，在网关 LRU 池中随并发请求被驱逐。单次命中率在 0% 与 ~100% 之间随机切换，**均值收敛到约 50%**。加显式断点等于强制保留缓存条目、不驱逐，命中率稳定在 99%。

### 2.1 证据一：同请求体 A/B 重放

取真实持久化会话（30 条消息 / 24k tokens）直接重放网关：

```
无 cache_control:    0.0%   94.2%   4.3%   99.5%   ← 剧烈跳动，均值 ~50%
有断点(2 处):       99.5%   98.7%   99.5%   98.7%   ← 稳定
```

183k tokens 规模重复请求更极端：无断点 `0% → 99.9% → 0%` 交替出现。

**重要补充（70.7k tokens 规模，同规模 A/B 对照）**：

```
无断点:                0.0%   70.2%   48.4%        ← 仍随机抖动
三断点 + thinking:     69.1%   69.4%              ← 稳定
```

结论修正：断点的核心作用是**消除方差**（把 0%~70% 的随机抖动收敛为稳定水位），
而非保证 99%。稳定水位本身随规模与请求形态变化——24k 时约 99%，70.7k 时约 69%
（约 30% 的前缀结构无法进入缓存）。**预期收益按「消除抖动 + 提升均值」评估，
不要按「必定 99%」评估。**

### 2.2 证据二：中段改写算法定位分叉机制

149k tokens 前缀中改写第 k/N 位置，命中率 ≈ k/N%：

| 改写位置 | 命中率 |
|---|---|
| 第 8 / 16 块 | 49.8% |
| 第 3 / 16 块 | 18.5% |
| 只追加新消息（不改写） | 99.9% |

结论：前缀缓存是**扁平精确匹配**，前缀中任一位置被改写则其后全部失效；纯追加不触发失效。

### 2.3 证据三：反例排除「结构性上限」

`simple-ai` 经 glm-5.3-flashx 时 n=85，命中率 **100%，`input_tokens` 恒为 0**。同一条代码路径有能力满命中 → 非代码未接、非网关不支持。

### 2.4 代码侧确认：前缀本身是稳定的

- `build_anthropic_body`（simple_ai_protocol.rs:387）全程零 `cache_control`
- `system` 拼成**字符串**（`system_parts.join("\n\n")`），Anthropic 协议上字符串形态无法挂断点——这是结构性障碍
- 工具顺序确定：内置定序（tools/mod.rs:144-163）+ MCP `cached_specs`（mcp/mod.rs:100）
- system / environment_context / AGENTS.md / skill 索引仅首轮注入，`continue_session` 不重建（agent.rs:342）
- thinking 块只解析上报，不回灌历史

前缀内容稳定 + 无断点 → 问题完全收敛在**缺断点**这一项。

## 3. 修复方案

改动集中在一个函数，共 3 个断点。断点预算：Anthropic 每请求上限 4 个，本方案用 3 个，留 1 个余量。

### 3.1 `system` → block 数组 + 断点

```rust
if !system_parts.is_empty() {
    body["system"] = json!([{
        "type": "text",
        "text": system_parts.join("\n\n"),
        "cache_control": { "type": "ephemeral" },
    }]);
}
```

`system` 是最大且最稳定的块（persona + 首轮注入的环境/项目指令）。

### 3.2 `tools` 末尾 → 断点

```rust
let mut tools = tools_for_protocol(WireProtocol::Anthropic, openai_tools);
if let Some(last) = tools.last_mut() {
    last["cache_control"] = json!({ "type": "ephemeral" });
}
if !tools.is_empty() {
    body["tools"] = json!(tools);
}
```

工具 schema 体量大且会话内不变，是第二大稳定块。

### 3.3 最后一条 `user` → 断点

```rust
if let Some(last) = out.last_mut() {
    if last.get("role").and_then(Value::as_str) == Some("user") {
        match last.get_mut("content") {
            Some(Value::String(s)) => {
                let t = s.take();
                last["content"] = json!([
                    { "type": "text", "text": t,
                      "cache_control": { "type": "ephemeral" } }
                ]);
            }
            Some(Value::Array(arr)) if !arr.is_empty() => {
                if let Some(b) = arr.last_mut() {
                    b["cache_control"] = json!({ "type": "ephemeral" });
                }
            }
            _ => {}
        }
    }
}
```

缓存是前缀式的，在「稳定前缀尾部」打断点 → 下一轮更长的前缀保证命中。这条对 SimpleAI 尤为关键：agent 单 turn 内多轮工具调用，若只靠 system + tools 断点，增长中的历史段仍落回可驱逐的自动缓存，还是会抖。

`content` 两种形态都要处理：纯字符串（普通 user 消息）和 block 数组（tool_result 合并后的形态，见 `build_anthropic_body` 的 tool 合并逻辑）。

### 3.4 兼容性开关

`cache_control` 是 Anthropic 特有字段。本项目的 `wireApi=anthropic-messages` 同时用于对接 DeepSeek / GLM（响应侧已有 `prompt_tokens_details` 兼容层，见 simple_ai_protocol.rs:796），**请求侧会不会被 400 未知**。而 400 会让整个 profile 全挂，比 50% 命中率严重得多。

```rust
fn cache_control_enabled(custom_env: &Option<HashMap<String, String>>) -> bool {
    custom_env.as_ref()
        .and_then(|m| m.get("SIMPLE_AI_CACHE_CONTROL"))
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(true)
}
```

默认开、可关，沿用 `SIMPLE_AI_DISABLE_SUBAGENT` 的既有写法。`build_request_body` / `build_anthropic_body` 需新增 `custom_env` 参数，调用点共 2 处：

- `chat_loop.rs:234`
- `compact.rs:248`

**不做**「失败后自动重试去掉断点」这类自愈逻辑——那是用重试掩盖兼容性问题，违反项目既定纪律（AGENTS.md §二.5）。

## 4. 明确不动的部分

`compact.rs` 的 `drain` + `insert`（602-606）与 `history.rs` 的 `truncate_history_assistant_outputs` **本次不改**：

- 两者都是**一次性分叉**，非每轮分叉。truncate 幂等（截断后加标注，下轮不再超阈值）；compact 仅在窗口达 75%（`COMPACT_THRESHOLD`）时触发一次
- system + tools 被断点固定且字节不变，**compact 发生后这两块仍然命中**——断点本身已大幅抵消 compact 的分叉成本
- compact 的 `start = 1` 已保留 system；实测 354 个会话中 53 个含 `[compacted summary]` 标记，多数插在位置 1，但命中率恒定为 50% 而非随 compact 起伏，说明它不是主因

若命中率提升后仍有残余空间，再动这两处；现阶段改属过度工程。

## 5. 验证

1. `cargo check`（本机 `cargo test --lib` 因 Tauri DLL 无法启动，用 check 兜底）
2. 单测（simple_ai_protocol.rs 测试区段 :1027 之后）：
   - `system` 为数组形态且含 `cache_control`
   - `tools` 末尾含 `cache_control`
   - 断点总数 ≤ 3
   - `SIMPLE_AI_CACHE_CONTROL=false` 时三处均不出现，且 `system` 回退为字符串
3. 线上实测：跑一两个真实会话，查 `usage.db` 中该 profile 的命中率是否从 ~50% 升至 90%+。这是唯一可信判据——网关缓存行为只能实测

### 5.1 已执行的验证（2026-10-20）

**编译**：`cargo check --lib` 通过，`cargo clippy --lib` 对新代码零 warning。
`cargo test --lib` **无法执行**——lib test profile 存在 6 个与本改动无关的既有错误
（`services/git/rebase.rs` 的 `GitRebaseTodoItem` 缺 `PartialEq`、`models/git.rs`、
`services/form_flow.rs`、`ai/engine/simple_ai/tools/plan.rs` 等）。已用 git stash
对比基线确认：我的三个文件引入**零新增错误**。

**逻辑验证**：因 test profile 被阻塞，把 `apply_cache_breakpoints` /
`count_cache_breakpoints` / `cache_control_enabled` 逐行复制到独立 crate
（`D:\space\temp\cb_verify`，仅去掉 tracing 与 WireProtocol 依赖）跑 8 组 26 项断言，
**全绿**：三断点位置正确、tool_result 形态断点落最后一个 block、开关关闭回退字符串、
5 种 env 组合默认开启、非 Anthropic 零断点、二次注入幂等、compact 形态 2 断点、
空 system / 空 messages / null content 边界不 panic。

**网关协议兼容**（`http://localhost:9850/v1/messages`，17k tokens 前缀）：
- 三断点组合 → HTTP 200，无 400。断点上限与 block 数组形态被网关接受。
- 三断点 + `thinking: {type:enabled, budget_tokens:8000}` → HTTP 200，**无 400**。
  见 §6，此前的交互担忧已被排除。

**⚠️ 规模差异导致的观感矛盾（已定位）**：17k tokens 规模下，三断点无 thinking 的
请求连续两次命中率均为 **0.0%**（total=17027/17055，cache_read=0），而同一请求体
加 `thinking` 后首写即命中 96.1%。这与 §2.1 的 24k 实测（加断点稳定 99%）看似矛盾。
后续补了 70.7k 规模的**同规模 A/B 对照**：无断点 `0% → 70.2% → 48.4%` 随机抖动，
三断点 `69.1% → 69.4%` 稳定——证明断点确实消除抖动，只是稳定水位随规模下降到
~69%。17k 无 thinking 组两次全 0 更可能是小规模 + 该请求形态未被缓存（该组被
429 限流中断，样本不足以判定）。**结论：断点有效，但收益按「消除方差 + 提升均值」
评估，最终仍以 usage.db 大样本为准。**

### 5.2 实施落点（与 §3 方案设计的差异）

**文件**：`simple_ai_protocol.rs`（+155 行）、`simple_ai/chat_loop.rs`、`simple_ai/compact.rs`。

**差异一：双入口，不改原签名**。新增 `build_request_body_with_env(..., custom_env)`，
由 `chat_loop.rs` 与 `compact.rs` 改调它；原 `build_request_body` 保持原签名不动。
原因：文件内已有 15 处 `build_request_body` 调用点（多为测试），
全量改签名会无谓扩大 diff。代价是存在一个不注入断点的入口，
但既有测试全部走该入口，正好用于确认「不注入」路径不破坏原行为。

**差异二：新增 `count_cache_breakpoints` 辅助函数**，实现 §3 中内联的断点计数逻辑，
供 `apply_cache_breakpoints` 的防御性上限检查与单测共用。

**超限行为**：仅 `tracing::warn!` 告警，**不裁剪**。超限断点会导致上游 400，
但裁剪需要人为选定「丢哪几个」，而 §3 约定的取舍顺序（system > tools > 末尾 user）
是主观假设；告警保留证据、让人工判断，比静默裁剪更符合本项目「不用防御补丁掩盖问题」的约定。

**幂等性**：`apply_cache_breakpoints` 对已有断点的块不重复挂载，
二次注入断点总数不变（二次注入后仍为 3 处）。

**开关语义**：`SIMPLE_AI_CACHE_CONTROL` 未设置、空 map、非 `"false"` 值均视为开启；
仅显式 `"false"` 关闭。env 拼写错误时**静默开启**——与 §3 一致，
不做「拼写错误则告警」，因为告警噪音比静默开启的风险高。

## 6. 已知不确定项

**已排除**：`thinking` 块与 last-user 断点的交互。实测三断点 +
`thinking: {type:enabled, budget_tokens:8000}` 返回 HTTP 200 且首写即命中
16384/17055 = 96.1%，无 400、无命中率异常。因此 last-user 断点**无条件挂载**是安全的，
不需要按 `effort` 条件化。

补充：compact 路径传 `effort: None`（compact.rs:253），不产生 thinking 块，故 compact 请求不受此交互影响。且 compact 请求体在构造后主动删除 `tools`（compact.rs:257），因此它只吃 system 断点——这符合预期，压缩请求会重发 system，多次压缩之间可复用该缓存。

**仍不确定**：稳定水位的上限。见 §2.1 补充——24k 规模约 99%、70.7k 规模约 69%，
约 30% 的前缀结构疑似无法进入缓存。原因是网关缓存条目的容量/分块策略，
无法从请求侧观测或干预。**最终收益以 usage.db 大样本命中率为准。**

## 7. 附带发现（与本方案独立，另行处理）

- `usage.db` 全库 `latency_ms` **distinct = {0}**：`chat_loop.rs:513` 硬编码 `0, 200, true`，SimpleAI 直连路径的延迟与状态码统计完全无效
- 全库 `cache_creation_tokens` **distinct = [0]**：网关不透传缓存写入字段。改完只能观察到 `cache_read` 上升，看不到写入成本——**判据按读命中率看，不要等写入数据**

## 8. 取证边界（未获证的部分）

- ZCode 侧无源码可实证：`D:\space\temp\zcode-extract` 仅含打包产物，`node_modules` 中 `@zcode/*` 全部缺失，全包 `cache_control` / `anthropic-beta` **0 命中**。ZCode 90%+ 的结论为推断
- 最后一轮定量方差测试（8 次 × 2 组）被 **429 限流**中断，方差数字未取到。但 usage.db 的 14979 样本与尖峰分布是独立的大样本证据，机制判断成立
- 代理日志 `~/.cli-proxy-api/logs/main.log` 中 `cache_read_input_tokens` / `cache_control` **0 命中**，不记录响应体，驱逐行为只能从请求结果反推

---

## 附录：可复现的取证方法

数据源：`D:\app\polaris-s\dialogs\usage.db`（`usage_logs` 表）

```sql
-- 按引擎聚合命中率（成本口径 B：cacheRead / (input + cacheRead)）
SELECT engine_id, model, COUNT(*) n,
  SUM(cache_read_tokens)*100.0/(SUM(input_tokens)+SUM(cache_read_tokens)) hit_pct
FROM usage_logs
WHERE input_tokens+cache_read_tokens>0
GROUP BY engine_id, model ORDER BY n DESC;
```

命中率口径与前端一致（`src/stores/conversationStore/eventHandler.ts` 的 `computeCacheHitRate`）。
注意 `created_at` 是 **unix 秒**，非 SQLite datetime 字符串，`datetime('now','-30 days')` 这类写法会取不到数据。

网关直连探测（A/B 组）：`http://localhost:9850/v1/messages`，`anthropic-version: 2023-06-01`。
响应侧字段名：`usage.input_tokens` / `usage.cache_read_input_tokens` / `usage.cache_creation_input_tokens`。
