# Token 速率（TPS）统计 — 分析与实施记录

> 状态：方案 A 已实施并提交（2026-10-20）
> 日期：2026-10-20
> 范围：主流 harness 的 token/TPS 统计做法 + 订阅配额生态 + 结合 Polaris 现状的实施路径

---

## 一、结论摘要

1. **TPS 只能在线测，不能离线算。** 用 Claude Code transcript（JSONL）离线计算 TPS 实测产生 **5,861（文本轮）/ 72,000（tool_use 轮）的假值**。生态里 5 个实时 TPS 项目全部走在线流式时刻，无一走离线解析。
2. **Polaris 的用量链路"只记量、不记率"。** SQLite `usage_logs` 表**已有 `latency_ms` 列**，但 6 个写入点全部传 `0`；`start.elapsed()` 只打 tracing 日志，从未落库。
3. **最小改动插入点唯一且明确**：`ai_chat_core.rs` 的 `event_callback` 是所有引擎的 AIEvent 汇聚点，已注入 `engineId`，再插一个 `receivedAtMs` 即可，**零引擎侧改动、零解析层改动、零 DB 迁移**（方案 A）。
4. **上游算法已有成熟答案**，`opencode-tps-meter` 的 tracker 与 `pi-token-speed` 的 sliding window 直接回答了两个核心陷阱：批量 flush 导致的虚高、首 chunk 的不可测区间。

---

## 二、外部生态调研

### 2.1 TPS 实时仪表类（核心参考）

| 项目 | Stars | Harness | 方法 |
|---|---|---|---|
| `ChiR24/opencode-tps-meter` | 35 | OpenCode | 滚动窗口 + 生成区间加权 + provider 校正 |
| `gsanhueza/pi-token-speed` | 41 | Pi | 时间滑窗 + 同时间戳 gap 前移 + TTFT |
| `williamcr01/opencode-tps` | 48 | OpenCode | 实时 TPS 仪表 |
| `Tarquinen/oc-tps` | 170 | OpenCode | TPS 查看 |
| `TomzxCode/tps-viewer` | 6 | Claude/OpenCode | **离线**可视化（唯一例外） |

#### `opencode-tps-meter` 的 `src/tracker.ts`（最高质量参考）

核心洞察直接写在注释里：

> Every recorded chunk carries the interval it was **GENERATED** in, not just the moment it arrived. Hosts batch output before publishing it (v2 flushes text every ~100ms), so a chunk's tokens were produced between the previous chunk and this one. **Dividing a chunk by anything shorter is what produced readings like 10,000 TPS.**

三个关键机制：

- **生成区间而非到达时刻**：`entries: { from: lastAt, at, count }[]`。速率窗口内按 chunk 生成区间与窗口的**重叠比例**线性加权：`tokens += length > 0 ? (entry.count * overlap) / length : entry.count`。
- **首 chunk 只计数不计速**：`if (lastAt === null || (ratedTokens === 0 && at === lastAt)) { origin = at; lastAt = at; return; }` —— 它的生成区间（请求发出→prefill→首块到达）从未被观测，除进去就是编造吞吐。
- **provider token 校正** `correctedAverage()`：仅当 `ratio = providerVisible / streamedTokens ∈ [0.5, 2]` 时用精确计数替换启发式估计；超出范围说明两者计数对象不同（隐藏 reasoning、宿主未流出的内容），按比率缩放会编造吞吐，保持流式值。

关键常数：`DEFAULT_ROLLING_WINDOW_MS=1000`、`MIN_RATE_SPAN_MS=50`（低于此不报数而非猜）、`MAX_BUFFER_SIZE=256`（超出时**合并最老两个**而非丢弃，避免窗口下界静默少算）、`STALL_REPUBLISH_MS=250`（停滞重发，否则限速/慢响应一直显示旧速度）、UI 更新 50ms、v2 TUI slot 8ms。

口径：只统计 assistant 的 `text`/`reasoning` part，排除 user/system/tool/patch/snapshot/file；`INVALID_FINISH_REASONS = {tool-calls, unknown}`。
启发式计数：`CHARS_DIV_4`（通用）、`CHARS_DIV_3`（代码）、`WORDS_DIV_0_75`（散文）。
阈值：`<10 TPS` 红（慢）、`>50` 绿（快）。显示格式 `TPS: 92.4 (avg 78.1) | tokens: 1,842`（瞬时 + 平均 + 累计）。

