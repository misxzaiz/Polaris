# Polaris 重构 · 第六步：AI 流式能力上总线（StreamingCapability 生产化）

> 状态：规划定稿（未实施）
> 日期：2026-09-12
> 原则：**先实现新骨架，再一块块替换，不着急**。流式骨架 + demo 先行；AI 薄包装（C1）作为
> 第一个真实流式能力并行于现有聊天链路，不碰现有前端；chat.rs 全量上总线（C2）不在本步。
> 配套可视化原型：动工前补（沿用第三/四步节奏）。

---

## 0. 承接

- 前五步已落地：契约冻结 → SqliteStorage → RouterBus（dispatch 唯一入口）→ cap.kv /
  cap.todo / cap.prompt_snippet 闭环 → 权限 gate（PolicyPermission）+ 审计（FileAuditSink
  哈希链 + domain_audit 同事务）。
- 契约面剩余最大缺口：**`StreamingCapability`（contracts/mod.rs:218-224）零实现**——
  借鉴分析点名的三个零实现契约（Session/Scheduler/AuditSink）中 AuditSink 已补，
  流式是下一个，也是 AI 这个核心产品路径与总线的关系问题。
- 第四步延续的域迁移（requirement/history/context/config）按 playbook 随时可插，
  与本步并行不冲突（§6）。

---

## 1. 关键判断（2026-09-12 代码级核实）

### 1.1 现状：聊天完全不走总线

| 环节 | 现状 | 证据 |
|---|---|---|
| 入口 | `start_chat` / `continue_chat` 命令 → `*_inner` 业务函数 | `commands/chat.rs:2013/2043` |
| 执行 | 锁 `engine_registry`（`Arc<AsyncMutex<EngineRegistry>>`）→ `AIEngine::start_session` 同步返回 session_id，引擎内部 spawn 读线程 | `chat.rs:1519`、`ai/registry.rs:186`、`ai/engine/claude.rs:851` |
| 事件 | `AIEvent`（30+ 变体，snake_case tag）经 event_callback → 双通道：Tauri `emit("chat-event")` + `EventBroadcaster`（`{"event":"chat-event","payload":...}`） | `models/ai_event.rs:1580`、`chat.rs:1989-1996` |
| 前端 | 单通道 `chat-event` → EventRouter（contextId 路由）→ conversationStore eventHandler → message.blocks；中断/审批走命令（approve_plan/reject_plan/interrupt_chat） | `hooks/useAppEvents.ts:41`、`services/eventRouter.ts:73` |
| 总线 | dispatch 无任何流式分支；`StreamingCapability` 全仓仅契约定义一处；`Box<dyn Capability>` 无 downcast 机制 | `services/router/mod.rs:197` |

### 1.2 三个可借的支点

1. **信封同形**：`broadcast_chat_event` 发 `{"event":"chat-event","payload":...}`，
   `EventAdapter.encode_event` 产出 `{"event":kind,"payload":...}`（`event_adapter.rs:84-90`）。
   **流式能力只要发 `Event{kind:"chat-event", payload:{contextId,payload:AIEvent}}`，
   WS 线格式与今天 100% 一致** —— 前端零改动即可消费，兼容通道天然成立。
2. **sky 的平行表方案**：`Box<dyn Capability>` 与 `Arc<dyn StreamingCapability>` 不兼容，
   sky 用独立 `streaming_caps` 注册表 + dispatch 内检测（`do/sky/src/router.rs:152-153,451`），
   流式命中返回 `Reply{stream:true, stream_id, trace}` 立即应答，否则落同步 invoke。
   Polaris 采纳同构方案，**不改冻结的 Capability trait**（不加 as_any）——契约注释的
   "dispatch 检测能力是否实现此 trait" 以"检测平行表"落实，偏差记录在案。
3. **宿主状态可自持**：`engine_registry` Arc 在 `create_app_state` 签名就位（`state.rs:314`），
   状态化 capability 在注册点捕获即可；契约 Context 无扩展槽且是借用（invoke_stream 返回的
   Receiver 活得比 ctx 久，spawn 任务带不走 ctx）——**引擎句柄必须由能力自持**，这正是
   borrow 约束的正确用法（借鉴分析 §推理链）。

