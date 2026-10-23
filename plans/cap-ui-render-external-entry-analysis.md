# cap.ui.render 外部入口失效 — 根因分析与方案评估

> 日期：2026-10-23 · 状态：待原开发 AI 处理
> 场景：经 MCP bridge（cap_dispatch）从外部调用 `cap.ui.render` 测试渲染卡片，卡片不出现。
> 关联：`plans/ui-template-runtime-v1.md`（cap.ui.render v2 模板运行时）、`src-tauri/src/services/router/ui_render_capability.rs`、`src/services/eventRouter.ts`、`src/stores/conversationStore/sessionStoreManager.ts`。
> 本文档只做分析与方案评估（用户要求「仅分析，不着急」，已确认不改代码），供原开发 AI 接手决策。

---

## 一、现象

1. `cap.ui.render register` 注册模板 ✅ 成功（`persisted: true`）。
2. `cap.ui.render request`（`mode: display`）返回 `{ status: "displayed", interactionId }`，但**对话页始终不出现卡片**。
3. `cap.ui.render request`（`mode: interaction`）MCP 同步通道报 `os error 10060`（连接超时），卡片同样不出现。

初判为「渲染没生效/能力坏了」，实为两个独立问题叠加：**ID 路由错位（静默丢弃）** + **interaction 阻塞超时（通道边界）**。

---

## 二、根因一：会话 ID 体系错位 → plugin_card 事件被路由器丢弃（主因，display 也失效）

### 事件链路（已逐行核实）

```
后端 emit_plugin_card_event（ask_listener.rs:2123）
  → wrap_question_route_event(session_id) → contextId = "session-<sessionId>"
  → emit_chat_event → event_broadcast → chat-event 通道
前端 EventRouter（src/services/eventRouter.ts:58）
  → 从 contextId 提取 frontendSessionId
  → sessionStoreManager.dispatchEvent
  → get().stores.get(routeSessionId)   ← 查不到 ↓
  → log.warn('事件未匹配到会话，丢弃') → return（sessionStoreManager.ts:546-552）
```

### 关键证据

- `sessionStoreManager.ts:538-541` 注释明确：
  > 单一路由路径：`_routeSessionId` 是前端 sessionId（由 EventRouter 从 contextId 解析注入）。**不再用 event.sessionId（后端 conversationId）兜底**，不再回退 activeSessionId——这三条正是「对不准窗口/新开窗口」的根因。
- `eventRouter.ts:76-77` 注释明确：
  > `payload.sessionId` 是**后端 conversationId，不可作路由 key**。
- 前端 store 的 key 由 `createSession()` 生成（`sessionStoreManager.ts:84-95`：`options.id || generateUUID()`）。
- 历史恢复 `restoreFromHistory`（`historyService.ts:443-474`）：外部历史 ID（如 `84c9c44d-...`）只作为 `conversationId` 塞进消息，前端会话仍**重新生成新 ID**。

### 结论

外部调用方（MCP bridge / dispatch）经 `cap.history` 拿到的 sessionId 是**后端 conversationId**（或根本不匹配），
不可能命中前端 `stores` 的 key → 事件在 `dispatchEvent` 处**静默丢弃**。
`request` 返回 `"displayed"` 只代表事件已成功广播（`emit_plugin_card_event` 返回空），**不代表前端渲染成功**——这是「没有效果」的直接原因。

**本质**：`cap.ui.render` 设计假设调用方是「AI 会话内工具调用」（天然携带前端会话 ID），外部入口无此保证。

---

## 三、根因二：interaction 模式阻塞等待 → MCP 同步通道超时（次因，仅 interaction）

`ui_render_capability.rs:676`：
```rust
tokio::time::timeout(UI_RENDER_TIMEOUT /* = 180s */, rx).await
```
interaction 模式的 `request` 会 `block_in_place` **阻塞等用户应答最多 180s**，
而 MCP bridge 的同步 invoke 等不了那么久 → 连接断开，MCP 侧表现为 `os error 10060`。