#### `pi-token-speed` 的 `src/core/sliding-window.ts`

- `events: { time: Date.now(), tokens }[]` + `windowStartIndex` 游标（避免 `shift` 开销）。
- **同时间戳检测**（关键）：窗口内首末事件时间戳相等 = provider 缓冲后 flush（stall 后突发），此时把 `spanStart` 前移到窗口**前一个**事件，把 gap 计入跨度：`span = Math.max(now - spanStart, MIN_SLIDING_WINDOW)`。
- 常数：`MIN_SLIDING_WINDOW=100ms`、`MAX_SLIDING_WINDOW=30000ms`、`COMPACTION_THRESHOLD=5000`（游标到达后 `splice` 前缀回收内存）。
- **TTFT**：`Message Start` 开始计时，`text_start`/`thinking_start`/`toolcall_start` 首个内容块时记录。
- 两路 token 源：`useProviderTokens` 优先 provider 精确值，否则自有计数器（`countStrategy`）。
- 结束时对齐：`endTpsBehavior` = `average`（默认，返回全程平均，与统计一致）| `last`（返回末窗值）。
- **Agent End 用权威计数 snap 总量**，保证最终平均精确。
- `TOKEN_GENERATION_TOOLS = {edit, write}` —— 已知会产生 token 的工具集。

### 2.2 用量/订阅配额类（另一条线，非速率）

以 **ccusage 生态**为中心，以及 Claude Code **5 小时滚动窗口**配额：

| 项目 | Stars | 定位 |
|---|---|---|
| `nguyenphutrong/quotio` | 4899 | 统一多 AI 账户的 macOS 菜单栏 |
| `sylearn/AIUsage` | 732 | 统一配额/成本仪表盘 |
| `razzant/claudexor` | 515 | 多 harness 控制面，配额感知轮换 |
| `sculptdotfun/viberank` | 119 | AI 编码用量排行榜 |
| `cobra91/better-ccusage` | 92 | ccusage 增强版 |
| `Nihondo/AgentLimits` | 68 | 配额 widget |
| `anniebuildz/freshquota` | 62 | 5h 滚动窗口择时 |
| `kenn-io/vibepulse` | 53 | 菜单栏监控 |
| `sivchari/ccowl` | 40 | 跨平台状态栏实时监控 |

**判断**：本项目是多引擎 + 中转端点架构，各家订阅口径（5h 滚动窗口 vs 日额度 vs token 计量）不统一，配额监控属于**独立议题**，与 TPS 速率统计耦合度低。建议 TPS 先行，配额另立专题。

### 2.3 业界标准口径

llama.cpp / vLLM 的 benchmark 口径是 **TTFT（time to first token）**、**TPOT（time per output token）**、**tokens/sec**。三者关系：`TPOT = 1 / TPS`。harness 侧因含工具执行/思考间隔，TPS 通常远低于纯推理吞吐，故应标注为"端到端生成速率"而非模型吞吐。

---

## 三、Polaris 现状审计

### 3.1 已有的（可直接用）

1. **SQLite `usage_logs` 表** `src-tauri/src/services/usage_db.rs:166-179`，路径 `<dataRoot>/dialogs/usage.db`：
   ```sql
   id, model, request_model, engine_id,          -- engine_id 是 ALTER TABLE 迁移加的
   input_tokens, output_tokens,
   cache_read_tokens, cache_creation_tokens,
   latency_ms NOT NULL DEFAULT 0,                 -- ★ 列已建
   status_code, is_streaming,
   created_at NOT NULL                            -- Unix 秒，唯一时间戳
   ```
   索引：`created_at` / `model` / `engine_id`。单例 `OnceLock`，`state.rs:329-336` 挂载。
2. **6 个采集点全覆盖**：代理 OpenAI 非流式（`handlers.rs:374`）、Anthropic 直通非流式（`282-286`）、直通流式（`319-323`）、OpenAI→Anthropic 转换流式（`717-724`）、Pi/omp（`pi_parser.rs:548-557`）、SimpleAI（`chat_loop.rs:514-523`）。
3. **5 个命令** `src-tauri/src/commands/usage.rs`：summary / model_stats / engine_stats / daily_trends / recent_logs。Tauri `lib.rs:1200-1205` + Web/HTTP `web/api/ipc.rs:466-472` 双通道。**无 cap.router 注册。**
4. **前端**：`tokenAnalyticsStore.ts`（223 行，时间范围 `today/1d/7d/14d/30d/all`）、`TokenStatsTab.tsx`（600 行，4 视图 overview/model/time/topSessions）、`ContextMeter.tsx`（437 行，水位双口径 turn/cumulative）。
5. **`voiceLatencyMeter.ts`** —— 可复用埋点骨架，已有 `t3_first_token` 概念、`performance.now()` 相对 epoch、环形缓冲 100 轮、每 5 轮懒写 localStorage、默认关闭由配置开启。

