# S3 Phase 4:跨端消息流式实时输出(重构规划)

> 状态:待实施(已实测确诊需求)
> 目标:首轮 user 消息「发送即实时」广播;assistant 流式内容「边打边」实时出现在另一端,不再等 AI 结束后才出现
> 关联:`s3-message-realtime-sync-phase1-3.md`(阶段 1-5 已实现,本文档为其 Phase 4 延续)
> 验证约束:`cargo check`(Rust lib 测试受 Tauri DLL 限制)、前端 `pnpm tsc --noEmit` + vitest

---

## 1. 现状与确诊根因(全部实测/代码证实)

### 现有链路(已工作)
- 广播:`message_append`(tauri command + ipc dispatch)写库后 → `broadcast_message_appended` → `chat-message-upserted` → WS/Tauri emit。
- 消费:`handleMessageUpserted`(messageRealtimeSubscription.ts)按 conversationId 路由 → `store.addMessage` 追加 → 气泡。
- 恢复:shared 源(SQLite 权威)可跨端恢复完整消息。

### 已确诊的 3 个断点

| # | 断点 | 证据 |
|---|---|---|
| P1 | **首轮 user 消息不实时** | `createConversationStore.ts:1930` 的 `syncSessionToShared` 在 `aiChatDispatch('start')` **返回前**执行,此时 `conversationId=null` → `messageSync.ts:76` 直接 return false。首轮 user 消息**要等 assistant 完成**(finishMessage,358 行)才补写广播 |
| P2 | **assistant 流式内容不实时跨端** | 流式走 `chat-event`,路由 key 是 `contextId=session-<前端sessionId>`(eventRouter.ts:78)。前端 sessionId **每端独立**,跨端广播到另一端时 `extractFrontendSessionId` 得到发送端的前端 sessionId,接收端 store 里没有 → `dispatchEvent` 找不到 store → **静默丢弃**(`sessionStoreManager.ts:606 log.warn`) |
| P3 | **assistant 内容等结束后才广播** | 流式期间 `chat-message-upserted` 从不发出(revise 不广播)。实测 seq 6310(user)+6311(assistant)在 AI 完成后**一起**广播 |

### 关键架构约束(不可破坏)
- `chat-message-upserted` 用 **conversationId** 路由(跨端一致),`session_messages` 表 `(id, version)` 主键版本链。
- 前端 sessionId 每端独立,不能作跨端路由 key。
- `message_revise` 目前**不广播**(session_messages.rs:117-148, revise 只写库)。
- `handleMessageUpserted` 目前「同 id 存在则跳过」(去重),**没有更新能力**。
- store `addMessage` 是追加,`editMessage` 只改 user 消息 content。

---

## 2. 最优方案:流式增量 revise 广播

**核心思路**:assistant 消息在**流式期间**就以版本链持续写入共享库并广播,消费端「同 id 更新」;不再等完成。

### 总体链路(以桌面发消息 → Web 实时看到打字为例)

```text
桌面端 assistant token → appendTextBlock → currentMessage.blocks 更新
  → 【新增】流式防抖同步器(350ms):currentMessage 内容上传共享库
       ├─ 该 assistant 消息未 append → V2MessageLog.append(id, v1)
       └─ 已 append → V2MessageLog.revise(id, content) → 新版本
         ↓
后端 message_append / message_revise 写 messages.db
  → 【新增】revise 也广播 chat-message-upserted(带新版本 entry)
         ↓ EventBroadcaster
Web 端 WS 订阅 → handleMessageUpserted
  → 【修改】同 id 已存在 → 用新版本**替换**该消息(blocks/timestamp/isStreaming)
  → 气泡实时打字效果
```

### 设计决策