> 注意：MCP 断开不 kill 后端等待（120s 内用户若操作仍可能被消费），但对外部调用方体验无意义。

**结论**：interaction 模式天生是给「AI 会话内工具调用」用的（会话保持连接、同回合拿 answer），外部 MCP 同步通道不适配。此问题与 ID 错位互相独立，**即使修好 ID 错位也不会消失**。

---

## 四、方案评估（按推荐度排序）

| 方案 | 落点 | 判定 | 依据 |
|---|---|---|---|
| **C** 前端 `plugin_card` / `plugin_card_answered` 分支：`dispatchEvent` 匹配不到 store 时，投递到 `activeSessionId` 的会话 | `sessionStoreManager.dispatchEvent` 或 `eventHandler` 的 `plugin_card` case（`eventHandler.ts:949`） | ✅ **推荐** | ① 前端有现成 `getActiveSessionId()`；② 只特判实体渲染事件，不碰全局路由治理约束；③ 回写闭环独立：`respond_plugin_card`（`ai_chat_core.rs:2176`）按 **interactionId** 配对 oneshot，不依赖卡片当初投给哪个 store → 渲染与回写天然解耦 |
| **B** `request` 增加前端会话感知 / 自动用活跃会话路由 | `ui_render_capability.rs` + 协议 | ⚠️ 语义对但缺基建 | 后端**没有「前端活跃会话」概念**——全仓 `active_session*` 都是 engine 内部「正在运行的后端进程会话」（`ai/registry.rs:271`、`ai/traits.rs:725`），不是「用户正在看哪个前端 tab」。要自动路由需新建「前端 → 主进程上报活跃会话」链路 + 协议变更，成本最高 |
| **A** `dispatchEvent` 全局回退 activeSessionId | `sessionStoreManager.ts:537` | ❌ **不可取** | `sessionStoreManager.ts:538-540` 明确写了历史三条根因里就含「回退 activeSessionId」——即「对不准窗口/新开窗口」的旧 bug 根因，全局放宽会复现旧疾 |

---

## 五、确认正确的关键事实（供接手方省时间）

1. **两套 ID 独立**：前端 `stores` key = `createSession()` 生成的 UUID；`cap.history` / 后端返回的 sessionId = 后端 conversationId。二者只在「AI 会话内」同值（前端创建会话时用同一 ID 启动引擎），外部入口取不到前端 ID。
2. **回写不依赖路由**：`respondPluginCard`（前端 `chatService.ts:103`，后端 `ai_chat_core.rs:2176`）全程只按 sessionId + interactionId 走，`pending_plugin_cards` / `plugin_card_answer_senders` 是作用域于 interactionId 的全局 map（`state.rs:264-266`）。渲染投递到哪个 store 不影响应答回传。
3. **pending 登记在 request 侧**：interaction 模式先 `pending.insert(interaction_id, ...)` + `register_plugin_card_answer_sender`，再广播事件（`ui_render_capability.rs:638-665`）。所以「事件没渲染」不等于「没有 pending」——180s 内用户点按钮理论上仍可消费（但外部入口看不到卡片，无意义）。
4. **`cap.ui.render` display 模式已登记模板**（测试遗留）：`demo/render-test`、`demo/deploy-interact`（persisted，owner=core）。接手方若不需要可 `unregister` 清理。

---

## 六、建议方案 C 的落地边界（草案，未实现）

- 改点唯一：`sessionStoreManager.dispatchEvent` 中 `stores.get(routeSessionId)` miss 时的分支（或 `eventHandler.ts` 的 `plugin_card` case 前移）。
- 仅对 `event.type === 'plugin_card' || 'plugin_card_answered'`（可再含 `question` / `form` 等实体渲染事件）做 activeSession 兜底投递；其余事件保持丢弃语义不变。
- 兜底时补 warn 日志（含原始 routeSessionId + fallback 目标），便于事后观察是否会误伤。
- 验收：外部 `cap_dispatch` 调 `request(mode: display)`，卡片出现在当前活跃对话；按钮/表单可交互；`answered` 状态正确回写。

