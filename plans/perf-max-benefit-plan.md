# dispatch.start/end 可观测广播与 WS 数据通道解耦——高频 dispatch 不再污染事件总线与断线重连缓冲

> 性能治理最大收益方案（评审计分 17/12 案居首）。2026-11-01 定案。
> **v2（2026-11-01）**：依审读意见逐条修订——修正广播语句计数（11 处，原 9/7 自相矛盾）、改写冒烟 2/4（原步骤在当前代码下不可执行）、重写目标 3（原表述与 §2.3 面板实证自相矛盾）、补全回归面（2 测试函数 4 处断言点，原漏 mod.rs:1544-1545）、修正插件仓 grep 表述（原对不存在的 `Polaris-plugin/src` 路径 grep 且报错被 shell 吞掉，本次已用仓根正确路径重跑）、修正 webReconnectResync 第三环函数引用、修正 §七混合流算术、行号漂移与出处错位逐条更正。
> 证据状态：本文全部 path:line 均由主笔在本会话逐文件打开复核（git HEAD `bc87eacb`，工作区含未提交的 session-badge 改动，不触及本方案文件）；v2 修订涉及的新行号亦全部实读。
> 关联：`plans/audit-startup-firsttoken-root-cure-spec.md`（kv 洪水实证）、AGENTS.md §二/§六/§七。

---

## 一、结论

RouterBus 对**每一条** dispatch 无条件广播 `dispatch.start` 与 `dispatch.end`，经 EventAdapter 全量进入 `EventBroadcaster`（seq 注入 + 重放缓冲 push + WS 分发），而**全仓（前端 src/、后端 src-tauri/、插件仓 Polaris-plugin 全树）零消费代码**——唯一命中是一句 UI 提示文案（`ContractExplorerPanel.tsx:655`）加三处注释（`commands/router.rs:159`、`services/router/ai_chat_capability.rs:859`、demo/stream_echo 夹具 doc，见 §2.3）。生产实证 kv 插件轮询约 60 dispatch/秒（审计链 10-30 观测），即每秒 ~120 条纯噪声广播持续污染两样东西：

1. **断线重连重放缓冲**（2000 条环形缓冲，`src-tauri/src/web/event_broadcaster.rs:19`）：60 dispatch/s 下无活跃会话时 **16.7 秒滚完一轮**，缓冲淘汰后 chat-event 缺口无法增量补发，前端 resume 判 gap 后仅对「后端判定仍在流式输出」的会话走重恢复（`src/services/webReconnectResync.ts:39,77`），其余缺口只能靠手动「同步恢复」（`:88` 起）或页面重载后重拉历史——缓冲的核心设计场景被无价值事件实质废掉；
2. **桌面 4 个中继任务**（`lib.rs:659/683/707/737`）每条消息 recv 后 `serde_json::from_str` 全量 parse 再按 kind 丢弃，120 parse/秒白烧。

本方案把 dispatch 生命周期广播降为**门控 + 分级**：11 处广播语句中，5 处进入门控（start×2 + ok end 语义×3，其中主/回退分支 end 为单语句内 ok/error 分流）——正常快路径默认只走 `tracing::debug`；6 处整体保留（deny×4 + 流式 error end×2，低频高价值）。`POLARIS_DISPATCH_TRACE=1` 一键恢复全部广播（见目标 3 的准确定位）。改动集中在 `src-tauri/src/services/router/mod.rs` 单文件（`RouterBus::new` 在 mod.rs:163），约 60-90 行，**零协议类型触碰**（Envelope/Reply/Event 结构体与 WS 消息格式均不动），回归面收敛于 router 内部 2 个测试函数 4 处断言点（§2.6）。

**诚实的收益口径**：绝对 CPU 节省微小（<0.1% 单核，见 §七），**主收益是恢复断线重连增量补发能力与事件总线语义纯度**——这是「确定性×收益÷成本」最优的一档：改动小、零协议风险、收益可直接观测。

---

## 二、背景与证据（全部本会话实读复核）

### 2.1 广播点全景（11 处语句，均在 `src-tauri/src/services/router/mod.rs`）

