# opencode/claude 引擎 token 用量接入统计面板（实现落地）

> 状态：**实施中**
> 创建：2026-10-19
> 依据：`plans/opencode-token-usage-stats-plan.md`（分析完成，待评审实现），本 spec 为落地方案。
> 涉及仓库：仅 `D:\space\base\Polaris`（后端 + 前端）。

---

## 一、目标与现状

### 目标
让 **opencode / claude-code** 引擎的 token 用量进入设置页「Token 统计面板」（usage_db），并让面板可按引擎筛选。

### 现状盘点（实测确认）
- `record_usage` 目前仅 3 处调用：`simple_ai/chat_loop.rs`、`pi_parser.rs`、`proxy/handlers.rs`。**opencode / claude-code 引擎路径未接入** → 面板永远无这两类数据。
- `UsageEvent` 已有 `actual_model: Option<String>`、`total_cost_usd: Option<f64>`、`scope` 等字段（Rust `models/ai_event.rs` + 前端 `ai-runtime/event.ts` 已双边同步，**无需改协议**）。
- claude 引擎的 Usage 由 `ai/event_parser.rs` 构造，已带 `with_total_cost_usd` + `with_actual_model`（response 侧模型）。
- opencode 引擎的 Usage 在 `opencode.rs` `OpencodeEvent::StepFinish` 分支构造，**未带 actual_model 与 cost**（`StepFinishPart` 已有 `cost: Option<f64>` 与 `tokens`，只是没透传）。
- 中央 dispatch 在 `ai_chat_core.rs` `start_chat_inner` 的 `event_callback` 闭包（~1067 行），是拦截 Usage 的统一位置，且能拿到 `engine_str`。

### 关键去重决策（避免双写）
SimpleAI / PiParser **已在引擎内部**调用 `record_usage`。若中央对所有 Usage 事件统一落库，会造成 **simple-ai/omp 双写**。因此：

- **中央拦截只处理「引擎内部未自行落库」的引擎**（opencode / claude-code / 插件引擎等）。
- 判定依据：`engine_str` 命中 `simple-ai` / `omp` / 代理路径时跳过（这些引擎已自管落库）；其余一律由中央兜底。
- 不引入新字段、不改引擎落库行为，单一写入路径原则保持。

---

## 二、改动清单

### 后端

1. **`src-tauri/src/ai/engine/opencode.rs`**
   - `spawn_event_reader` 签名：`options: SessionOptions` 移入前先取出 `let engine_model = options.model.clone()`（None 时兜底 `opencode/glm-5.3-flash-free`，与 `build_command` 的 effective_model 语义一致），作为参数传入 reader 线程。
   - `OpencodeEvent::StepFinish` 分支构造 `UsageEvent` 时：
     - `.with_actual_model(Some(engine_model))`（None 时不覆盖，保持缺省）
     - `.with_total_cost_usd(part.cost)`（cost 为 Option，直接透传）
   - 头注释更新：`--standalone` 模式实测有 `step_finish` 带 tokens/cost；共享服务模式才缺（对齐 plan §一 实测 2）。

2. **`src-tauri/src/services/ai_chat_core.rs`**（`start_chat_inner` 的 `event_callback`）
   - 新增 `AIEvent::Usage(u)` 分支：
     - `engine_str` 为 `simple-ai` / `omp` / `proxy` 时跳过（引擎自管，防双写）；
     - 其余：`usage_db::record_usage(model=u.actual_model.unwrap_or("unknown"), engine_id=Some(engine_str), input/output/cache 字段, latency=0, status=200, is_streaming=true)`；
     - `spawn_blocking` 包裹（`usage_db` 全局单例持 `std::sync::Mutex`，避免阻塞 tokio worker）；失败仅 warn 不阻断。
   - 判断 `u.input_tokens + cache 全 0` 时跳过（空用量不落库，与 event_parser 行为对齐）。

### 前端

3. **`src/components/Settings/tabs/TokenStatsTab.tsx`**
   - `ENGINE_OPTIONS` 增加：`{ value: 'open-code', label: 'OpenCode' }`、`{ value: 'claude-code', label: 'Claude Code' }`。
   - `inferEngine` 补充：`glm` / `openai` 前缀归入 `opencode`？不 —— 保持最小改动：仅新增筛选条目，推断逻辑不动（面板数据 engine 字段来自落库 `engine_id`，实际值以 `log_usage` 写入为准）。

---

## 三、边界与风险

| 风险 | 缓解 |
|---|---|
| 中央拦截与引擎自管双写 | 白名单跳过 `simple-ai`/`omp`；`proxy` 路径的 Usage 事件不在引擎 dispatch 链（代理 handler 自管），兜底判断无副作用 |
| `engine_str` 取值漂移 | 中央拦截用 `start_chat_inner` 已持有的 `engine_str`（会话级），与 SessionStart 注入的 engineId 同源 |
| opencode `--standalone` 才吐 step_finish | 现状已恒带 `--standalone`（build_command），无需行为变更；注释说明依赖 |
| 协议无运行时校验 | 本改动**不改任何协议字段**，仅消费已有字段，前后端零漂移风险 |
| 空用量落库污染面板 | 中央拦截前过滤 `input+output+cache 全 0` |

---

## 四、验收

- [ ] `cargo check` 通过，无新增 warning
- [ ] `pnpm exec tsc --noEmit` + `pnpm lint` 通过
- [ ] opencode 引擎一轮对话 → 面板出现 open-code 条目，input/output 与 opencode step_finish tokens 一致
- [ ] claude 引擎一轮对话 → 面板出现 claude-code 条目（engine_id 落库）
- [ ] simple-ai 一轮对话 → 面板条目数不重复（无双写）
- [ ] 实时水位 ContextMeter 行为与改动前一致（Usage 事件照常透传前端）