### 1.3 真正的工作量在 chat.rs 回调栈

`ChatCallbacks` / 会话簿记 / Profile failover / 用量统计（usage_db、ProfileStatsCollector）
全部长在 `chat.rs *_inner`。全量上总线（C2）是一次大手术，不进本步。本步只做 **C1 薄包装**：
能力直接驱动引擎、把 AIEvent 泵进总线，服务**新消费方**（未来的 agent / scheduler /
第三方面板），现有聊天链路原样并行。C2 留作第七步评估。

---

## 2. 交付清单

### A. RouterBus 流式骨架（阶段 A，先做 + 单测）

**文件**：`services/router/mod.rs`（+ 新增 `stream.rs` 可选）

- 平行流式注册表：`streaming_caps: RwLock<HashMap<CapabilityId, Arc<dyn StreamingCapability>>>`，
  `register_streaming(cap)`（RouterBus 固有方法，**不进冻结的 Router trait**）。
- `dispatch_stream(env: Envelope) -> Result<StreamAck, String>`（固有方法）：
  1. 广播 `dispatch.start`（与同步 dispatch 同形）
  2. 权限 gate（PolicyPermission 同一矩阵）
  3. 查流式表 → `invoke_stream(params, &ctx)` → 拿 `Receiver<Event>`
  4. **spawn 泵任务**：逐 Event → `EventAdapter.broadcast`（seq 由广播器注入，
     事件 trace 统一覆写为 env.trace）；sender 关闭 → 广播 `dispatch.end(status=ok)`；
  5. 立即返回 `StreamAck { msg_id, trace }`（对齐 sky 的 stream_id 语义，字段名对齐契约习惯）。
- 同步 `dispatch` 行为不变；目标命中流式表时返回明确错误
  `"流式能力请走 dispatch_stream"`（防误用）。
- 事件 kind 约定：能力自定（AI 用 `chat-event`，见 C）；骨架只约定
  `dispatch.start/end` 追踪事件与 trace 覆写规则。
- 单测（verify crate 可跑）：注册→dispatch_stream→逐条收事件→结束收 dispatch.end；
  未注册 Err；同步表误调提示；权限 deny 落审计；Filter 订阅过滤。
- **边界**：不做流内取消（cancel 通道后置，见 §3）。

### B. demo 流式能力（阶段 B）

`cap.stream.echo`：收到 `{ "count": N, "intervalMs": M }` 后按间隔发 N 条
`Event{kind:"stream.echo", payload:{i}}` 再关闭——验证 泵任务 → EventAdapter →
WS + in-proc 订阅 全链路，及 borrow 约束下的 spawn 模式（能力自持计数器，
不捕获 ctx）。测试台（面板）可选支持 dispatch_stream 的事件流展示——可推迟到 C1 联调时。

### C. cap.ai.chat —— 第一个真实流式能力（阶段 C，C1 薄包装）

**文件**：`services/router/ai_chat_capability.rs`（新增），`state.rs` 注册

- 状态化能力：注册点捕获 `engine_registry: Arc<AsyncMutex<EngineRegistry>>`
  （与 KvCapability 等 unit struct 不同，契约无此限制）。
- 动作协议（payload `{ "action": ... }`）：
  - `start`：`{ engineId, message, workDir?, sessionId?, allowedTools?... }` →
    引擎 `start_session`，返回 `{ sessionId }`（StreamAck 之外的业务 ack 走 Reply？——
    不，dispatch_stream 只回 StreamAck；sessionId 作为第一条事件
    `Event{kind:"chat-event", payload:{contextId, payload:AIEvent::SessionStart}}` 推送）
  - `continue` / `interrupt`：对齐引擎 trait 对应方法
  - 事件泵：event_callback 内把 `AIEvent` 包成
    `Event{ kind:"chat-event", payload:{ contextId, payload: <AIEvent> } }` 发入 mpsc
    ——与现有 WS 线格式逐字节兼容，前端 EventRouter 无需改动。