### 3.2 关键缺口

| # | 缺口 | 位置 |
|---|---|---|
| 1 | **`latency_ms` 列已建但 6 个写入点全传 `0`**；`start.elapsed()` 只打日志 | `handlers.rs:228-235` 只 `tracing::info!` |
| 2 | 无 `request_started_at` 列，只有结束时刻 | 精确耗时需要迁移加列 |
| 3 | **代理层"全量缓冲后转发 SSE"**（`handlers.rs:261`、`701-731` 一次性拼 body）→ 结构上拿不到 first_token 时刻 | 需在 forwarder 或引擎侧埋点 |
| 4 | `UsageEvent`（`ai_event.rs:1393-1436`）与 `UsageStats`（`types.ts:286-330`）**均无 duration/timestamp** | 协议双侧需同步 |
| 5 | 无亚日聚合（唯一分桶是按天，`get_daily_trends:466` 用 `'localtime'` 修饰避免 UTC+8 跨日错桶） | — |
| 6 | 4 个聚合结构无 latency/TPS 字段；`UsageLogEntry.latencyMs`（L50）前端未消费 | — |
| 7 | `tps` / `tokensPerSecond` / `tokens_per_second` **全仓零命中** | 速率概念不存在 |
| 8 | `first_token` 命中全是 **FirstTokenTimeout 错误分类/超时配置**，不是采样值 | `provider_router.rs:108/117/132/491`、`ai_chat_core.rs:923`、`config.rs:409` |
| 9 | `Turn.started_at_ms` 已有（`turn_persist.rs:31-45/136-141/293-312`，每轮首事件时刻 epoch ms），但**无 `ended_at_ms`、未算 duration** | — |
| 10 | `Codex` 在本仓库**无独立引擎文件**；实际 `ai/engine/` 只有 claude / opencode / pi_parser / plugin_engine / plugin_process_engine / simple_ai / simple_ai_protocol / mcp_bridge | 引擎枚举需以实际为准 |

### 3.3 各引擎流式 token 事件到达点（均无时间戳）

| 引擎 | 文本增量产出位置 |
|---|---|
| Claude | `event_parser.rs:474-489`（`content_block_delta` → `text_delta` 分支） |
| OpenCode | `opencode.rs:794-808`（`OpencodeEvent::Text`） |
| Pi/OMP | `pi_parser.rs:199-224`（`text_delta`） |
| SimpleAI | `chat_loop.rs:435-464`（SSE → `StreamDelta::Text` → `TokenEvent`） |

usage 到达时序：单轮 `scope="turn"` 在 `message_delta`（`event_parser.rs:523-548`）；累计 `scope="cumulative"` 在 `result`（`parse_result_event:971-1163`）。

### 3.4 最小改动插入点（关键发现）

`src-tauri/src/services/ai_chat_core.rs:1067-1127` 的 `event_callback` 是**所有 4 个引擎 + 插件引擎**的 AIEvent 汇聚点，且**已有注入 `engineId` 的先例**：

```rust
let event_callback = move |event: AIEvent| {
    match &event { AIEvent::SessionStart(s) => append_session_event(...), AIEvent::SessionEnd(e) => append_session_event(...), _ => {} }
    crate::services::turn_persist::observe(&event, &engine_str);
    let enriched = match &event {
        AIEvent::SessionStart(_) => serde_json::to_value(&event).ok().map(|mut v| {
            if let Some(obj) = v.as_object_mut() {
                obj.insert("engineId".to_string(), serde_json::Value::String(engine_str.to_string()));
            }
            v
        }),
        _ => None,
    };
    // 包成 { contextId, payload } 后 emit_ref(event_json)
};
```

给 `AssistantMessage(is_delta=true)` / `Token` / `SessionStart` / `SessionEnd` 的序列化结果插一个 `receivedAtMs`，即可覆盖全部引擎，**无需碰任何引擎代码或 event_parser.rs**。