| # | 语句位置 | kind（@kind 字符串行） | 语义 | 处置 |
|---|---|---|---|---|
| 1 | mod.rs:342-353 | `dispatch.start` @345 | 流式 dispatch 入口 | **门控降级** |
| 2 | mod.rs:365-375 | `dispatch.deny` @367 | 流式权限拒绝 | 保留 |
| 3 | mod.rs:405-416 | `dispatch.end(error,stream)` @407 | 流式 invoke 失败 | 保留 |
| 4 | mod.rs:477-491 | `dispatch.end(error,stream)` @479 | 流式 idle watchdog 超时 | 保留 |
| 5 | mod.rs:496-506 | `dispatch.end(ok,stream)` @498 | 流式泵正常收尾 | **门控降级** |
| 6 | mod.rs:620-630 | `dispatch.start` @623 | 同步 dispatch 入口 | **门控降级**（洪水主体） |
| 7 | mod.rs:642-651 | `dispatch.deny` @644 | 同步权限拒绝 | 保留 |
| 8 | mod.rs:674-684 | `dispatch.deny` @676 | prompt pending 登记 | 保留 |
| 9 | mod.rs:708-717 | `dispatch.deny` @710 | 无审批出口拒绝 | 保留 |
| 10 | mod.rs:807-826 | `dispatch.end` @823 | 同步主分支终态（payload 按 result 分流 ok/error） | ok **门控降级** / error 保留（洪水主体） |
| 11 | mod.rs:912-922 | `dispatch.end(sync)` @914 | 同步回退分支（cap.ai.chat 同步动作路径）终态（同上分流） | ok **门控降级** / error 保留 |

> 口径声明：广播**语句共 11 处**（start×2 + deny×4 + end×5，kind 字符串行号 345/367/407/479/498/623/644/676/710/823/914）。进入门控的 **5 处**（#1/5/6 整条 + #10/11 的 ok 分支）；整体保留的 **6 处**（#2/3/4/7/8/9，deny×4 + 流式 error end×2），#10/11 的 error 分支随语句保留。上表即实施 checklist，逐条打勾。

> 另一处**既有现况**（本方案不改变、冒烟设计须知道）：同步 dispatch 对**未注册能力**走句柄 `None` 分支（mod.rs:733-741 查找、mod.rs:930-934 直接返回 `Err("能力未注册: …")`），**该分支不广播任何 dispatch.end**——start（#6 在 gate 前已广播）有、end 无。生产装配未注册 `FaultyCapability`（grep 全仓仅 `demo_capability.rs:50/52` 定义与 `mod.rs:66` re-export；state.rs 生产注册块无，state.rs:397 命中的是 import 行 `StreamEchoCapability` 子串、:564 注册的是 StreamEchoCapability），故生产调用 cap.faulty 全程不会出现 `dispatch.end(status:error)` 广播。

### 2.2 传播链路与缓冲伤害

- `EventAdapter::broadcast`（`event_adapter.rs:49-52`）：每条事件先经 `encode_event` 编码——`json!` 构造 + `to_string` 在 `encode_event` 内部**一步完成一次序列化**（`event_adapter.rs:89-95`）——再交 `EventBroadcaster::send`。
- `EventBroadcaster::send`（`src-tauri/src/web/event_broadcaster.rs:93-105`）：seq 分配 + `inject_seq` 字符串拼接 + **无订阅者也写入重放缓冲**（`:88-92` 注释明言此为锁屏场景核心诉求）+ broadcast 分发。
- 重放缓冲双上限：`REPLAY_BUFFER_MAX_EVENTS=2000`（`:19`）+ `REPLAY_BUFFER_MAX_BYTES=8MB`（`:21`），push 时双条件淘汰（`:42-56`）。dispatch 噪声 payload ~120B/条，**条数上限先触发**：60 dispatch/s ×2 = 120 条/s → 无活跃会话时 2000÷120 ≈ **16.7s 滚完**。
- 缓冲淘汰后客户端 resume 判 gap 的前端链路：transport 收 `resume-complete {gap:true}` 触发 `resyncAfterResumeGap`（`src/services/webReconnectResync.ts:5` 注释、`:14` 触发方说明、`:39` 函数签名）；该兜底**有条件**——仅恢复后端判定仍在流式输出的会话（`:77` `if (!backendRunning.get(sessionId)) continue`，后端查询失败时保守以本地 isStreaming 兜底 `:73-75`）；无条件全量恢复是另一个入口 `manualRefreshActiveSession`（`:88` 起 doc：用户主动点的状态栏刷新按钮）。即缓冲失效的真实后果：**流式会话缺口可被自动兜底重恢复，非流式缺口只能手动恢复或随页面重载重拉历史——增量补发（缓冲存在的唯一理由）失效**。
- router 广播器与 chat-event **同一实例**：`state.rs:375` 创建、`state.rs:403` `EventAdapter::from_broadcaster(event_broadcast.clone())`、`state.rs:670` `with_broadcaster(event_broadcast.clone())`——dispatch 噪声与聊天数据流共抢同一缓冲与 seq 空间。

