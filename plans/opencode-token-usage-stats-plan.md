# opencode 引擎 token 用量统计补全方案

> 目标：让 opencode 引擎的 token 用量进入 Polaris 的「Token 统计面板」（usage_db），并消除引擎侧遗留的过时注释/语义风险。
> 不动实时水位链路（已验证健康），不引入新依赖。
> 状态：分析完成，待评审实现。

## 一、现状盘点（四条数据链 + 实测证据）

| # | 数据链 | 现状 | 结论 |
|---|---|---|---|
| 1 | opencode 自身统计（共享 DB `~/.local/share/opencode/opencode.db` + `/api/experimental/session/stats`） | 完整：1077 条 assistant 消息带 `tokens.{input,output,reasoning,cache}`；session_v2 有 tokens_* 列 | 无需改动 |
| 2 | 实时水位 ContextMeter（`AIEvent::Usage` → conversationStore → ChatStatusBar） | opencode 引擎已发出 Usage（生产日志 EOF `finish=true` 为常态），前端 `case 'usage'` 无条件更新水位 | 已通，不动 |
| 3 | 会话级汇总（dialogStorage TokenUsageSummary） | 由 `usageStats.sessionTotals` 提取，opencode 走同一路径 | 已通，小瑕疵见 §三-3 |
| 4 | **Token 统计面板（usage_db，设置页）** | `record_usage` 仅 3 处调用：`simple_ai/chat_loop.rs`、`pi_parser.rs`、`proxy/handlers.rs`。**opencode / claude-code 引擎路径均未接入** | **根因缺口** |

面板数据源自述（`TokenStatsTab.tsx` 头注释）：「代理层 SQLite，覆盖所有**经过代理的** API 请求」。CLI 引擎（opencode 连 opencode 官方/免费档、claude 连 anthropic）不经 Polaris 代理 → 面板永远无数据。`ENGINE_OPTIONS` 里也无 opencode 选项。

### 关键实测证据（2026-10-18，本机 opencode v2.0.30）

1. `opencode run --format json --standalone`：吐 `step_start → text → step_finish`，`step_finish` 带 `cost + tokens.{input,output,reasoning,cache{read,write}}`。
2. **共享服务模式（不带 `--standalone`）实测不吐 `step_finish`**（只有 step_start/text）——与 `ai/engine/opencode.rs` 头注释「没有 step_finish」的旧观察一致；该注释在引入 `--standalone`（Rev3）后已过时，`build_command` 现恒带 `--standalone`，StepFinish 分支实际在生效。
3. Polaris 生产日志（`Polaris-dev/logs/app.log.2026-10-17`）大量 `finish=true`：引擎层 Usage 事件一直在发。

### 语义口径备注

- opencode 的 `step_finish` tokens 是**单轮 API 调用快照**（等价 Claude 的 turn 口径），当前引擎发 Usage 时 `scope` 缺省 → 前端按"逐条增量累加"处理：
  - 水位（input/cacheRead 顶层）由最后一条覆盖 = 最后一轮快照，口径正确；
  - `sessionTotals` 逐条累加 = run 全程累计，口径正确；
  - 仅 `sessionTotals.runs` 计数把"每个 step"当"一条消息"，详情卡「N 条消息」偏大（小瑕疵，可在方案 A 中一并修）。

## 二、可选方案对比

### 方案 A（推荐）：中央事件管线拦截 Usage → record_usage

在 ai_chat_core 的中央 dispatch（现有影子写入 `append_session_event` 同级，约 ai_chat_core.rs:1068/1591 两处）拦截 `AIEvent::Usage`，调用 `usage_db::record_usage`。

- 收益：覆盖**所有**引擎（顺带把 claude-code 也补进面板）；单一口径、单点维护；不触碰引擎实现。
- 前置改动：`UsageEvent` 需携带 `engine_id` + `model`（record_usage 必填参数），当前事件没有。
  - `models/ai_event.rs`：UsageEvent 增加可选 `model: Option<String>`（`engine_id` 可从 dispatch 上下文取，若中央处无引擎上下文则同样加可选字段）；
  - `src/ai-runtime/event.ts` + `UsageStats` 类型双向同步（协议改动，无运行时校验，保持可选字段向后兼容）；
  - opencode.rs / claude.rs 发 Usage 时填入（opencode 已知 `options.model` / 兜底 `opencode/glm-5.3-flash-free`）。
