# 中断后继续发送 → 回显异常 / 会话未启动 — 根因分析报告

> 目标:分析与验证(仅分析,不改代码)
> 场景:AI 对话中途用户点"停止/中断",随后继续发送消息 → 对话窗口回显异常,会话显示"未启动"
> 结论:这是**跨引擎共性的状态机/事件路由缺陷**,不是单一引擎问题。共 5 条独立病灶,任意一条命中都会触发用户看到的症状。

---

## 一、"会话没有启动中"是什么

前端**不存在**字面字符串"未启动中"。该 UI 是两处状态的合成:

| UI 表现 | 数据源 |
|---|---|
| 会话格子灰色圆点 / 空闲态 | `sessionMetadata.status` 停留在 `'idle'`(`sessionStoreManager.ts:768-805` 仅在 session_start/session_end/error 时更新) |
| 消息区空态 "开始对话吧" | `EnhancedChatMessages.tsx:135` `isPending = isStreaming && !currentMessage`;两者都为 false 时显示 EmptyState |

用户说的"会变成会话没有启动中",即 **status 停在 idle(灰点) + 消息区不进入流式/无回复回显**。

根因:**中断→续聊路径上,后端没有发 `session_start`**,前端 `sessionMetadata.status` 永远升不到 `'running'`。

---

## 二、根因 A — 续聊不发 session_start(状态停在 idle)【已钉死】

### 证据链

1. **SimpleAI** `continue_session`(`src-tauri/src/ai/engine/simple_ai/mod.rs:443-562`)
   - 只发 `AIEvent::UserMessage`(486 行),**全程无 `SessionStart`**。
   - 我全文 grep `chat_loop.rs`,`SessionStart|session_start` **零匹配** —— 排除了"chat_loop 自动补发 session_start"的可能。
2. **dsh** `continue_session`(`src-tauri/src/ai/engine/dsh.rs:2005-2049`)
   - 只 `send_prompt` 复用常驻 WebSocket,不发 session_start(只有 `start_session` 在 1996-1997 发)。
3. **前端 status 唯一更新入口** `sessionStoreManager.ts:768-805`:
   - `session_start`→`running`,`session_end`→`idle`,`error`→`error`。
   - 没有 session_start ⇒ **status 永远 idle** ⇒ "会话未启动"。

### 对比:Codex/Pi 为什么能正常显示 running

`spawn_event_reader` 从子进程 stdout/stderr **提取到真实 thread_id 后**才发 `session_start(thread_id)`:
- codex.rs:716-729(ThreadStarted → `on_session_id_update` → `session_start(thread_id)`)
- pi.rs:707 同理
- 只有**新进程真正起来并输出了会话 ID** 才有 session_start —— 所以 kill 型引擎中断后如果 continue 成功拉起新进程,状态能恢复正常。**而 SimpleAI/dsh 走的是"复用会话"模型,从不发 session_start,status 固定 idle。**

---

## 三、根因 B — `stream.error` 事件无路由被静默丢弃(isStreaming 卡死)【已钉死】

### 证据链

1. **后端错误路径** `ai_chat_capability.rs:569-576`:
   ```rust
   if let Err(error) = result {
       let _ = tx.try_send(make_event(
           "stream.error",
           serde_json::json!({ "action": action, "error": error }),
       ));
   }
   ```
   - 这是 **`invoke_stream`(continue/start 的流式调用)** 唯一的错误上报通道。
   - payload **不含 sessionId**,只有 `{action, error}`。

2. **前端路由** `eventRouter.ts:93-103,128-149`:
   - 解析 `{contextId, payload}` 后,`extractFrontendSessionId(contextId)`(contextId 为 `session-{frontendId}` 时)或 `extractSessionId(payload)`。
   - `stream.error` 的 payload `{action,error}` **无 sessionId**,contextId 是后端 options.context_id(通常 `session-{frontendId}`)。

   > 这里要精确:continue 路径的 contextId 由前端 deps.contextId 传入,是 `session-{frontendId}`,**能**走 `dispatchToSession`。但 `stream.error` 的 payload 没有 `type` 字段(不是合法 AIEvent)……

3. **前端过滤** `useAppEvents.ts:44-49` → `isAIEvent(payload)`:
   - `event.ts:1298-1341` 的 `AI_EVENT_TYPES` 白名单**没有 `stream.error`**(只有 `error`)。
   - `isAIEvent`(`event.ts:1347-1353`)要求 `event.type ∈ AI_EVENT_TYPES` ⇒ **`stream.error` 判 false**。

