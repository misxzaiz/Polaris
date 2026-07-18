# 上下文用量口径修正与实际模型提取 · 技术记录

> 2026-07-19。解决两个问题：① 状态栏上下文水位虚高（多轮工具调用时约放大 num_turns 倍，实测 35.6k 被显示为 60.5k）；② 用量统计中的模型名是中转站配置别名（`qusc`），而非实际执行推理的真实模型（如 `deepseek-v4-flash`）。
> 前置背景见 `docs/context-cost-meter-plan.md`（Phase 1 数据链打通）。
> 验证环境：Claude CLI 2.1.205，Anthropic 协议中转端点，七组 stream-json 实测样本。

## 1. 问题背景

### 1.1 水位虚高

Phase 1 之后（commit `20b337c4`），上下文水位分子取自 `result` 事件的 `modelUsage` 累计求和。用户实测发现与 CLI `/context` 官方读数严重不符：

| 数据源 | 读数 | 说明 |
|--------|------|------|
| CLI `/context` 官方读数 | **35.6k / 200k (18%)** | 真实上下文占用 |
| Polaris 状态栏（修正前） | **60.5k (30%)** | 虚高 70% |

根因：`result.modelUsage` 是**本次 run 内所有 API 调用的累计计费量**，不是任一时刻的上下文快照。一条消息触发 N 轮工具调用就有 N 次 API 调用，每次都把全量上下文作为 input 重新发送，累计值 ≈ N × 真实水位。commit `20b337c4` 注释中“与 `/usage` 输出口径一致”对**成本统计**成立，但 `/usage` 是计费口径；水位应对标 Claude Code 状态行口径（最近一次 API 调用的快照）。

### 1.2 模型名失真

`init` 事件的 `model` 字段与 `result.modelUsage` 的 key 均为 `qusc`——这是**请求侧**的配置别名（用户在设置中配置、CLI 原样发出）。而 API 响应中 `message.model` 返回的才是**响应侧**实际执行模型（如 `deepseek-v4-flash`）。中转站是动态路由池，实测同一 run 内两轮调用可路由到不同模型（`glm-5.2` → `sensenova-6.7-flash-lite`），因此“实际模型”是**每轮属性**而非会话常量。

附带结论：`costUSD` 是 CLI 对未知别名按默认定价估算的，对中转站模型仅供参考。

## 2. 验证结论（CLI stream-json 实测）

### 2.1 各事件的用量数据分布

| 事件 → 字段 | 内容 | 实测结论 |
|---|---|---|
| `stream_event` → `message_delta.usage` | 每次 API 调用流末尾发一次，该轮完整用量 | ✅ **唯一可靠的水位快照源**。与 `/context` 两次逐 token 吻合（35572↔35.6k、37174↔37.2k）；携带缓存字段 |
| `assistant` → `message.usage` | 理论上是单轮快照 | ❌ 中转端点下**恒为 0**：CLI 从 `message_start.usage`（中转站不填，全 0）复制，且 assistant 事件在 message_delta 到达前发出。官方端点下应有值（未实测），仅可做兜底 |
| `result` → 顶层 `usage` | **本 run 内各轮之和** | 四次实测 `sum(message_delta) == result` 精确相等 |
| `result` → `modelUsage` / `total_cost_usd` | **CLI 进程生命周期累计** | 同进程双消息实测：第二个 result 的 modelUsage = 54808 = 24248 + 30560（跨 run 累加） |
| `system/init`、`system/thinking_tokens` | 无 token 用量 | thinking_tokens 为 2.1.205 新增的思考量估算事件，解析层静默忽略 |

关键区分：顶层 `usage` 是 per-run，`modelUsage`/`total_cost_usd` 是进程累计——单 run 进程中两者恰好相等，掩盖了语义差异。

### 2.2 进程模型与累计安全性

Polaris 每条消息独立起 CLI 进程（`claude.rs continue_session` 先 kill 旧进程再 `--resume` 新进程），因此进程累计等价于本 run 值，**前端跨消息累加会话总量安全、不双计**。

### 2.3 其他实测事实

- 正确水位公式 = **最后一轮** `message_delta.usage` 的 `input + cache_creation + cache_read`；前提 flag `--include-partial-messages` Polaris 基底命令已无条件携带（`claude.rs:470/587`）。
- `--resume` 续接时 CLI 会截断历史大工具结果（microcompact），水位可能**下降**——不可做单调递增假设；快照口径天然正确处理。
- `message_delta.usage` 的缓存字段按需出现（无命中时省略），解析需按可选处理。
- `/context` 的分类明细（System tools/MCP/Memory/Skills）不在 stream-json 数据流中；已验证可通过 headless `--resume <sid>` + stdin 发 `/context` 解析文本获取，可作后续详情卡增强。

## 3. 修正方案

### 3.1 双口径设计

`UsageEvent` 增加 `scope` 字段区分两套口径，各归其位：

| scope | 数据源 | 语义 | 用途 |
|-------|--------|------|------|
| `"turn"` | `message_delta.usage`（每轮流末尾） | 单次 API 调用快照，后到覆盖先到 | **水位条基准**（对标 `/context`）；水位随流式逐轮实时更新 |
| `"cumulative"` | `result.modelUsage` 求和（退化顶层 `usage`） | 本 run 累计 | 成本、按模型明细、会话总量累加（对标 `/cost`） |
| 缺省（`None`） | Codex/SimpleAI 等其余引擎 | — | 前端按 cumulative 兜底，行为与修正前一致，零回归 |

### 3.2 前端分流状态机