- 去重口径：opencode 每 step 一条 Usage = 增量记录（正确）；claude 每条 result 一条 = run 累计（正确）。面板按条聚合天然正确；"run 数"显示语义随 engine 分组看待。

### 方案 B（否决为主）：读 opencode 共享 DB 反查用量

rusqlite（已依赖，bundled）从 `~/.local/share/opencode/opencode.db` 按会话查 `session_v2.tokens_*`。

- 否决理由：只覆盖 opencode、依赖 opencode 内部 schema（版本漂移风险）、DB 路径/env（`OPENCODE_DB`）解析需额外 spawn `opencode debug paths db`、onica WAL 并发读时序复杂。
- 保留价值：可作为方案 A 的对照校验手段（开发期手动核数），不进入产品链路。

### 方案 C（否决）：前端定推 usageStats 到后端

写路径双份（前端缓存 vs 权威库）、依赖前端在线，违背"单一写入路径"原则。

## 三、实现清单（方案 A）

### 后端（src-tauri/src/）

1. `models/ai_event.rs`：UsageEvent 增加 `model: Option<String>`（可选、向后兼容）+ `with_model()`；视中央上下文情况加 `engine_id: Option<String>`。
2. `ai/engine/opencode.rs`：
   - 更新头注释：v2.0.30 + `--standalone` 实测有 `step_finish`（带 tokens/cost）；共享服务模式才缺。EOF 判定仍不依赖它。
   - 发 Usage 时 `with_model(effective_model)`；同时补 `with_total_cost_usd(part.cost)`（free 档恒 0，付费档有价值）。
   - `ai/engine/claude.rs` 同理补 model（若低风险）。
3. `services/ai_chat_core.rs` 两处中央 dispatch：新增 `AIEvent::Usage(u)` 分支 → `usage_db::record_usage(...)`（engine_id/model 优先取事件字段，兜底 dispatch 上下文）。失败仅 warn，不阻断。
4. `components/Settings/tabs/TokenStatsTab.tsx`：`ENGINE_OPTIONS` 增加 `{ value: 'open-code', label: 'OpenCode' }`（以引擎 ID 实际落库值为准）。

### 前端（src/）

5. `ai-runtime/event.ts`：`UsageEvent` 增加可选 `model` 字段（camelCase 对齐）。
6. `eventHandler.ts` `case 'usage'`：透传 `model` 到 `UsageStats`（可选），供 ContextMeter 详情卡展示（现 `actualModel` 来自 result 侧，有则不覆盖）。

### 顺手小修（低风险）

7. `sessionTotals.runs` 对"逐条增量"型引擎的计数语义：本方案不改（opencode 每 step 一条属增量，累加正确；runs 偏大已知，留待 UI 备注）。

## 四、验收

- [ ] `cargo check` 通过
- [ ] `pnpm exec tsc --noEmit` + `pnpm lint` 通过
- [ ] dev 启动，用 opencode 引擎完成 2 轮对话（含工具调用），设置 → Token 统计面板出现 open-code 条目，input/output/cache 数字与 opencode 共享 DB（`/api/experimental/session/stats` 或 `session_message.data.tokens`）一致
- [ ] claude 引擎一轮对话，面板出现 claude 条目（若实现了 claude 侧 model 填充）
- [ ] 实时水位（ContextMeter）行为与改动前一致（回测一轮含工具调用的对话）

## 五、风险与边界

1. **协议无运行时校验**：UsageEvent 加字段必须双边同步，新字段全 Optional，老版前端读到新事件应无感（skip_serializing_if 已有先例）。
2. **成本列是估算**（`estimate_cost` 按模型价格表）：free 模型会被估出非零成本——如需精确，后续在 estimate_cost 增加 free 档零价名单，非本 spec 范围。
3. **不动 opencode 共享服务语义**：`--standalone` 是 step_finish 的前提（§一实测 2），移除会退化；在 build_command 注释中补充此依赖说明。
4. **多 run 幂等**：opencode 每 run 新进程、每 step 增量上报，重启/续接不产生重复记录（usage_db 每条 INSERT 幂等）。