**不做**（此轮）：interaction 阻塞超时改造（留待真实 AI 会话场景验证再定）；方案 B 的活跃会话上报链路。

---

## 七、给原开发 AI 的交接要点

1. 复现入口：`cap_dispatch(target=cap.ui.render, payload={action:"request", ...})`（MCP bridge）。
2. 验证日志关键字：`事件未匹配到会话，丢弃`（`sessionStoreManager.ts:550`，WARN 级）——复现时可在前端 devtools 确认该日志出现。
3. 若确认方案 C，请先补 spec 到 `plans/`（本项目纪律，见 AGENTS.md §二-4），再动 `eventHandler.ts` / `sessionStoreManager.ts`。
4. 前端改动后需 `pnpm exec tsc --noEmit` + `pnpm lint`。

---

## 八、落地实现（2026-10-23 已实施）

### 结论
采用方案 C（分析文档 §四 推荐项），落点唯一：`sessionStoreManager.ts` 的 `dispatchEvent` miss 分支。

### 行为约定 / 接口（spec）

**目标**：外部入口（MCP bridge / cap_dispatch）调用 `cap.ui.render request` 时，`plugin_card` / `plugin_card_answered` 事件在路由不到原始 session 的情况下，能兜底投递到前端当前活跃会话并渲染、可交互、可回写。

**所有者**：`store.get().stores`（前端会话 store key = 前端 sessionId）+ `store.get().activeSessionId`。

**改动**：`src/stores/conversationStore/sessionStoreManager.ts` `dispatchEvent`：
- 在 `stores.get(routeSessionId)` miss 且 `activeSessionId` 存在、且 active store 存在时，对**实体渲染事件**兜底到 active store；
- 实体渲染事件白名单：`plugin_card`、`plugin_card_answered`（`form` / `question` 等暂不介入——外部 MCP 链路尚无对应事件源，避免扩大影响面）；
- 兜底投递走 `store.getState().handleAIEvent(event)`，与正常路径完全一致；
- 兜底补 WARN 日志（含原始 routeSessionId + fallback 目标），便于观察是否误伤；
- 兜底后 metadata 同步更新使用 **fallback 目标** 的 sessionId 而非原始 routeSessionId（避免 metadata 写到不存在的会话 key 上）。
- 其余事件 / 无 active 会话时保持原丢弃语义不变。

**不做**（遵循分析 §六）：interaction 阻塞超时改造、方案 B 活跃会话上报链路。

### 验收
1. `pnpm exec tsc --noEmit` 通过 ✅（已跑）
2. `pnpm lint`（eslint 改动文件）无 error/warning ✅（已跑）
3. 外部 `cap_dispatch` 调 `request(mode: display)` → 卡片出现在当前活跃对话（逻辑已验证：`sessionStoreManager.pluginCardFallback.test.ts` 6 用例覆盖兜底投递）
4. `plugin_card_answered` 正确回写（`updatePluginCardBlock` 按 interactionId 配对，不依赖路由）✅（测试覆盖）
5. 无 active 会话 / 非白名单事件 → 仍按原逻辑丢弃（WARN 日志存在）✅（测试覆盖）
6. 回归：`sessionStoreManager.preservation.test.tsx` + `engineInitialization.test.ts` 13 用例全绿 ✅

### 已验证关键事实（引用分析 §五）
- 回写不依赖路由：`respond_plugin_card` 按 interactionId 配对 oneshot（`ai_chat_core.rs:2176`）。
- pending 登记在 request 侧（`ui_render_capability.rs:638-665`），渲染丢不丢与 pending 无关。
- 事件广播已带 contextId=`session-<sessionId>`（`ask_listener.rs:2112`）→ EventRouter 解析为 `_routeSessionId`（`eventRouter.ts:78`）。