### 2.3 零消费实证

- 前端：`grep -rn "dispatch\.start|dispatch\.end|dispatch\.deny" src/` 命中 3 处，**均非消费代码**：
  - `src/plugins/contracts/ContractExplorerPanel.tsx:655`——空态 UI 提示文案；该面板仅 `import { invoke } from '@/services/transport'`（`:19`），调用走 `invoke('router_dispatch')`（`:321`），轨迹数据来自**审计链视图**（读 `<DataRoot>/audit/dispatch.jsonl`，`:582` 注释、`:620` 标题、`:663` 解析 `action/capability/timestampMs` 字段），grep `subscribe|listen|EventSource|WebSocket` 无 WS 订阅命中；
  - `src-tauri/src/commands/router.rs:159`——「流结束时广播 dispatch.end(stream)」注释；
  - `src-tauri/src/services/router/ai_chat_capability.rs:859`——「tx 在此 drop → RouterBus 泵任务广播 dispatch.end(stream)」注释。
- 其余 src-tauri 引用均在 `services/router/` 内部（广播点自身、demo/stream_echo 夹具 doc、单测断言）。
- 插件仓：`D:\space\base\Polaris-plugin` **根目录无 `src/`**（实测根目录为 README.md、docs、examples、index.json、needs、pack-and-push.bat、plugins、schemas、scripts）；对**仓根全树**按 `*.ts/*.tsx/*.js/*.json/*.md` grep `dispatch.start|end|deny` **零命中**（v2 已用正确路径重跑跑通；v1 曾对不存在的 `<repo>/src` 路径 grep 且 stderr 被 shell 重定向吞掉、当时误记为「src/ 下零命中」——结论碰巧成立，检查方式已修正并如实记录）。
- 审批 UI 不依赖 dispatch.deny 广播：`src/components/Common/PermissionPromptHost.tsx:48` 走 Tauri `listen('permission.prompt')` 独立事件通道（PermissionPromptRegistry），**不经** event_broadcast。deny 广播保留属保守决策（低频 + 安全留痕），非消费依赖。
- RouterBus in-proc `subscribe(Filter)`（mod.rs:940-942）生产代码零调用方，仅测试使用（mod.rs:1424/1460/1510）。
- **契约测试面板与 POLARIS_DISPATCH_TRACE 正交**（v2 澄清）：面板轨迹读审计链 dispatch.jsonl（受 `should_audit_dispatch_ok` 治理），不读 WS 广播；本开关恢复的是 EventBroadcaster WS 广播，对面板数据零作用（见 §三 目标 3 的准确定位）。

### 2.4 洪水前提与既有治理边界

- `plans/audit-startup-firsttoken-root-cure-spec.md:8`：审计链 10-30 单日 +450 万条、~60 条/秒，尾部 2MB 样本 `cap.kv action=list` 占 59%、get 21%；`:28`（A3 行）：尾部 2000 条中 `cap.kv` 占 89%、Remote 源占 81%——kv 轮询即每秒 ~60 次 dispatch。
- 已落降噪闸 `should_audit_dispatch_ok`（定义 mod.rs:1009，调用点 **mod.rs:833/892**，`:828-829` 注释「降噪闸：kv 只读动作的 dispatch.ok 不入链（洪水治理）」）**只管审计链入链，不管广播**——广播洪水前提不受既有治理影响，本方案是其互补的另一半。
- **观测通道现状（v2 补充，决定冒烟设计）**：降噪闸落地后，kv get/list 的 ok dispatch 已不入审计链；本方案落地后正常路径广播亦关闭——届时 kv-ok dispatch 在「审计链」与「广播」两条通道上均无记录。60 条/秒是 10-31 降噪闸落地**前**的观测；落地前后的速率复核方式见 §五 冒烟 2（必须在现行为下、或开 POLARIS_DISPATCH_TRACE 时经 WS 观测，不能用降噪闸后的审计链）。

### 2.5 桌面中继白烧

`lib.rs` 四个中继任务订阅 `state.event_broadcast`（即同一广播器）逐条 recv，先 `serde_json::from_str::<Value>` 全量 parse 再按 kind 过滤：
- chat-event 中继 `lib.rs:659-676`（`:665` parse）
- plugin.service.status 中继 `lib.rs:683-701`（`:689` parse）
- git-undo-snapshot 中继 `lib.rs:707-731`（`:713-717` parse）
- git-operation 中继 `lib.rs:737-761`（`:743-747` parse）

