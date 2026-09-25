# 缓存占比（cache 占比）统计 · 跨域落地分析

> 状态：**仅分析，不实施**（2026-09-25）
> 需求：token 统计在多个地方（会话级水位卡、全局 Token 统计面板、会话持久化、代理层用量库）分别统计缓存 token，缺一个统一的「缓存占比」口径/指标。

## 1. 现状盘点：token 统计分布的 5 个域

| # | 域 | 位置 | 数据形态 | 是否已有「缓存占比」 |
|---|----|------|---------|-------------------|
| 1 | **会话内实时水位卡** | `src/components/Chat/common/ContextMeter.tsx` | `UsageStats`（turn 快照 + cumulative 兜底） | ⚠️ 部分：有 `hitRate = cacheRead / (input+cacheCreation+cacheRead)`，**分母不含 output**，且只在 `cacheRead > 0` 时显示 |
| 2 | **会话级累计/持久化** | `src/stores/conversationStore/eventHandler.ts` → `DialogMeta.tokenUsage` | `sessionTotals` / `TokenUsageSummary`（含 modelBreakdown） | ❌ 无 |
| 3 | **全局 Token 统计面板** | `src/components/Settings/tabs/TokenStatsTab.tsx` | `UsageSummary` / `ModelUsageStats` / `EngineUsageStats` / `DailyUsageStats` / `UsageLogEntry` | ❌ 无（概览卡「缓存」是 read+creation 绝对值，无占比；时间/模型视图也无） |
| 4 | **代理层用量库（SQLite）** | `src-tauri/src/services/usage_db.rs` | `usage_logs` 表：`input/output/cache_read/cache_creation` 四列 | ❌ 无（结构完全支持，只差聚合口径） |
| 5 | **后端事件模型** | `src-tauri/src/models/ai_event.rs`、`src/ai-runtime/event.ts`、`simple_ai_protocol.rs` 等解析层 | `UsageEvent` / `UsageStats` 携带四分类 | — 数据源，无需占比 |

四个域都各自持有 cache_read / cache_creation 原始值，但「缓存占比」这个派生指标目前只以「缓存命中率」形式存在于域 1，且口径与成本计费口径不一致。

## 2. 关键口径问题（为什么不能直接「统一加一个字段」）

### 2.1 三种互斥的「缓存占比」定义

| 口径 | 公式 | 语义 | 已有实现 |
|------|------|------|---------|
| A. 缓存命中率（上下文水位口径） | `cacheRead / (input + cacheCreation + cacheRead)` | 本轮/当前上下文中被缓存命中的比例，对齐 `/context` 水位 | ContextMeter `hitRate`（域 1） |
| B. 缓存命中率（成本口径） | `cacheRead / (input + cacheRead)` | 计费视角：输入部分有多少被缓存打折 | 无 |
| C. 缓存覆盖（含写入，全量口径） | `(cacheRead + cacheCreation) / (input + cacheCreation + cacheRead)` | 缓存参与度：输入中与缓存相关的比例 | 无 |

现有 `hitRate` 用的是 A 且 **漏了 output 不做分母**（因为 output 不占上下文窗口，合理）。若在域 3/4 的汇总卡直接套用 A，会把「输入 + 缓存」之外的大量 output 排除在外；若把 output 纳入分母，又是另一种定义。**必须先定一个口径再铺开。**

### 2.2 各域的数据形态不同，不能共享同一公式

- 域 1（水位卡）：数据是「单轮快照 or 累计兜底」二选一，`contextSource` 标注估算；
- 域 2（持久化）：`sessionTotals` 是跨 run 幂等累加，**modelBreakdown 只在单 run 会话写入**（多 run 漏计，`eventHandler.ts:830-856` 注释已说明）；
- 域 3（面板）：SQLite 聚合行（按模型/引擎/天），天然可算占比；
- 域 4（用量库）：原始请求行，最准确，但只覆盖**经过代理的请求**，且缓存字段可能为 0（端点不返回时）。

## 3. 建议落点（若实施）

### 3.1 推荐：先在后端聚合层（域 4 → 域 3）加派生字段