---

## 四、离线口径的否证（本项目实测）

对 `C:/Users/28409/.claude/projects/*/*.jsonl` 的 33 个真实会话、6,201 个可计速响应，按 `message.id` 分组后计算 `max(output_tokens) / (末块 ts − 首块 ts)`：

```
文本轮    n=32    TPS median=5861.4  p10=2529.9  p90=13050.0
tool_use 轮 n=6169  TPS median=72000.0
```

**假值铁证。** 根因：Claude Code 的 JSONL `timestamp` 是**写盘时刻**，一条 assistant 响应被拆成多块（每块一次写盘），相邻块间隔 0.00–0.03s；而 `output_tokens` 是**累积值**，同一 `message.id` 内多块完全相同。于是除以一个接近 0 的间隔。

与上游 `tracker.ts` 的注释完全吻合 —— "Dividing a chunk by anything shorter is what produced readings like 10,000 TPS"。

同批实测暴露的其它陷阱：

| 陷阱 | 实测值 |
|---|---|
| `ΣoutTok / max(outTok)` 重复追加膨胀 | **50.6 倍** |
| `chars/4` 启发式 vs 真实 `output_tokens` 偏差 | 中位数 **-95%**（thinking tokens 不计入可见 chars） |
| 整会话口径被空闲/工具执行稀释 | TPS median 29.7（p10=7.7, p90=70.1）—— 不是"生成速度" |
| 单会话内多模型路由 | **20/25 会话**存在，混合平均无意义 |

---

## 五、实施方案（三档，未实施）

### 方案 A：最小可用 —— 在线单轮速度，不改协议、不迁 DB

**改动面**：前端 1 个文件 + Rust 1 处 enrich。

1. 后端 `ai_chat_core.rs::event_callback`：对 `AssistantMessage(is_delta=true)` / `Token` / `SessionStart` / `SessionEnd` 的 JSON 结果插 `receivedAtMs: SystemTime::now().as_millis()`。
2. 前端 `eventHandler.ts`：
   - `session_start` → 记 `t0`
   - 首个 `assistant_message|token` → 记 `tFirst`（此后算 TTFT）
   - 每块 → 累计 `chars`、更新 `tLast`
   - `session_end` → 记 `tEnd`
3. 计算：
   - `TTFT = tFirst - t0`
   - `TPS_live = Σchars / 4 / ((tLast - tFirst) / 1000)`，滚动窗口 1000ms，`MIN_RATE_SPAN_MS=50`
   - `duration = tEnd - tFirst`
4. 修正：流末 `usage.output_tokens` 到达时，若 `output_tokens / 启发式tokens ∈ [0.5, 2]`，用精确值校正（照 `correctedAverage`）。
5. 展示：`ContextMeter` 水位卡加一行 `⚡ 42.3 tok/s · TTFT 1.2s`（该组件已有 rawPayload / 按模型明细区，加一行成本低）。
6. 幂等：TPS 状态按 run 复位（复用 `context-cost-meter` 已确立的 `turnSnapshotSeen` 在 `cli_init` 复位的幂等范式），避免 task-notification 单 run 多 result 污染。

**成本**：约 1–2 人日。零 DB 迁移、零协议类型变更、零引擎侧改动。
**局限**：仅当前会话可见，不落库，无趋势图。

### 方案 B：标准 —— 在线 + 持久化 + 趋势

在 A 基础上增加：

1. **DB 迁移**：`usage_logs` 加 `request_started_at`、`first_token_at`、`generation_ms` 三列。照 `engine_id` 的 `ALTER TABLE ... ADD COLUMN` 静默忽略重复列模式（`usage_db.rs:204-212`）。
2. **修 `latency_ms` 恒 0**：把 `handlers.rs:228-234` 的 `start.elapsed()` 传进 6 个 `record_usage` 调用点（`handle_non_streaming` / `handle_streaming` 当前签名只返回 `Response`，需要在内部拿 start 或改签名带出 elapsed）。
3. **引擎直连路径补埋点**：`pi_parser.rs` / `chat_loop.rs` 的 SSE/delta 回调处记 first_token 时刻（代理路径因全量缓冲结构上拿不到）。
4. **新增聚合**：`get_usage_hourly_trends`（`DATE(created_at,'unixepoch','localtime','%H')` 分桶，照 `get_daily_trends:466` 模式）；聚合结构加 `avgGenerationMs` / `p50Tps` / `avgTtftMs`。
5. **协议同步**：`UsageEvent` 加 `duration_ms` / `first_token_ms`，前端 `UsageStats` 同步（camelCase 对齐）。
6. **前端**：`TokenStatsTab` 加"速度"视图（按小时 TPS 曲线，复用现有堆叠柱实现）+ Top 请求表加"耗时/速度"列（表头现为 `#|引擎|模型|输入|输出|缓存|命中率|花费|时间`）。