每条 dispatch.start/end 广播 = 4 次无价值全量 parse + 1 次 WS 客户端侧转发前过滤（`web/api/ws.rs:112` 同源订阅，且 ws.rs 无 trace 引用——trace 字段不透出 WS 层）。

### 2.6 回归面（2 个测试函数，4 处断言点）

| 测试 | 位置 | 断言/条件 | 受本方案影响 |
|---|---|---|---|
| `dispatch_broadcasts_start_and_end` | mod.rs:1451 起 | `:1452-1453` `assert!(kinds.contains(dispatch.start/end))` | start 降级 + ok end 降级后必挂，须改写 |
| 同上 | mod.rs:1531-1534 | 收集条件 `count(dispatch.end) >= 1 && count(stream.echo) >= 3` 的 break 条件（属 `dispatch_stream_pumps_events_and_ends`，mod.rs:1504 起） | ok end（stream 正常收尾）降级后收集不到，须改写 |
| `dispatch_stream_pumps_events_and_ends` | mod.rs:1544 | `assert!(kinds.contains(dispatch.end), "流结束应有 dispatch.end")` | ok end 降级后必挂，须改写 |
| 同上 | mod.rs:1545 | `assert!(kinds.contains(dispatch.start))` | start 降级后必挂，须改写 |

> 更正：v1 称「唯一单测断言 mod.rs:1451-1454」且误记「1452-1453 为 trace 断言」「1531 附近另有恰一次语义测试」——实读 1420-1454 全测试**无 trace 字段断言**（1418 注释「trace 匹配」指 Filter 订阅维度）；1531 的收集条件与 1544-1545 断言同属 `dispatch_stream_pumps_events_and_ends`（async test，mod.rs:1504 起），并非独立测试。回归面合计 2 函数 4 处断言点。另：未注册能力的 None 分支（mod.rs:930-934）本就不广播 end，改写断言时勿把「未注册」当 error 终态用例。

---

## 三、目标与非目标

### 目标

1. 正常快路径 dispatch（start 广播、ok end 广播）默认不再进入 EventBroadcaster（不进重放缓冲、不占 seq、不做 WS 分发），改为 `tracing::debug`（AGENTS.md §六：debug 高频诊断、生产不落盘）。
2. error 终态与 deny 广播**原样保留**（低频、排障与安全留痕高价值）。
3. 提供 `POLARIS_DISPATCH_TRACE=1` 进程级诊断开关，一键恢复**全部** dispatch 生命周期广播。**准确定位（v2 修正）**：这是 WS 侧广播语义的恢复/调试开关——用于①临时排障需要在 WS 上直接观测 dispatch 轨迹、②兼容仓外未知的外部 WS 消费者、③冒烟验证门控语义。它**不是**契约测试面板的数据源：面板轨迹读审计链 dispatch.jsonl（`should_audit_dispatch_ok` 治理，与本开关正交，见 §2.3/§2.4）。
4. 成败与耗时观测不丢失：审计链 `duration_ms` 字段已持久化（mod.rs:805 计算、:847 与 :907 写入；kv 只读 ok 被降噪闸挡在链外，由 tracing debug 补齐该场景的诊断可见性）。

### 非目标

- **不改任何协议类型**：Envelope/Reply/Event 结构体（`contracts`）、WS 消息格式 `{"event":..,"payload":..}`、seq 注入格式均不动；本方案改的是「哪些事件发」，不是「事件长什么样」。已核实前端/插件仓无 dispatch.* 消费类型，无需双端同步。
- **不新增能力、不新增 cap.\***：纯 router 内部观测语义治理，AGENTS.md 插件优先原则不触发（非面向用户的新功能）。
- **不拆分 router/mod.rs**（1618 行，未达 1800 行巨型文件门槛）：定点小改，不做结构性重构。
- **不动 4 个桌面中继与 ws.rs 的 parse 过滤模式**：广播源头治理后白烧自然消失；中继自身的结构性优化属另一议题（见 §八 AI-2）。
- **不治理 chat-event 自身流量**：活跃流式会话 30-60 delta/s 仍会滚缓冲（缓冲无差别收录所有 kind），本方案只消除 dispatch 噪声占比 >99% 的部分。
- **不改变未注册能力的既有行为**：None 分支（mod.rs:930-934）不广播 end 是现况，本方案不动它。

---

## 四、改造步骤（单 PR，四步，全部在 `src-tauri/src/services/router/mod.rs`）

