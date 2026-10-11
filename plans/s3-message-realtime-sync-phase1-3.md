# S3 阶段 1-5：桌面 ↔ Web 消息双向实时同步 + 共享历史恢复（渐进方案 A）

> 状态：阶段 1-5 已实现
> 目标：桌面端发消息 Web 端实时看到新气泡，反之亦然；历史恢复以共享 SQLite 为权威（无需点「恢复」仍可拿完整消息）
> 关联：`session-management-zcode-alignment.md`（spec v1）、当前未提交的 S3 会话投影同步批次
> 验证约束：`cargo check`（Rust lib 测试受 Tauri DLL 限制）、前端 `pnpm tsc --noEmit` + vitest

---

## 1. 结论先行（已核实的事实）

**后端共享，证据链闭合**：

| 层 | 证据 | 含义 |
|---|---|---|
| 传输 | `detector.ts`：桌面 IPC / Web HTTP+WS，同连一个 Rust 后端 | 两端同一后端进程 |
| 广播 | `lib.rs:606`「都经同一 EventBroadcaster」+ `event_broadcaster.rs` 全局单例、seq、重放缓冲 | 桌面与 web 的广播是同一事件流 |
| 存储 | `session_messages.rs:25` / `session_state_commands.rs:29`：`<DataRoot>/session-v2/messages.db` 全局单例 SQLite | 会话状态表 + 消息表 + 会话索引同库同文件 |
| 索引 | `session_state_commands.rs` 的 `session_index_*_inner` 供 IPC + web dispatch 双调 | 会话索引同库 |

**当前断点**：消息「真相」仍在前端各进程内存 + 本地 JSONL，从未进入后端共享 SQLite。广播只带会话元数据，不带消息体。所以 web 端只能看到「会话存在」，须点「恢复」拉历史。

**已有且可直接复用的底座**（大幅降低本阶段工作量）：
- 后端 `message_append_inner` / `message_read` 全套（幂等 INSERT OR IGNORE、修订链、WAL）✅
- 前端 `V2MessageLog`（`src/session-v2/core/v2-message-log.ts`）封装全套 `message_*` 命令 ✅
- `deviceId` 来源 `@/utils/deviceId` ✅
- 广播范式 `session_index_register`（`session_state_commands.rs:349`）✅
- 前端订阅范式 `WorkspaceSessionsSubscription`（WS 订阅 + 增量轮询兜底）✅

---

## 2. 总体链路（本阶段 桌面 → Web 单向）

```text
桌面端 ChatInput.handleSend
  → createConversationStore.sendMessage (user 消息入内存 + 本地 JSONL)
  → 【阶段1】sendMessage 内调 V2MessageLog.append(post 到后端 SQLite)   ← 双写
         ↓
后端 message_append (tauri command) 写 messages.db
  → 【阶段2】message_append 广播 chat-message-upserted(完整 MessageEntry)
         ↓ EventBroadcaster (全局单例)
Web 端 WS 订阅 chat-message-upserted
  → 【阶段3】按 conversationId 路由→ upsert 进对应会话 store 消息列表 → 气泡实时出现
```

**关键推论**：由于两端共享同一个 SQLite + 同一个 EventBroadcaster，本阶段「桌面→web」打通后，反向（web→桌面）只需在 `/api` HTTP bridge（ipc.rs）调 `message_append` 时补同一份广播（阶段 4 收尾，本阶段只做单向，但设计必须预留）。

---

## 3. 分阶段实施

### 阶段 1：发送双写（桌面主链路）

**目标**：桌面端发消息时，user + assistant 消息同时写入后端 SQLite。

**改动文件**：
- `src/stores/conversationStore/createConversationStore.ts`（`sendMessage` 内、`addMessage` 后、`router.initialize()` 附近）
- 新增 `src/session-v2/messageSync.ts`（薄封装：把 ChatMessage 转 MessageEntry + fire-and-forget append）

**关键决策**：
- **conversationId 归属策略**：user 消息在首轮发送时 `conversationId` 可能为空（`sendMessage` 里 `const { conversationId } = get()`）。设计为——若 `conversationId` 为空，先用**本端 `sessionId`** 作为 `conversationId` 占位写（消息有归属）；后续 `conversationId` 确定后（首轮后）同一会话仍以稳定 id 关联。此策略影响阶段 3 的「按会话路由」，必须一并固化。
  - ⚠️ **待定**：`conversationId` 在首轮发消息时到底有没有？需再核 `sendMessage` 后续段（`router.initialize()` 之后是否 request_start 产出 conversationId）。若首轮就有则无占位问题。**核实后再定死**。
- **双写失败策略**：fire-and-forget，失败仅 `log.warn`，不影响本地会话（与 `registerSessionToIndex` 的 `.catch(log.warn)` 同款）。
- **幂等**：复用 `message_append` 的 `INSERT OR IGNORE`(id+version 幂等)，重复写安全。