1. **流式频率**:防抖 350ms(不是每 token)。WAL + 单行 INSERT,毫秒级。流式轮次改写成「整轮最多几十次修订」,不刷屏。
2. **首轮 user 实时**:`sendMessage` 在 `aiChatDispatch('start')` 返回 `newSessionId` 并 `set({conversationId})` **之后**,补一次 `syncSessionToShared` → 首轮 user 消息立即写库广播。
3. **消费端更新语义**:`handleMessageUpserted` 中,同 id 已存在 → 用新 content 的 `blocks/timestamp` **替换**;不存在 → 追加。保证顺序稳定。
4. **完成态收尾**:`finishMessage` 照旧整轮回填,幂等(版本已存在跳过)。流式期间是增量、完成是全量,天然收敛一致。
5. **后端广播函数复用**:`broadcast_message_appended` 改名/泛化为 `broadcast_message_upserted`(append + revise 共用),tauri command 与 ipc dispatch 都调它。

### 为什么这是最优(对比备选)
- **备选 A(chat-event 跨端路由)**:改 EventRouter + store 映射 + contextId 携带 conversationId,侵入大,且 chat-event 是流式瞬时事件非持久化,断线即丢。
- **备选 B(仅完成态广播)**:现状,已证不满足「实时」。
- **本方案**:复用全部基建(版本链/广播/消费端去重),发送端一个防抖同步 + 后端 revise 一行广播 + 消费端一个更新分支,改动集中、风险可控、与「SQLite 权威」架构自洽。

---

## 3. 实施步骤

### 步骤 1:后端 revise 广播(Rust)
- `session_messages.rs`:`broadcast_message_appended` 泛化为 `broadcast_message_upserted(entry)`(概念改名,payload 不变)。
- `message_revise` tauri command:`revise` 成功后,构造最新版 entry(id/conversation_id/role/timestamp/device_id/content/new_version) → 广播。
- `ipc.rs` `dispatch_message_revise`:`revise_inner` 后同样构造 entry 广播。

### 步骤 2:前端消费端同 id 更新(TS)
- `messageRealtimeSubscription.ts` `handleMessageUpserted`:
  - 同 id 存在 → 用 `chatMessage` 的 `blocks` 替换该消息,同步 `timestamp`/`isStreaming`;不存在 → `addMessage`。
  - 依赖 store 新增 `upsertMessage`(或直接 map 替换)。

### 步骤 3:store 新增 upsertMessage(TS)
- `createConversationStore.ts`:新增 `upsertMessage(message)`:同 id 替换,否则追加。

### 步骤 4:首轮 user 实时(TS)
- `createConversationStore.ts` `sendMessage`:`set({conversationId})` 后补 `syncSessionToShared(sessionId, newSessionId, get().messages)`。

### 步骤 5:流式防抖同步器(TS)
- 在 `appendTextBlock`/`_flushTextBuffer`(或 eventHandler token case)里,currentMessage 变化时触发防抖同步:
  - 无 conversationId → 跳过(等 session_start 设置后)。
  - 构造完整 ChatMessage(currentMessage blocks + engineId + isStreaming:true),写共享库:首次 append / 之后 revise。
- 关键:需要知道「该 assistant 消息是否已上传过」→ 用 `syncedMessageIds`(messageSync.ts 已有水位)或模块级 Map<sessionId, messageId>。

### 步骤 6:测试 + 双端实测
- 后端:cargo check + 单测(revise 广播)。
- 前端:vitest(upsertMessage / handleMessageUpserted 更新分支 / 防抖同步)。
- 双端:桌面发消息 → Web 实时看到打字;Web 发 → 桌面实时。

---

## 4. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 广播风暴(高频 revise) | 350ms 防抖 + 版本链幂等;单轮修订次数有限 |
| 消费端替换破坏顺序 | 只替换同 id 消息,不重排;timestamp 不变 |
| 流式同步竞态(revise 比 append 先到) | 共享库幂等 append 兜底;revise 依赖已存在 |
| 首轮 user 与 assistant 版本链冲突 | user 是独立 id,互不影响 |
| 断线窗口 | 现有 seq + replay + 恢复兜底 |

## 5. 验收标准

1. 新会话首轮:发 user 消息 → 另一端 **立即**(<1s)看到 user 气泡。
2. 同一会话继续对话:assistant **边打字边**出现在另一端,不是结束后。
3. 完成后:两端消息最终一致,无重复。
4. 历史会话:恢复仍正常(shared 源)。