### 步骤 1：加诊断开关（RouterBus 字段 + env，测试可控）

在 `RouterBus` 结构体加字段：

```rust
/// dispatch 生命周期全量广播诊断开关（POLARIS_DISPATCH_TRACE=1 开启）。
///
/// 默认关：每条 dispatch 无条件广播 start/end 在 kv 轮询（~60 dispatch/s）
/// 场景下每秒 ~120 条纯噪声污染事件总线与断线重连重放缓冲
/// （plans/perf-max-benefit-plan.md §2.2）；仓内/插件仓零消费（§2.3）。
/// 用于 WS 侧调试排障与兼容未知外部 WS 消费者；契约测试面板轨迹来自
/// 审计链，与本开关无关。
pub(crate) dispatch_trace_enabled: bool,
```

构造点 `RouterBus::new`（mod.rs:163）从 env 读一次：

```rust
dispatch_trace_enabled: std::env::var("POLARIS_DISPATCH_TRACE")
    .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
    .unwrap_or(false),
```

命名对齐既有 `POLARIS_DATA_ROOT` 范式（`data_root.rs:141`）；已确认全仓无 `POLARIS_DISPATCH_TRACE` 命名冲突。选字段而非 `OnceLock` 全局：单测需要逐测试控制开关（见步骤 4），OnceLock 进程级一次初始化不可控。

### 步骤 2：dispatch.end 主分支降级（洪水主体，先做先见效）

改 mod.rs:807-826（同步主分支终态广播）为分级：

- **error 保留广播**（payload 原样）；
- **ok 且开关关**：不广播，改 `tracing::debug!(target = %env.target.0, msg_id = %env.id.0, duration_ms, "dispatch ok")`（`duration_ms` 变量已在 `:805` 就绪）；
- **ok 且开关开**：维持现行为广播。

同样的分级套用到 sync 回退分支 mod.rs:912-922（cap.ai.chat 同步动作路径，payload 带 `sync:true`）。

### 步骤 3：dispatch.start 降级（两处）

- mod.rs:620-630（同步入口）与 mod.rs:342-353（流式入口）：开关关时不广播，改 `tracing::debug!(target, msg_id, source, "dispatch start")`；开关开时维持现行为。
- `serde_json::json!({...})` 构造必须移入 `if` 分支内，避免关闸后仍白付构造成本。
- **deny 广播 4 处全部保留**（mod.rs:365-375 / :642-651 / :674-684 / :708-717）；**流式 error end 2 处保留**（mod.rs:405-416 invoke 失败 / :477-491 idle 超时）——均为低频高价值终态。
- 流式正常收尾 mod.rs:496-506（status:ok）比照步骤 2 降级。

### 步骤 4：单测断言同步改写（2 函数 4 处断言点，见 §2.6 表）

1. **`dispatch_broadcasts_start_and_end`（mod.rs:1451 起，:1452-1453）** 改为分段语义：
   - 开关关 + 正常 dispatch（EchoCapability ok 路径）：断言事件流**不含** `dispatch.start`、不含 ok `dispatch.end`；
   - 开关开（直接改 `router.dispatch_trace_enabled = true`）：断言 start+end 均在（保留原断言语义）；
2. **`dispatch_stream_pumps_events_and_ends`（mod.rs:1504 起）**：
   - `:1531-1534` 收集条件 `count(dispatch.end) >= 1` 依赖 ok end 广播——开关开下维持；开关关下该测试须改为开启 `dispatch_trace_enabled` 后运行（该测试本意是验证泵转发与 trace 覆写，开闸不影响其主断言），或拆分出「关闸后无 start/end 广播」的独立断言；
   - `:1544-1545` `contains(dispatch.end)` / `contains(dispatch.start)` 双断言：开闸后原语义成立，直接在测试内置 `dispatch_trace_enabled = true` 即可最小改动。
3. error 终态断言（如需）：**用单测内注册的 `FaultyCapability`**（demo_capability.rs:50，mod.rs:66 re-export，仅测试夹具）驱动 Some(h) 分支 handler Err → mod.rs:814-819 end(error) 广播；**不可**用「未注册能力」驱动（None 分支 mod.rs:930-934 不广播 end，见 §2.1 现况注）。
4. 注释写明根因与修复依据（AGENTS.md 原则 5）：「正常路径广播降级为 debug（性能治理，plans/perf-max-benefit-plan.md）；error/deny 终态保留广播」。

### 步骤 5（收尾）：文档与提交