**验收**：桌面发「你好」，`messages.db` 的 `session_messages` 表出现该消息。

### 阶段 2：消息级广播（后端）

**目标**：`message_append` 写库成功后，经 EventBroadcaster 广播 `chat-message-upserted`。

**改动文件**：
- `src-tauri/src/commands/session_messages.rs`：`message_append` tauri command 附加广播（对齐 `session_index_register` 范式）。

**广播 payload**：
```json
{
  "event": "chat-message-upserted",
  "payload": {
    "conversationId": "...",
    "message": { /* 完整 MessageEntry(serde camelCase) */ }
  }
}
```

**注意**：`message_append_inner` 本身不广播（web HTTP bridge 走 inner）。本阶段不影响单向；阶段 4 反向时需在 ipc.rs dispatcher 补广播。**设计预留**：广播逻辑抽成一个 `pub fn broadcast_message_appended(&self, entry)` 辅助，供 command 与 ipc dispatcher 复用。

**验收**：桌面发消息，后端 `messages.db` 的广播流（`event_broadcast.subscribe()` 或 WS 客户端）收到 `chat-message-upserted`，payload 含完整消息。

### 阶段 3：Web 端实时合并（消费者侧）

**目标**：Web 端 WS 订阅 `chat-message-upserted`，把消息 upsert 进对应会话 store，气泡实时出现。

**改动文件**：
- 新增 `src/services/messageSubscription/messageRealtimeSubscription.ts`（对齐 `WorkspaceSessionsSubscription` 样式：listen + 路由 + 去重 + 断线兜底）。
- `src/services/messageSubscription/index.ts`（激活/停用生命周期，接入现有 session 激活流程）。
- 消费端：在 `createConversationStore` 或 message 渲染层，把广播消息并入消息列表。

**关键决策**：
- **去重**：本地已存在的消息 id 不重复插入（后端幂等 + 前端 Set 双重保护）。发消息端（桌面自己）也收到广播？—— EventBroadcaster 会广播给所有订阅者含发送者，需靠 `id` 去重跳过自己。
- **conversationId 路由**：Web 端对应会话怎么匹配？需要「广播的 conversationId ↔ Web 端哪个会话 store」。设计用 `sessionStoreManager` 的 `stores` 扫一遍，匹配 `conversationId`。若 Web 端尚未打开该会话（无 store），则消息暂存「待消费队列」或忽略（由会话索引投影 + 恢复兜底，本阶段不强求后台会话实时填充）。
- **断线兜底**：gap 时走 `message_read_after`(已有) 补拉。本阶段可先不做复杂 gap，复用 WS replay (`event_broadcaster` 已有 seq+replay)。**压实程度待定**。

**验收**：Web 端（3500 端口页面）打开发送端同一会话，桌面发「你好」，Web 端 1-2 秒内出现新气泡，无需刷新。

---

## 4. 关键待确认（写码前必须先定）

1. **conversationId 首轮时有没有**（决定阶段 1 占位策略）。→ 在 `sendMessage` 里 `router.initialize()` 后打断点核实。
2. **发送端是否过滤自己的广播**：`chat-message-upserted` 会广播回发送者，靠 `message.id` 去重是否足够（应足够，因为发送端本地已有该 id 的消息）。
3. **Web 端会话未打开时的消息去向**：忽略（由恢复兜底）还是暂存。建议 **忽略 + 会话索引投影已能引导用户打开**，本阶段不做后台会话实时填充（那是阶段 4/5 范围）。
4. **阶段 4（反向）是否本阶段顺带**：建议**不做**，本阶段严格单向，但广播逻辑抽复用函数，阶段 4 只需在 ipc.rs 补一处调用。

> **已拍板（修正原草案的"双写"为"首轮回填"）**：
> 经核实 `sendMessage` 首轮 `conversationId===null`（`createConversationStore.ts:155/2035`），后端 `conversation_id TEXT NOT NULL` 不可为 null。故阶段 1 **不能发消息即写**，改为：
> - **非首轮**（conversationId 已定）：消息完成后回填写 SQLite，实时；
> - **首轮**（conversationId===null）：整体等待 `set({conversationId})`（首轮 request 返回）后，**补写本轮 user+assistant 整轮**。
> - 依赖 `session_mapping` 表（S5 已有，`session_state.rs:102`）做前端 sessionId ↔ conversationId 权威映射；Web 端路由用现成 `findByConversationId`（`sessionStoreManager.ts:892`）。
> - 弃用「本端 sessionId 占位写」策略：占位迁移有并发错乱风险，A 方案零占位、强一致。