- **C1 明确不含**（对齐 chat.rs 现状逐项列出，防隐性回归预期）：
  pending_plans / dispatched_tasks 簿记、Profile failover 统计、usage_db 挂钩
  （用量仍由引擎解析器层记录，不动）、`session_start` engineId 注入等 chat.rs 特有逻辑
  的等价物按需最小实现。
- 用途定位：**新消费方专用通道**（scheduler 任务、未来 agent、第三方），
  现有聊天 UI 继续走 start_chat —— 兼容通道并行，C2（chat.rs 上总线）另行评估。

### D. 安全配套（阶段 D，小而独立）

- **Remote{token} 真实注入**：web 桥（`web/api/ipc.rs` 的 dispatch / dispatch_stream）
  把 HTTP 中间件已验证的 token 填入 `Source::Remote{token}`（现在是空占位）；
  审计仍脱敏（只落变体名），风险不变。
- **收紧规则首批候选**（PolicyPermission 规则已支持，何时启用单独裁决）：
  - `cap.ai.chat* → remote: deny`（AI 执行最敏感；启用会废掉远程聊天，需产品裁决）
  - `cap.config* → remote: deny`（管理面写；cap.config 迁移后即具备启用条件）
- 决策记录：AI 用量/审计挂点维持现状（usage_db 在引擎层、总线层只记 dispatch.ok/deny），
  本步不合并两套统计。

---

## 3. 边界（做/不做）

- ❌ 不做 C2：chat.rs 全量上总线（pending_plans / failover / 簿记迁移另行评估）
- ❌ 不做流内取消通道（interrupt 仍走命令；dispatch_stream cancel 后置）
- ❌ 不改冻结契约：Router trait 不加方法、Capability 不加 as_any
  （"dispatch 检测"以平行表实现等价语义，偏差记录于 §1.2）
- ❌ 不动现有前端聊天链路（兼容通道并行；EventRouter / conversationStore 零改动）
- ❌ 不合并 usage_db 与总线审计两套统计
- ✅ 同步 dispatch / 既有三能力 / 权限审计行为零变化（平行表纯新增）

## 4. 验收标准

1. `cargo check` 三重 + verify crate 单测全绿（流式骨架 + demo + cap.ai.chat）。
2. `cap.stream.echo`：dispatch_stream → mpsc 订阅逐条收到 → dispatch.end 语义正确。
3. `cap.ai.chat`：经 Web（9829，带 token）dispatch_stream 真实拉起 claude 引擎，
   WS 上收到与 `chat-event` 同形的 token 流；同时 Source/审计记录正确
   （Remote{真实 token 注入、审计脱敏}）。
4. 现有聊天回归零影响：start_chat 路径、EventRouter、conversationStore 不变，
   vitest + tsc 零新增错误。
5. 同步 dispatch 对流式能力目标返回防误用错误（单测覆盖）。

## 5. 影响面

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🟡 中 | router 新增平行表 + 泵任务；state.rs 注册一处；web 桥 token 注入一处 |
| 前端 | 🟢 零（本步） | 兼容通道并行；测试台流式展示可选 |
| 契约 | 🟢 冻结不动 | 偏差（平行表 vs downcast 检测）已记录 |
| 风险 | 🟢 低→🟡 | A/B 纯新增低风险；C1 触引擎但绕开 chat.rs 簿记，独立通道无回归面 |

## 6. 实施顺序与并行关系

- **阶段 A**（骨架+单测）→ **阶段 B**（demo 实测）→ **阶段 C1**（cap.ai.chat）→ **阶段 D**（token 注入 + 规则候选记录）。
- 与第四步延续**并行不冲突**：requirement / history / context 迁移块按 playbook 随时可插；
  **cap.config 已被第五步阶段 C 解锁**，建议作为下一个迁移块（顺带为 §2.D 的
  `cap.config* remote deny` 规则启用创造条件）。
- 第七步候选（记录防丢）：C2 全量上总线评估 / Session-Scheduler 契约落地 /
  token 强制 + CORS 收紧立项。