- 本文件即 spec（AGENTS.md 原则 4 合规）；`plans/two-bus-architecture.md` 经 grep 确认无 dispatch.* 广播语义记载，无需同步；AGENTS.md cap 清单不变。
- 一次改动一个主题：`perf(router): dispatch.start/end 广播降级为诊断开关门控，消除事件总线与重放缓冲洪水`。

---

## 五、验证方法

实施后依次执行（均为仓库真实存在的命令；`pnpm typecheck`=package.json:6，`pnpm lint`=package.json:25，`pnpm tauri:dev:web`=package.json:14，cargo 系=AGENTS.md §一门槛表）：

```bash
# 1. 后端静态门槛（必跑；本方案唯一改动语言）
cargo check

# 2. Web-only 门控（必跑：services/router 被 web bin 引用，改 router 层须双方向检查）
cargo check --no-default-features --bin polaris-web --bin polaris-mcp

# 3. 前端门槛（零前端改动，跑一次确认无回归）
pnpm typecheck
pnpm lint
```

**单测说明（如实交代）**：AGENTS.md §九记载本机 `cargo test --lib` 不可用（Tauri DLL 启动限制），本会话未实测推翻该记载；`dispatch_stream_pumps_events_and_ends` 为 async test，同样受此限制。router 单测的运行验证按以下优先级：若环境允许，跑 `cargo test --lib services::router::tests::`（若 DLL 限制同样命中该 target 则放弃）；否则以 cargo check 编译通过 + 下方手动冒烟为逻辑验证依据，**不得**在报告里写「单测已通过」。

**速率复核的正确时机与通道（v2 重写）**：kv-ok dispatch 自 10-31 降噪闸起不入审计链、本方案落地后正常路径广播亦关——审计链**不能**用于落地后速率复核。可行方式二选一：
- **落地前**（现行为下，广播在）：连 WS 数 `dispatch.start`/`dispatch.end` 消息速率（或临时加一行 tracing 计数），复核 §2.4 的 60/s 推断；
- **落地后**：`POLARIS_DISPATCH_TRACE=1` 起服务，经 WS 数 dispatch.* 消息速率（开闸即恢复广播，等价于现行为观测）。

**手动冒烟（开闸语义 + 洪水消失双验证）**：

1. **开关开**：`POLARIS_DISPATCH_TRACE=1 pnpm tauri:dev:web` 起服务 → 前端连 WS → 观察仍能收到 dispatch.start/end 全量轨迹（门控语义生效）。
2. **开关关**：默认起服务 → 触发 kv 轮询（或任意插件 kv 读写）→ WS 客户端确认不再收到 dispatch.start/end；按上节方式复核现速率。
3. **deny 保留**：无权限 capability 调用 → WS 仍收到 `dispatch.deny`。
4. **error 终态保留**（v2 重写，v1 的 cap.faulty 方案不可执行）：生产装配未注册 FaultyCapability（§2.1 注），且未注册能力走 None 分支不广播 end——生产冒烟改用**已注册能力的稳定失败动作**驱动 Some(h) 分支 handler Err → mod.rs:814-819 end(error) 广播（例如向某生产能力传入非法参数使其返回 Err；实施时选取并固定一个可复现动作，若所选动作返回 Ok 则更换）；备选：dev 装配临时注册 `FaultyCapability` 后调用；单测内用 FaultyCapability 覆盖（步骤 4.3）。
5. **缓冲窗口**：断开 WS >20s（现行为下必淘汰）→ 重连 → 观察有流式会话时增量补发/自动兜底生效、无流式会话时不再因噪声堆积触发 gap（webReconnectResync 链路见 §2.2）。

---

## 六、风险与回滚

| 风险 | 评估 | 缓解 |
|---|---|---|
| **隐藏消费者**（外部脚本/第三方工具直连 9829 WS 消费 dispatch.*；grep 只能覆盖仓内代码） | 低——事件语义纯追踪用，`trace` 字段 WS 层不透出（本会话 grep ws.rs 无 trace 引用） | `POLARIS_DISPATCH_TRACE=1` 一键恢复现行为（重启生效，无需改代码）；error/deny 仍广播，排障能力保留 |
| **单测断言漂移** | 必然发生（2 函数 4 处断言点，§2.6），可控 | 同 PR 改写断言并注释根因（§四 步骤 4） |
| **ok end 悄然不再广播后，某处依赖「每 dispatch 恰一终态」的隐式逻辑失效** | 低——grep 证实仓内零消费；「恰一终态」注释（mod.rs:875-877）是就广播语义而言的既有设计记录 | 若日后发现消费方，直接置 env 开关恢复，属配置级回退 |
| **回退分支/流式路径漏改**（原评审即漏了 2 处） | 中——11 处语句中 5 处门控 | §2.1 全景表为实施 checklist，逐条打勾 |
| **把「未注册能力」误当 error 终态验证**（v1 冒烟 4 即犯此错） | 已在设计期消除 | 冒烟 4 改用已注册能力失败动作或 dev 临时注册 FaultyCapability（§2.1 注、§四 步骤 4.3） |
| **env 开关在测试中不可控** | 设计期已消 | 用 RouterBus 字段而非 OnceLock，测试直接改字段（§四 步骤 1） |