4. 由于 `dispatchToSession` 直接调 `sessionStoreManager.dispatchEvent`(**不过 `useAppEvents.ts` 的 isAIEvent 过滤**),所以 route 层不会丢 —— 但 **`handleAIEvent`(`eventHandler.ts:134`)的 switch 里没有 `stream.error` 分支**,事件落入 default(被忽略/记日志)。

   综合:无论走 contextId 路由还是兜底路由,**`stream.error` 都不会置 `isStreaming:false`、不会置 error、不会触发 session_end**。

### 后果
`sendMessage`(`createConversationStore.ts:2078-2097`)已乐观置 `isStreaming:true`;若 continue 抛错(如"未找到会话"/进程损坏),后端只发 `stream.error`,前端**没有任何收尾事件** ⇒ **isStreaming 永久 true,currentMessage 停留在上一条,会话状态卡死**。表现为"发出去没反应/永远转圈/回显异常"。

---

## 四、根因 C — 引擎进程被 kill 后会话上下文丢失(kill 型引擎:Codex/Pi/PluginProcessEngine)【已钉死】

### 证据链

1. **interrupt** `interrupt_chat_inner`(`ai_chat_core.rs:1925-1976`) → `registry.interrupt` → 引擎 `interrupt()` → `kill_process`。
2. **`kill_process`**(`session.rs:237-310`):Windows `taskkill /PID {pid} /T /F`(261-264),**成功后 `self.remove(session_id)`(301)把会话从 SessionManager 移除**。
3. 用户再发送 → `sendMessage` 走 `continue` 分支(`createConversationStore.ts:2078`)→ `continue_chat_inner`(`ai_chat_core.rs:1612-1923`)。
4. **关键分歧点**:
   - `try_interrupt_all(&session_id)`(1826)先杀旧进程 —— **会话已被 remove**。
   - `registry.continue_session(engine, session_id, ...)` 时引擎侧 `self.sessions.get(session_id)` **必 miss**(被杀已移除)。
   - Codex `continue_session`(`codex.rs:968-1040`):miss 时 **用前端传的 UUID 当 real_session_id**,`build_command(message, Some(&real_session_id))` = 直接 `--resume UUID`。
   - 若该 UUID 与 CLI 真实会话 ID 不一致 → **在 codex 中创建一个全新线程** → 新线程 `session_start(新thread_id)` 回前端,`eventHandler.ts:142-148` 用新 id **覆盖 `conversationId`**。
   - 前端 `conversationId` 从旧值跳到新值,而消息历史、上下文**全部丢失**(新线程是空的) → 用户看到"上一轮上下文没了",这是典型的**回显/上下文异常**。

> 注意:这个"用 UUID 硬 resume"在**首次 start 的会话**(CLI 真实 id 通常 != UUID)上尤其危险;只有恰好 UUID 就是 CLI 真实 id 时才正常。

---

## 五、根因 D — dsh 常驻模型的 stale pending 计数延迟 session_end【已钉死】

### 证据链

`dsh.rs` WebSocket 事件读取器(1027-1280):
- `turn/end` 事件(`dsh.rs:1229-1240`):只有当 `pending_tool_counts.get(session_id) == 0` 才发 `session_end`;否则 **推迟 session_end**,记日志。
- **interrupt**(`dsh.rs:2051-2074`)只发 `session.cancel` RPC,**不清 `pending_tool_counts`、`session_map`、`websocket_active`、`call_id_maps`**。

### 后果
中断时若有未完成的工具调用(典型如 `unified_exec` 长任务),`pending_tool_counts` 卡在 >0 → 本轮 **永远不发 session_end** → 前端 `isStreaming` 卡 true,即使后端已经停了。下一条消息来(continue 复用同一 dsh session),事件流里**上一轮残留事件可能混进本轮回显**。

---

## 六、根因 E — 前端 interrupt 守卫提前返回 + 错误路径清空 currentMessage【已钉死】

### 证据链

1. **`interrupt()` 守卫** `createConversationStore.ts:2113`: `if (!conversationId || !isStreaming) return`。
   - 竞态下若 session_end 已把 isStreaming 置 false、用户后点停止 → **静默无响应**,UI 残留。
