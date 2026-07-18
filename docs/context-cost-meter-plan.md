# 上下文用量与成本仪表盘 · 实施方案

> 对标 Claude Code 状态行(上下文百分比)+ `/cost`(token 分类换算花费)。
> 把后端已采集、前端被丢弃的 token 用量,打通为常驻可观测面。
> PRD 原型:`.polaris/previews`(requirementId=`context-cost-meter`,v2)。

## 0. 背景与口径(为什么这样做)

Claude/Anthropic API 的用量不是事后统计,而是**每次响应随流返回一个结构化 `usage` 对象**,把 token 按计费档拆成四类:

| 字段 | 含义 | 计费倍率 |
|------|------|---------|
| `input_tokens` | 未命中缓存的输入(全价) | 1× |
| `cache_creation_input_tokens` | 写入缓存的 token | ~1.25× |
| `cache_read_input_tokens` | 从缓存读取的 token | ~0.1× |
| `output_tokens` | 输出 token | 输出单价 |

**核心口径(决定水位条正确性):**

```
上下文占用 = input_tokens + cache_creation_input_tokens + cache_read_input_tokens   # 三项之和,不是单一 input
窗口分母   = ModelProfile.contextWindow                                            # 动态:Claude 1M / Codex 200K
成本       = input/1e6·P_in + cacheCreation/1e6·P_in·1.25 + cacheRead/1e6·P_in·0.1 + output/1e6·P_out
缓存命中率 = cacheRead / 上下文占用
```

`input_tokens` 只是「未命中缓存的余量」。开启 prompt caching 后,真实上下文大头在 `cache_read` 里;只看 input 会严重低估水位。

## 1. 现状(已验证)

| 项 | 结论 | 锚点 |
|----|------|------|
| Codex 已采集 usage | `input/cached/output/reasoning` 四字段,但仅 `tracing::info!` 后丢弃,未进 AIEvent | `codex_parser.rs:72`(结构)、`:193`(丢弃点) |
| SimpleAI 已累计 input | `usage_acc` 有完整 usage,前端零消费 | `chat_loop.rs:311` |
| AIEvent 无 usage 变体 | 27 个变体均无用量事件 | `ai_event.rs:1351` |
| 前端零消费 | `ChatStatusBar` 只展示 Agent/Model/健康度 | `ChatStatusBar.tsx` |
| 事件跨端零转换 | `#[serde(rename_all="camelCase")]` 自动映射;`eventRouter` 直接透传 payload 为 `AIEvent` | `eventRouter.ts:88` |

**测试验证结论:** `cargo test --lib codex_parser` 编译通过(本机 Tauri DLL 限制无法运行 test,与既有环境限制一致);前端事件总线 `event.test.ts + event-bus.test.ts` 136/136 通过;现有测试 `parse_turn_completed`(`codex_parser.rs:351`)本身断言 usage 被丢弃(只输出 1 个 SessionEnd)。数据地基真实、代码健全,属"接线级"改动。

## 2. Phase 1 — 打通数据链(1–2 天,无新依赖)

### 2.1 后端:新增 `AIEvent::Usage`

**文件:** `src-tauri/src/models/ai_event.rs`