> **已拍板（阶段 1 实现粒度）**：
> - **全量写，不增量**：每次消息完成（assistant `finishMessage`、user 加入后）后，把该会话**当前全部 messages** 按会话写 SQLite。幂等由后端 `INSERT OR IGNORE`(id+version)兜底，重复写安全。
> - **hook 点：非侵入**。不重写 `createConversationStore`（2500+ 行）。在 `sendMessage` / `finishMessage` 成功路径补一个 `syncSessionToShared(sessionId, conversationId, messages)` 调用，fire-and-forget。
> - **阶段 5 再优化为增量**：本阶段聚焦打通链路，不做水位/增量优化（消息量小 + 幂等兜底，全量写可接受）。
> - `MessageEntry.content` = 完整 `ChatMessage` JSON 序列化（设计既定位），不做逐字段翻译，Web 端还原时 `JSON.parse`。

---

## 5. 里程碑（每阶段独立提交）

| 阶段 | 提交 | 依赖 | 验证 |
|---|---|---|---|
| 1 | 发送双写 | 无 | `cargo check` + 前端 `messageSync` 单测 ✅（8 测试绿） |
| 2 | 消息广播 | 1 | 后端单测 + `cargo check` ✅ |
| 3 | Web 实时合并 | 1,2 | 前端单测 + 双端手测 ✅（7 测试绿 + useAppInit 接线） |
| 4(预留) | 反向打通 | 1,2,3 | 后端 + 前端单测 ✅ |
| 5 | 共享历史恢复 | 1,2,3,4 | sessionMapping 单测 + 全量 186 测试绿 ✅ |

> **阶段 4 已实现（2026-10-11）**：Web→桌面反向打通，三处改动——
> 1. `ipc.rs:dispatch_message_append` 补 `state` 参数，写库后复用 `broadcast_message_appended` 广播（与桌面端 command 同一广播函数）；
> 2. `lib.rs` 桌面 Tauri emit 中继白名单加 `chat-message-upserted`（原仅 chat-event / session-index-*），桌面 webview 实时收到；
> 3. 桌面端零前端改动——`messageRealtimeSubscription` 已在 useAppInit 启动，tauri `listen` 事件名与 payload 形状与 WS 完全一致（`{conversationId, message}`），`handleMessageUpserted` 同一处理函数复用。
> 自广播（Web 写→桌面收 / 桌面写→Web 收）由 `message.id` 去重跳过，与阶段 3 一致。

> **阶段 5 已实现（2026-10-11）：共享历史恢复（一致性闭环）**
> 调研发现：实时路径写后端 SQLite，但**恢复路径（`loadMessagesForItem`）只读本地 JSONL / localStorage / 引擎原生**，
> Web 端恢复「桌面端创建的会话」会拿空/错消息源。修复分三层——
> 1. **后端「会话映射解析」命令层**（`session_state_commands.rs` + `ipc.rs` 路由）：
>    `session_mapping_resolve`（sessionId→mapping）/ `session_mapping_find_by_conversation` /
>    `session_mapping_upsert`。复用 S5 已有的 `session_mapping` 表（此前从未被写）。
>    Rust roundtrip 测试已写（本机 cargo test 受 Tauri DLL 限制，cargo check 通过）。
> 2. **前端写映射**（`createConversationStore.ts` sendMessage 首轮 `set({conversationId})` 后）：
>    fire-and-forget upsert，固化「前端 sessionId ↔ 引擎 conversationId」。
> 3. **前端恢复读共享源**（`historyService.ts` `loadMessagesForItem`）：JSONL 之后、localStorage 之前
>    插入 SQLite 权威源——resolve mapping → conversationId → `V2MessageLog.read` → 完整消息恢复，
>    `source: 'shared'`。恢复优先级：自有 JSONL（本端无损）> SQLite（跨端权威）> localStorage > 引擎原生。
> 单测：`sessionMapping.test.ts`（7 测试绿）+ 全量 186 测试绿。
>
> **gap repair / 增量写无需额外实现**：WS 层已有 seq + lastSeq + resume + replay（`httpTransport.ts`），
> 断线重连自动补发；幂等水位 + `INSERT OR IGNORE` 已实现「增量」效果。

---

## 6. 风险

- **广播风暴**：每条消息广播一次，流式场景 assistant 高频 revise 会刷屏。缓解：广播只发「完成态」或「首版」，修订走 `chat-message-revised`（本阶段可先只广播 completed 消息，避免流式中途打扰）。
- **双真理不一致窗口**：本端 JSONL 仍是即时真相，SQLite 是镜像，极端并发存在短暂不一致。渐进方案 A 的**接受范围内**，最终收敛由阶段 5 仲裁保证。
- **`conversationId` 稳定性**：引擎轮换 conversationId 时旧消息与新消息归属不一致。需在阶段 1 用「会话级稳定 id」关联，避免会话切换错乱。