**回滚**：单文件单 PR，`git revert` 即可；不改任何协议/存储/持久化格式，回滚无数据迁移问题。

---

## 七、预期收益与量化口径

### 直接量化（口径全部来自本会话复核的实证）

| 项 | 现状 | 改后 | 依据 |
|---|---|---|---|
| dispatch 广播量（kv 轮询场景） | ~120 条/s（start+end 各 60） | <1 条/s（仅 error/deny），降幅 >99% | 审计观测 ~60 dispatch/s（audit spec :8）；广播点 mod.rs:620/807/912 |
| 重放缓冲窗口（无活跃会话，锁屏核心场景） | 2000 条 ÷ 120 条/s ≈ **16.7s**，且 100% 被噪声占据 | 缓冲近乎只含真实事件，窗口实际可用 | event_broadcaster.rs:19/42-56；webReconnectResync 链路（§2.2） |
| 重放缓冲窗口（活跃流式会话 30-60 delta/s） | delta（30-60/s）+ 噪声（120/s）混合 = 150-180 条/s → 2000÷180 ≈ 11.1s、2000÷150 ≈ 13.3s，即 **11-13s** | 纯 delta 30-60 条/s → 33-66s | event_broadcaster.rs:19；算术 v2 修正（v1 的「33s」误用了纯 delta 口径、「2-4×」与两个口径均不自洽） |
| —— 提升倍数（同上） | —— | 33-66s ÷ 11-13s ≈ **2.5-6×**（中位约 3-5×） | 同上 |
| 桌面中继白烧 | 4 任务 × 120 parse/s 无价值全量 parse | ~0 | lib.rs:659/683/707/737 实读 |
| resume 补发带宽 | 补发事件混入 120 条/s 噪声 | 仅真实事件 | event_broadcaster.rs:120-130 replay_after |
| 每 dispatch 固定开销 | 2 次广播 = json! 构造 + encode_event 一次序列化（内部 json!+to_string）+ seq 拼接 + Mutex push + 分发 | 快路径 0 次广播，微秒级 | event_adapter.rs:49-52/89-95、event_broadcaster.rs:93-105 |

### 如实声明（不夸大部分）

- **绝对 CPU 收益微小**：每条广播全程约 2-5µs 量级（JSON 序列化 + 字符串拼接 + Mutex + VecDeque），120 条/s 合计 <0.1% 单核。本方案**不是** CPU 优化，是**事件总线语义与重连缓冲恢复能力**的修复。
- **「直接进首响」收益为微秒级**（评审质询已修正），不作为主要收益主张。
- **活跃会话边打字边锁屏场景**收益打折：30-60 delta/s 的 chat-event 自身仍会滚缓冲（33-66s 窗口），本方案只消除 dispatch 噪声占比（混合窗口 11-13s → 纯 delta 33-66s）。
- 60 条/秒为 10-31 降噪闸落地前的审计观测推断，落地前后按 §五「速率复核」的正确通道复核后更新本节数字。

### 落地后实测（2026-11-01，回填）

- **桌面实例 WS 观测 0 条/s**：桌面端 `polaris.exe` 于合并后重建（二进制 03:24:48 编译，含门控代码），被动订阅其 `/api/ws` 观测 60s：`dispatch.start` ×0、`dispatch.end` ×0（此前推断 ~120 条/s 噪声广播）；期间实例持续运行、审计链继续写入非 ok 条目（kv 插件正常工作）。**洪水消除在生产实例实测生效。**
- **落地前 60/s 口径无法回测**（如实记录）：降噪闸（10-31）后 kv-ok 不入审计链、落地前广播代码已无处运行——`~60 dispatch/s` 保留为历史推断口径；落地后终态速率以本次 0 条/s 实测为准（deny/error 低频条目未在 60s 窗口出现，属预期）。
- 观测方法：node 脚本连 `ws://127.0.0.1:9829/api/ws?token=<md5>`，`{"type":"ping"}` 保活，60s 被动计数。