2. **sendMessage 错误路径** `createConversationStore.ts:2099-2108`:`set({ error, isStreaming:false, currentMessage:null, progressMessage:null })`。
   - 与 interrupt 路径"保留 currentMessage 由 session_end 固化"(eventHandler.ts:374-376)策略**互斥**。
   - 若 continue 走到 start 被后端拒绝,这里**清空半截消息** → 用户看到消息"消失",即回显异常。

---

## 七、路径全景:中断→再发送 各引擎实际行为

| 引擎 | 中断动作 | continue 后 session_start? | 上下文保留? | 用户看到 |
|---|---|---|---|---|
| **SimpleAI** | `abort_tx.send(true)`(mod.rs:593-622),复用进程 | ❌ 只发 UserMessage | ✅ 复用 messages | **status 卡 idle("会话未启动")**;内容可能正常也可能不出 |
| **dsh** | `session.cancel` RPC(dsh.rs:2051-2074),地图未清 | ❌ 只 send_prompt | ✅ 复用 dsh session | **status 卡 idle**;若 pending_tool_counts>0 则 isStreaming 卡死;残留事件混入 |
| **Codex** | `kill_process`(session.rs:301 remove) | ✅ 新进程起来后发(新 thread_id) | ❌ **丢失**(resume 用 UUID) | conversationId 被新 id 覆盖、上下文清空;若 continue 失败 → stream.error 被吞 → isStreaming 卡死 |
| **Pi** | 同 kill 型 | ✅ 同 codex | ❌ 同 codex | 同上 |
| **PluginProcessEngine** | 同 kill 型 | ✅ 同上 | ❌ | 同上 |

**共性**:只要 continue 路径抛错(进程没了/会话损坏/参数非法),后端唯一错误通道 `stream.error` 在**前端是死的**(无路由+无 handler+isAIEvent false)→ 前端 isStreaming 永久 true。这是所有引擎共同的"回显异常"兜底病灶。

---

## 八、验证结论与修复方向(仅建议,未实施)

### 已确认的缺陷(5 项,按影响排序)

1. **[P0]** `stream.error` 事件体系断裂:`invoke_stream` 错误事件无法路由/无法被消费(无 sessionId、无 type、isAIEvent false、handleAIEvent 无分支)→ **所有引擎 continue 失败时前端无任何收尾,isStreaming 卡死**。
2. **[P0]** SimpleAI/dsh 续聊不发 `session_start` → **status 永不 running,即"会话没有启动中"**。
3. **[P1]** kill 型引擎(Codex/Pi/PluginProcessEngine)中断把会话从 SessionManager 移除,continue 用前端 UUID 硬 resume → **上下文丢失 / 线程错位 / conversationId 被覆盖**。
4. **[P1]** dsh 中断不清 `pending_tool_counts`,turn/end 被永久推迟 → **isStreaming 卡死**。
5. **[P2]** 前端 `interrupt()` 守卫提前返回 + sendMessage 错误路径清空 currentMessage → **竞态下静默无响应 / 消息消失**。

### 修复方向(未实施)

- **根因 1**:让 invoke_stream 错误事件携带 `sessionId` 并走 `AIEvent` 合法类型(如 `{type:'error', sessionId, error}`),或复用现有 `error` 事件类型;确保 handleAIEvent 有对应分支收尾 isStreaming。
- **根因 2**:SimpleAI/dsh 的 continue_session 补发 `session_start`(或前端对 continue 乐观置 running)。
- **根因 3**:continue 前重新获取/校验会话真实 id;杀进程时保留会话元数据(resume 语义用真实 thread id 而非前端 UUID);或中断改为软取消(发 cancel 信号而非 kill)以保留上下文。
- **根因 4**:interrupt 时清零 dsh 的 pending_tool_counts / 相关 map。
- **根因 5**:interrupt 守卫去除 isStreaming 前置条件;sendMessage 错误路径与 interrupt 路径统一 currentMessage 处理策略。

---

## 附:验证方法(可复现)

1. 用 SimpleAI 引擎开新对话 → 发消息 → 中途点停止 → 再发消息:
   - 预期:消息回显,但状态点一直灰色(idle),无 running。
   - 观察:后端日志有 `UserMessage`、无 `SessionStart`。
2. 用 Codex 引擎:中断 → 再发送 → 观察新会话 thread_id 与旧 UUID 是否一致;若不一致,contextId/conversationId 被覆盖。
3. 制造 continue 失败(如手动 kill 会话进程后点发送):前端 `isStreaming` 是否永久 true(因 stream.error 被吞)。

> 以上均为代码级验证,无任何运行变更。