`usage_db.rs` 是唯一有全部原始数据的域，加一个只读派生字段成本最低、口径最可控：

```rust
// UsageSummary / ModelUsageStats / EngineUsageStats / DailyUsageStats 各加：
#[serde(rename_all = "camelCase")]
pub struct ... {
  // ...现有字段
  /// 缓存命中率（成本口径 B）：cacheRead / (input + cacheRead)；分母为 0 时为 0
  pub cache_hit_rate: f64,
}
```

- 单条 `UsageLogEntry` 也可加 `cacheHitRate`，前端 Top 请求表可直接展示。
- SQL 侧只需多取一列算比值，无 schema 变更、无迁移。
- 前端 `tokenAnalyticsStore.ts` 类型同步加字段，`TokenStatsTab` 概览卡/模型表/引擎分布/时间趋势按需渲染（如「缓存命中 xx%」）。

### 3.2 会话级（域 1/2）：统一口径后补

- `SessionUsageTotals` / `TokenUsageSummary` 增加派生 `cacheHitRate`（成本口径 B），持久化后跨会话聚合才有意义；
- `ContextMeter` 现有 `hitRate`（口径 A）**建议保留并标注口径**，或与全局面板统一为口径 B——需产品决策，因为水位卡的语义是「上下文里多少被缓存」，与成本口径不完全等价。

### 3.3 口径建议（默认值）

- **统一采用口径 B**（`cacheRead / (input + cacheRead)`）作为「缓存命中率」的唯一对外指标：语义直观（输入部分被缓存打折的比例）、与 cost 计算直接相关、各域都可复算；
- 如需「缓存写入」维度，另加 `cacheCoverage = (cacheRead + cacheCreation) / (input + cacheRead + cacheCreation)`，不与命中率混用。

## 4. 涉及文件（实施时按此清单改）

| 文件 | 变更 |
|------|------|
| `src-tauri/src/services/usage_db.rs` | 4 个聚合结构体 + `UsageLogEntry` 加 `cache_hit_rate`；4 个查询函数补列计算（`estimate_cost` 旁加 `estimate_hit_rate`） |
| `src/stores/tokenAnalyticsStore.ts` | 5 个接口类型同步加 `cacheHitRate` |
| `src/components/Settings/tabs/TokenStatsTab.tsx` | 概览卡缓存卡副文案 + 模型表/引擎分布/时间趋势按需展示占比 |
| `src/stores/conversationStore/types.ts` | `SessionUsageTotals` / `TokenUsageSummary` 加 `cacheHitRate`（如需会话级持久化） |
| `src/stores/conversationStore/eventHandler.ts` | `sessionTotals` / `buildDialogMetaInput` 补派生字段 |
| `src/services/dialogStorage/jsonlCodec.ts` | `TokenUsageSummary` 编解码兼容新字段（可选字段，向后兼容） |
| `src/components/Chat/common/ContextMeter.tsx` | 现有 `hitRate` 标注口径 or 统一（见 §3.2，需决策） |

## 5. 注意事项

1. **分母为 0 的边界**：无缓存字段的端点（SimpleAI 部分协议）cache_read/cache_creation 为 0，占比恒为 0，UI 需区分「无缓存数据」与「命中率 0%」。
2. **多 run 会话的 modelBreakdown 漏计**：会话级按模型占比在多 run 会话不可信（域 2 既有边界），面板级（域 3）无此问题。
3. **成本 vs 水位口径混用**：ContextMeter 的 hitRate 与全局面板的命中率若口径不同，两处显示数字会不一致，需在 UI 上标注或统一。
4. **代理覆盖范围**：域 4 只统计经过代理的请求，CLI 直连（未走代理）的用量不在其中，占比是全量中的子集占比。
5. **无需 schema 迁移**：全是派生字段，SQLite 表结构不动。

---

关联文档：`docs/token-statistics-plan.md`（跨会话统计方案）、`docs/context-cost-meter-resolutions.md`（双口径设计）、`docs/token-stats-time-range-prd.md`（面板时间组件）。