---

## 八、落选方案一览（12 案评分板，按总分排序）

| # | 方案 | 得分 | 落选理由（评审质询结论） |
|---|---|---|---|
| 1 | **ST-1 本文（胜选）** | 17 | —— |
| 2 | DS-1 日志管道治理：启动期保留策略清扫 + plugin_engine 逐行热路径日志降级 | 13 | 证据全部实测吻合（logs/ 955MB、单文件 84.6MB、plugin_engine 逐行 info 实锤），收益全仓最实；但涉及历史日志不可逆删除需 config 化默认值，且 8e564bd0 提交证词引用有张冠李戴，整体仍为高价值次席，建议下期立项 |
| 3 | FE-1 流式写入统一节流：thinking 与工具流式输出并入既有 50ms flush 缓冲 | 5 | 全链路核实成立、70-95% 降幅可信；但与未提交的 sessionElapsed 改动同文件（createConversationStore.ts/eventHandler.ts），须待其落地后实施；块序边界风险需严格执行 flush 矩阵 |
| 4 | FE-2 切断 CodeMirror 三条静态 import 边：1MB 编辑器移出启动路径 | 5 | 诊断与量化真实（dist 实测 1,017,611B），但**致命实施缺口**：漏了 App.tsx:11 `NarrowTabOverlay` 经 Editor barrel 的第四条静态边——不补第四步收益直接归零，且 NarrowTabOverlay lazy 化的窄屏首载权衡未讨论 |
| 5 | DS-3 SQLite 调优单权威化：journal_size_limit 等 pragma 收敛共享 helper | 5 | 四库缺口的证据全实锤（含 kv WAL 191MB 楔死事故注释背书），防整实例楔死级别；体量小但需处理 sqlite.rs 与 session_db 现存顺序矛盾（busy_timeout 与 WAL 先后），且收益是防复发性质 |
| 6 | ST-2 record_route_log 持久化去抖化 + 原子写 | 0 | 持 tokio Mutex 临界区同步双文件全量覆写属实，但评审指出：failed-calls.jsonl 是失败诊断日志非计数器，5s 去抖崩溃丢窗是真语义损失；频率比 audit 低 2-3 个数量级，楔死类比偏强，主收益收敛为非原子写静默清零回归面 |
| 7 | ST-3 create_app_state 装配链去重：插件目录扫描 2 次 + state.json 解析 5 次收敛 | 0 | 5 条读取路径全实锤，但方案自认绝对收益 <50ms 且未实测，本质是架构卫生而非性能优化 |
| 8 | FE-3 i18n 语言包按需加载 | 0 | 证据逐字节精确（双语 288.5KB 实测），零争议但幅度小（~40KB gzip），自评排第三诚实 |
| 9 | AI-1 拆除 engine_registry 全局互斥：会话生命周期操作并发化 | 0 | 诊断无懈可击（claude.rs:1346 持锁 sleep(100ms)、interrupt 持锁查 sqlite 等全实锤），但评审发现关键漏项竞态：去锁后「点开始立即点停止」可能命中 spawn 进行中 PID 未注册窗口，复现「UI 假装已停但进程在跑」错配，须补 per-session 握手设计；改动面大（trait+5 引擎+双锁域） |
| 10 | AI-2 chat-event 串行化链路单点化：每事件 4 次冗余 parse + ~7 次堆分配收敛 | 0 | 逐跳核实成立，绝对收益微秒级/事件但属最高频热路径 + 三处信封双写点收敛，定 medium；实际可并入后续 chat-event 中继重构（与本文 §四 非目标呼应） |
| 11 | AI-3 流式 delta 发射合批（16-24ms 时间窗） | 0 | **overstated**：按方案自引 30-60 delta/s 与 24ms 窗计算，IPC 穿越仅降 ~1.4-2×，与标题 3-10× 不自洽；泵满丢失从「1 条 delta」变「整窗字数」，单次伤害放大；与 FE-1 收益重叠 |
| 12 | DS-2 数据根生命周期卫生：遗留迁移副本与引擎会话目录保留策略 | 0 | 实测全部吻合（migrations 75MB 死残留、pi-sessions 124MB/515 文件），一次性 ~200MB 回收；但本质是磁盘卫生而非性能优化，且需 dry-run 先行、插件会话路径映射校验，列为 medium 后续项 |