**成本**：约 4–6 人日（含 DB 迁移 + 协议双侧同步 + 5 小时聚合）。

### 方案 C：对齐行业 —— 三指标体系 + 订阅配额

在 B 基础上：

1. **指标体系**：统一 **TTFT / TPS / TPOT**（`TPOT = 1/TPS`，与 llama.cpp、vLLM 对齐）。展示时标注为"端到端生成速率"，与纯推理吞吐区分。
2. **抽取通用埋点**：从 `voiceLatencyMeter.ts` 抽出 `latencyMeter.ts`（mark 制 + 环形缓冲 + 懒写 localStorage），mark 集为 `request_start / first_token / first_chunk / stream_end`。语音链路 `t3_first_token` 语义不变，仅换基类。
3. **按模型分组的 TPS 基线**：实测 20/25 会话存在多模型路由，混合平均无意义。需 `GROUP BY model` 出各模型 TPS 分布，并与 `message.model`（响应侧实际模型，可能动态路由）对齐——`qusc` 这类请求侧别名不可用于速率分组。
4. **上游机制移植**：`endTpsBehavior`（average / last）对齐策略、`STALL_REPUBLISH_MS=250` 停滞重发（否则限速/慢响应一直显示旧速度）、`MAX_BUFFER_SIZE=256` 超量合并而非丢弃。
5. **订阅配额**（独立议题）：Claude Code 5 小时滚动窗口，本项目需按 provider 分组。参考 `quotio`(4899★) / `claudexor`(515★)。**建议另立专题，不与 TPS 绑定。**

**成本**：约 8–12 人日（配额部分另计）。

---

## 六、风险与注意事项

1. **不要用 transcript 离线算 TPS。** 本次最重要结论。实测假值 5,861 ~ 72,000。生态内 5 个实时项目无一走离线，唯一走离线的 `TomzxCode/tps-viewer` 依赖 harness 自身已记录的时刻。
2. **thinking tokens 陷阱**：`chars/4` 低估 -95%，thinking 不计入可见 chars。`output_tokens_details.thinking_tokens` 存在但流中无对应字符 —— 速率必须优先用 provider 精确计数。
3. **代理层结构性限制**：全量缓冲后转发 SSE，first_token 时刻**必须**从引擎侧（`chat_loop.rs` / `pi_parser.rs`）或 SSE 转发层拿，代理外层拿不到。
4. **多模型路由**：20/25 会话内切换模型，TPS 必须按模型分组。
5. **批量 flush 虚高**：provider 缓冲后突发（实测相邻块间隔 0.00–0.03s），需照 `pi-token-speed` 把 span 前移包含 gap，并设 `MIN_RATE_SPAN_MS=50` 以下不报数（"宁缺勿猜"）。
6. **首 chunk 不计入速率**：其生成区间从未被观测（请求发出→prefill→首块到达），除进去即编造吞吐。计入 total 不计入 rate。
7. **子代理污染**：结合 `context-cost-meter` 记忆的"单 run 多 result（task-notification）"陷阱，TPS 状态须按 run 幂等，`turnSnapshotSeen` 复位时机在 `cli_init` 而非 cumulative 消费。
8. **重复追加虚高**：同 `message.id` 内多块 `output_tokens` 相同且为累积值，直接 Σ 会膨胀 **50.6 倍**。必须 `max` 而非 `sum`。
9. **本仓库无 Codex 引擎文件**：`ai/engine/` 实际为 claude / opencode / pi_parser / plugin_engine / plugin_process_engine / simple_ai / simple_ai_protocol / mcp_bridge。方案中的引擎清单以实际为准。
10. **验证手段受限**：本机 `cargo test --lib` 不可用（Tauri DLL 限制），后端改动用 `cargo check`；前端 `pnpm exec tsc --noEmit` + `pnpm test:run`。涉及命令层需 `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`。