`eventHandler` 以 `turnSnapshotSeen` 标志衔接两类事件：

- **turn 事件**：只覆盖水位三元组（input/cacheCreation/cacheRead），置 `turnSnapshotSeen = true`，`contextSource = 'turn'`；不触碰成本/明细组。
- **cumulative 事件**：更新成本与明细组（output/totalOutput/modelUsage/rawPayload/contextWindow）并累加 `sessionTotals`；**仅当本 run 未收到过 turn 快照时**才兜底覆盖水位（`contextSource = 'cumulative'`，UI 标注“估算”），随后复位 `turnSnapshotSeen`——保证下一 run 若无快照（非流式端点）时累计兜底仍能接管，不停留在陈旧快照。

防御：后端对 `message_delta` 缺 usage 或输入侧全 0 的情况不发事件，避免把水位误置零。

### 3.3 实际模型提取

- 解析层维护 `stream_model`：`message_start`（流式路径）与完整 assistant 消息（整段回退路径）提取 `message.model`，跨轮保留最近值。
- turn 快照携带该轮实际模型（`actual_model`）；cumulative 携带最近观测值。
- 前端 `actualModel`（最近一轮）+ `actualModels`（会话内出现过的模型，去重保序）记录动态路由分布。

### 3.4 会话总量统计

`sessionTotals`（input/cacheCreation/cacheRead/output/costUsd/runs）由前端跨消息累加每次 run 的 cumulative 事件；成本以 `result` 顶层 `total_cost_usd` 为权威，缺失时退化到 `modelUsage` 逐项 `costUSD` 求和。

## 4. 核心文件变更

### 后端（Rust）

| 文件 | 变更 |
|------|------|
| `src-tauri/src/models/ai_event.rs` | `UsageEvent` 新增 `scope` / `actual_model` / `total_cost_usd` 字段与 `with_scope` / `with_actual_model` / `with_total_cost_usd` builder；口径文档注释重写 |
| `src-tauri/src/ai/event_parser.rs` | ① `parse_stream_event_chunk` 新增 `message_delta` 分支：提取 usage 发 `scope="turn"` 快照事件（输入侧全 0 不发）；② `message_start` 分支与 `parse_assistant_event` 记录 `stream_model`（响应侧实际模型）；③ `parse_result_event` 标 `scope="cumulative"`、提取顶层 `total_cost_usd`、携带实际模型；④ 新增 3 个单元测试（快照发射/缺失忽略/累计透传，数值取自真实样本） |

### 前端（TypeScript）

| 文件 | 变更 |
|------|------|
| `src/ai-runtime/event.ts` | `UsageEvent` 接口新增 `scope` / `actualModel` / `totalCostUsd`，双口径注释 |
| `src/stores/conversationStore/types.ts` | `UsageStats` 语义拆分：水位三元组（turn 优先）与成本组；新增 `contextSource` / `turnSnapshotSeen` / `actualModel` / `actualModels` / `sessionTotals`（新增 `SessionUsageTotals` 接口） |
| `src/stores/conversationStore/eventHandler.ts` | `case 'usage'` 重写为双口径分流状态机（§3.2）；新增 `mergeActualModels` 去重合并；`sessionTotals` 跨消息累加 |
| `src/components/Chat/ContextMeter.tsx` | 主圆环公式不变（数据源已换快照）；详情卡新增：“估算”标记（cumulative 兜底时）、“实际模型”行（多模型显示 +N 与路由链提示）、“会话累计”区（合计 token/总花费/消息数，对标 `/cost`）；模型明细区标题改“本轮累计 · 按模型”并在配置名旁标注实际路由 |
| `src/stores/conversationStore/eventHandler.usage.test.ts` | 新增回归测试 8 例：turn 只刷水位/快照覆盖/cumulative 保持快照并复位/无快照兜底/复位后重新接管/实际模型去重/会话累计/成本退化路径 |

`ChatStatusBar.tsx` 无需改动（仅透传 `usageStats`）。

## 5. 验证结果

| 验证项 | 结果 |
|--------|------|
| `cargo check --lib --tests` | 通过（warning 均为预存 dead code；本机因 Tauri DLL 限制无法运行 lib 测试，以编译验证替代——既有约定） |
| `tsc --noEmit` | 本次改动文件零错误（仅 6 个预存无关 TS6133） |
| `vitest eventHandler.usage.test.ts` | **8/8 通过**，断言数值全部取自真实 CLI 样本 |
| 口径对账 | `message_delta` 快照与 `/context` 官方读数两次逐 token 吻合；`sum(delta) == result` 四次精确相等 |

人工验证路径：应用内发一条多工具调用消息（如“列出当前目录下的文件路径”）再续聊一条，详情卡应看到主水位接近 `/context`、“实际模型”显示当轮真实模型、“会话累计”随消息数递增。

## 6. 已知边界

- 官方 Anthropic 端点下 `assistant.message.usage` 应有值（协议行为），本机仅有中转端点未实测；该路径仅影响兜底可用性，不影响主路径。
- 端点不支持流式导致整段回退（无 `stream_event`）时，无 turn 快照，水位由 cumulative 兜底：单轮 run 时兜底值即真实值；多轮 run 时回到修正前的偏大行为（UI 有“估算”标注）。
- 中转站自定义模型的 `costUSD` / `total_cost_usd` 按 CLI 默认定价估算，展示仅供参考。
- `modelUsage` 的用量无法按实际路由模型拆分（result 只给配置名维度）；当前仅标注路由分布，不做用量归因。