以 `ContextCompactedEvent`(`:1217`)为样板新增结构体(同样 `#[serde(rename_all="camelCase")]`):

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEvent {
    #[serde(rename = "type")]
    pub event_type: String,        // "usage"
    pub session_id: String,
    pub input_tokens: u64,                    // → inputTokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<u64>,  // → cacheCreationInputTokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<u64>,      // → cacheReadInputTokens
    pub output_tokens: u64,                   // → outputTokens
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_output_tokens: Option<u64>, // → reasoningOutputTokens(Codex 有)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,          // → contextWindow(后端已知则填,否则前端从 ModelProfile 取)
}
```

改动点(与现有事件对齐):
1. `enum AIEvent`(`:1351`)加变体 `Usage(UsageEvent)`。
2. `event_type()` match(`:1394`)加 `AIEvent::Usage(e) => &e.event_type`。
3. 便捷构造方法区加 `pub fn usage(...)`(参考 `session_end` `:1467`)。
4. 全局搜索其他 `match self`(如序列化/克隆辅助)补齐 `Usage` 分支,避免非穷尽编译错误。

### 2.2 后端:Codex 埋点 + 补 cacheCreation 档

**文件:** `src-tauri/src/ai/engine/codex_parser.rs`

1. `CodexUsage`(`:72`)补字段:
```rust
#[serde(default)]
pub cache_creation_input_tokens: u64,   // 中转站/Codex 若透传则采到,否则 default 0
```
2. `TurnCompleted` 分支(`:193`)把现有日志的 usage 同时 emit,随 session_end 返回:
```rust
CodexEvent::TurnCompleted { usage } => {
    let mut events = Vec::new();
    if let Some(u) = usage {
        tracing::info!(/* 保留原日志 */);
        events.push(AIEvent::usage(
            session_id,
            u.input_tokens,
            Some(u.cache_creation_input_tokens),
            Some(u.cached_input_tokens),       // cacheRead
            u.output_tokens,
            Some(u.reasoning_output_tokens),
            None,                               // context_window 交前端按 ModelProfile 取
        ));
    }
    events.push(AIEvent::session_end(session_id));
    events
}
```
3. 更新测试 `parse_turn_completed`(`:351`)断言:现在应输出 `[Usage, SessionEnd]` 两个事件。

### 2.3 后端:SimpleAI/mimo 埋点

**文件:** `src-tauri/src/ai/engine/simple_ai/chat_loop.rs`

`finish_usage()`(`:311`)处已有 `usage.input_tokens/output_tokens/total_tokens`,顺手 emit `AIEvent::usage(...)`(cacheCreation/cacheRead 若协议无则传 None)。通过现有事件发送通道(与该 loop 内 emit 其他 AIEvent 同路径)。

### 2.4 前端:事件类型与分发

**文件:** `src/ai-runtime/event.ts`

以 `ContextCompactedEvent`(`:706`)为样板:
1. 加 `UsageEvent` 接口(camelCase 字段与后端对应):
```ts
export interface UsageEvent {
  type: 'usage'
  sessionId: string
  inputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens?: number
  outputTokens: number
  reasoningOutputTokens?: number
  contextWindow?: number
}
```
2. 加入 `AIEvent` 联合类型(`:723`)。
3. 加工厂函数 + 类型守卫 `isUsageEvent`(参考 `:901`/`:917`)。
4. 若存在事件类型白名单数组(`:1102` 附近),补 `'usage'`。

**文件:** `src/mobile/runtime/applyAIEvent.ts` + 主链路等价分发点

在 `switch (event.type)`(`:78`)加:
```ts
case 'usage': {
  store.setUsageStats(event.sessionId, {
    input: event.inputTokens,
    cacheCreation: event.cacheCreationInputTokens ?? 0,
    cacheRead: event.cacheReadInputTokens ?? 0,
    output: event.outputTokens,
    contextWindow: event.contextWindow,   // 缺则由 selector 从 ModelProfile 取
  })
  break
}
```

### 2.5 前端:会话级 usage 状态

**文件:** `src/stores/conversationStore/`(会话 store)

- 会话状态加 `usageStats?: { input; cacheCreation; cacheRead; output; contextWindow? }` + 累计 `usageTotals`(跨轮 output 累加、上下文取最近一轮)。
- 加 action `setUsageStats(sessionId, stats)`。
- `setMessagesFromHistory` / 新建会话时重置(与既有 `_lastCompactionRange` 重置同位置)。

### 2.6 前端:状态栏水位条

**文件:** `src/components/Chat/ChatStatusBar.tsx`

- 新增三段水位条组件(input=蓝 / cacheCreation=黄 / cacheRead=紫),分子 = 三项之和。
- 分母:`useSessionConfig` → `modelProfileStore.contextWindow`(已有字段,记忆库 `simple-ai-compact-content-fix` 记录默认窗口 1M)。
- 复用现有 `getVisibleTypes`/`getHiddenTypes` 响应式折叠:宽屏常驻水位条,窄屏收进「更多」面板(`SECONDARY_TYPES`)。
- 悬停/点击浮出详情卡(token 四分类 + 计费倍率 + 命中率),对标 `/cost`。
- 阈值预警:≥80% 黄条「即将压缩」、≥95% 红条「建议交接」——文案对齐 SimpleAI 压缩触发(`compact.rs` 阈值默认)。

### 2.7 Phase 1 验证

- `cargo check --lib`(本机不能跑 test,只验证编译;CI 跑 `cargo test`)。
- `npx vitest run src/ai-runtime`(事件总线回归)+ 新增 `event.ts` 的 usage 工厂/守卫单测。
- 手动:Codex/SimpleAI 各跑一轮,确认水位条随轮次上升、切引擎窗口分母切换、命中率非零。

## 3. Phase 2 — 成本洞察与持久化(可选)

1. **单价字段:** `modelProfileStore` 加 `pricePerMInput/pricePerMOutput`;内置各引擎/模型默认单价表(Opus 4.8 $5/$25、gpt-5-codex 等),用户可覆盖。
2. **成本展示:** 详情卡显示本轮/累计花费 + 命中率 + 「省下金额」(命中段按 0.1× 计的差额)。
3. **持久化:** 会话历史(已有 SQLite 索引,记忆库 `session-history-redesign`)落盘每会话 usage,支持「本项目本周花费」聚合视图。

## 4. 风险与注意

| 风险 | 说明 | 缓解 |
|------|------|------|
| Codex 中转站不透传 cacheCreation | `#[serde(default)]` 兜底 0,水位/成本略偏乐观 | 字段可选,不阻断;命中率仍可算 |
| 非穷尽 match 编译错误 | 新增 enum 变体需补所有 `match self` | 编译期强制,按报错补齐即可 |
| SimpleAI 协议无 cache 分类 | mimo/openai-protocol 可能只有 input/output | cacheCreation/cacheRead 传 None,水位退化为 input+output |
| 窗口分母缺失 | 后端未填 contextWindow 且 ModelProfile 无值 | selector 兜底默认 1M(记忆库既有约定) |
| 双 EngineId 同步 | 若涉及引擎注册(本方案不涉及) | 参考记忆库 `dual-engineid-sync` |

## 5. 改动文件清单

**后端(Rust):**
- `src-tauri/src/models/ai_event.rs` — UsageEvent + enum 变体 + 便捷构造
- `src-tauri/src/ai/engine/codex_parser.rs` — CodexUsage 补字段 + TurnCompleted emit + 测试更新
- `src-tauri/src/ai/engine/simple_ai/chat_loop.rs` — finish_usage emit

**前端(TS):**
- `src/ai-runtime/event.ts` — UsageEvent 接口/联合/工厂/守卫
- `src/mobile/runtime/applyAIEvent.ts`(+ 主链路等价分发)— case 'usage'
- `src/stores/conversationStore/` — usageStats 状态 + action + 重置
- `src/components/Chat/ChatStatusBar.tsx` — 三段水位条 + 详情卡 + 预警

**Phase 2 追加:**
- `src/stores/modelProfileStore.ts` — 单价字段 + 默认表
- 会话历史持久化层 — usage 落盘 + 周聚合