---

## 七、推荐路径

**先做方案 A。** 理由：

- 单点插入（`event_callback`），已被 `engineId` 注入验证过安全；
- 零 DB 迁移、零协议类型变更、零引擎侧改动，回退成本为零；
- 直接拿到用户感知最强的两个数字（当前生成速度 + 首 token 延迟）；
- 方案 A 的前端埋点代码在方案 B/C 中**完全复用**，不构成返工。

方案 B 的 DB 迁移与 5 小时聚合，建议在方案 A 上线并被实际使用一段时间、确认指标定义稳定后再做——避免先落库再改口径导致的历史数据不可用。

---

## 八、实施记录（2026-10-20，方案 A 已落地）

### 实际改动文件

| 文件 | 改动 |
|---|---|
| `src-tauri/src/services/ai_chat_core.rs` | `event_callback` 两处（`start_chat_inner` / `continue_chat_inner`）注入 `receivedAtMs`，覆盖 SessionStart/SessionEnd/CliInit/Usage/Token/Thinking/AssistantMessage 七类事件 |
| `src/ai-runtime/event.ts` | 五个事件类型加 `receivedAtMs?: number`（TokenEvent / ThinkingEvent / SessionStartEvent / SessionEndEvent / AssistantMessageEvent / UsageEvent） |
| `src/services/streamRateTracker.ts` | **新增**。`TokenRateTracker` 类 + `estimateTokens`（CJK/ASCII 差异化）+ 模块级 tracker Map |
| `src/services/streamRateTracker.test.ts` | **新增**。18 个测试 |
| `src/components/Chat/common/StreamRateBadge.tsx` | **新增**。状态栏实时徽章 |
| `src/stores/conversationStore/eventHandler.ts` | `pushStreamDelta` / `pushProviderUsage` 两个 helper；接入 session_start / session_end / token / thinking / assistant_message / usage 六处 |
| `src/stores/conversationStore/types.ts` | `ConversationState` 加 `streamRate` 字段 |
| `src/stores/conversationStore/createConversationStore.ts` | 初始状态与历史加载两处初始化 |
| `src/stores/conversationStore/useActiveSession.ts` | `useActiveSessionStreamRate()` hook |
| `src/components/Chat/common/ChatStatusBar.tsx` | 流式期间渲染徽章 |
| `src/components/Chat/common/ContextMeter.tsx` | 详情卡加"生成速率"区（TTFT / TPS / 生成耗时） |

### 与调研结论的对应

| 调研结论 | 落地位置 |
|---|---|
| 按生成区间加权，首块不计入速率 | `recordDelta` 首块分支只置 `origin`/`lastChunkAt`，不 push entry |
| stall gap 前移 | `instantTps` 的同时间戳检测 + `windowStart` 前移 |
| 宁缺勿猜（< 50ms 不报数） | `MIN_RATE_SPAN_MS`，返回 null |
| 缓冲超量合并而非丢弃 | `prune()` 合并最老两个 |
| provider 精确值校正限 [0.5, 2] | `averageTps()` 的 `MIN/MAX_PROVIDER_RATIO` 判断 |
| 首块只计数不计速 | 见上 |
| **不要用 transcript 离线算 TPS** | 全部走在线流式时刻（`receivedAtMs`），无离线路径 |

### 验证结果

- `pnpm exec tsc --noEmit` → 0 error
- `npx vitest run src/services/streamRateTracker.test.ts` → 18 passed
- `npx vitest run src/stores/conversationStore/ src/services/streamRateTracker.test.ts` → 21 文件 / 177 用例全过
- `cargo check` → Finished；`ai_chat_core.rs` 出现 0 次告警（无新增）
- `npx eslint` 新增/改动核心文件 → exit 0（存量 warning 不在本次改动范围）
- `pnpm test:run` 全量 → 11 文件失败，全部 `ECONNREFUSED 127.0.0.1:3000`（依赖本地服务的环境问题），失败清单与本次改动无关（pluginDiscovery / engineHealth / language / markdown / engines）

### 仍未做（属方案 B/C）

- DB 持久化与 5 小时聚合（本方案只保留当前会话内存态，不落库）
- `usage_logs.latency_ms` 恒 0 的修复（6 个写入点仍传 0）
- 按模型分组的 TPS 分布（需方案 B 的聚合支撑）
- 订阅配额滚动窗口监控（独立议题，建议另立专题）
