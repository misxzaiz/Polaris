# 从 ZCode 借鉴会话管理：Polaris 多端会话统一方案（spec v1）

> 状态：提案（未实现）
> 目标读者：会话/前端/后端协作者
> 关联：`AGENTS.md` §3.3 数据根、§4.1 协议、§4.2 中断与幂等、§4.3 会话与存储
> 参考实现：`temp/ZCode/packages/{services/src/session, ui/src/store, client/src}`

---

## 1. 背景与问题

### 1.1 现状（已核实）

Polaris 会话体系目前是 **「前端内存真相 + JSONL 落盘 + 单一活跃会话」**：

- `src/stores/conversationStore/sessionStoreManager.ts`：
  - 全局 `Map<sessionId, ConversationStoreInstance>` + 单一 `activeSessionId`
  - 会话状态、消息、streaming 全部存在**每个前端进程自己的内存 store** 里
  - 事件按 `_routeSessionId` 路由进 store（`dispatchEvent`）
- `src/services/eventRouter.ts`：监听 `chat-event`，从 `contextId` 解析前端 sessionId 路由
- `src/services/dialogStorage/service.ts`：JSONL 文件落盘（per-file 串行队列 + 合并保护 + WAL append），但**只落消息与 meta，不落"活跃会话"、不落 streaming 状态**
- `src/session-v2/`：已有 `V2SessionEventLog` / `V2StateArbiter`（后端 SQLite 权威状态）、`V2SessionKernel`（后端权威查询 + 快照合并 `resyncSession`）、`reconcile` 对账**雏形**——但**没有接入 UI，且无跨端投影订阅**
- `src/services/transport/`：tauri IPC 或 HTTP/WS 二选一，两端各自连接**同一个后端服务**（桌面 `invoke` IPC，web `HTTP+WS`），事件各自进程内路由

### 1.2 用户痛点

> 「web 端和桌面端没办法同时交互」

根因（架构级，非单一 bug）：

1. **会话真相在前端进程内存**：桌面端创建的会话，web 端（另一进程）没有该 `sessionId` 的 store → 事件被 `dispatchEvent` 丢弃（`log.warn('事件未匹配到会话，丢弃')`），web 看不到、更无法操作。
2. **单一 `activeSessionId` 全局态**：不是按 workspace/会话桶隔离的，多窗口/多端同时看不同会话时互相覆盖。
3. **无跨端实时投影**：ZCode 有 `sessions-index` + `subscribeSessionsIndexV4`（workspace 级权威投影、resync、断线 gap repair）；Polaris 只有「断线后 `webReconnectResync` 拉一次 JSONL」，没有持续订阅，更不跨端。
4. **中断/仲裁无权威方**：`requestStart/requestInterrupt` 有后端命令，但前端 `interruptSession` 仍走本地 store 状态判断，两端同时操作会竞态。

### 1.3 ZCode 的做法（可借鉴的成熟模型）

ZCode（`temp/ZCode`）的会话管理是一套经过多轮迭代的成熟架构：

| 维度 | ZCode | Polaris 现状 |
|---|---|---|
| UI 状态分桶 | `workspaces: Record<workspaceKey, WorkspaceZCodeUIState>`（每 workspace 一份草稿/激活任务/运行态） | 全局单一 `activeSessionId` + `Map` |
| 会话真相源 | SQLite `tasksDatabase` + `sessions-index`（workspace 级权威投影） | JSONL 文件（消息）+ 前端内存 store（状态） |
| 状态权威 | 后端 `ZCodeAgent` 投影 `snapshot`（conflated 最新态）+ `seq` 递增 | `V2StateArbiter` 从事件日志计算（已存在但未接入 UI） |
| 跨端订阅 | `subscribeSessionsIndexV4` / `subscribeConversationV4`，桌面 continuous / 移动 replayable 共用同一 owner+seq | 无（只有断线后一次性 resync） |
| 仲裁 | CommandInbox 串行 admission + owner/lease + stale-run 防护 | `requestStart` 后端命令存在但前端仍本地判断 |
| 多端同时交互 | 桌面+移动同时操作同一会话，由同一后端投影收敛 | 不支持 |

---

## 2. 目标

让 Polaris 达到 ZCode 的会话管理水准：

1. **后端权威真相**：会话列表、消息、运行状态都以**后端 SQLite（`session-v2/messages.db` 已有）+ JSONL 消息**为准，前端只做投影。
2. **跨端统一投影**：web / 桌面 / 移动任一进程都能看到并操作同一会话——通过**后端事件订阅**（`chat-event` 已有）+ **workspace 级会话投影**（新增）。
3. **按 workspace 分桶的 UI 状态**：多窗口、多端各自持有自己的 UI 局部态，但活跃会话、运行态从后端投影读。
4. **单一仲裁路径**：发送/中断/重试都走后端权威，两端同时操作不会竞态。

---

## 3. 方案设计

### 3.1 总体架构（文字图）

```text
                    ┌─────────────────────────────────────────────┐
                    │            后端（src-tauri）                │
                    │  session-v2/messages.db (SQLite)            │
                    │   ├─ session_register / session_list        │
                    │   ├─ session_event_append / read_after_seq  │
                    │   ├─ session_get_status / request_start     │
                    │   └─ sessions-index 投影（新增）             │
                    └──────────────▲──────────────────▲───────────┘
                                   │ IPC / HTTP+WS    │ IPC / HTTP+WS
                    ┌──────────────┴────────┐  ┌──────┴────────────┐
                    │ 桌面进程（tauri）      │  │ web/移动进程       │
                    │  store: workspace 桶  │  │ store: workspace 桶│
                    │  投影 = 后端权威       │  │  投影 = 后端权威    │
                    └──────────────────────┘  └────────────────────┘
```

关键设计决策（对齐 ZCode 的 `AGENTS.md` / `SKILL.md` 治理）：
- **单一事实源**：后端 SQLite 是 session 的权威真相；前端 store 只是「按 workspace 分桶的投影缓存」。
- **单一写入路径**：所有变更走后端命令（`session_request_start` / `session_append_message` / `session_event_append`），前端不双写。
- **显式时序**：每条会话事件带 `seq`（后端分配）+ `deviceId`，跨端按 seq 因果收敛；resync 只补缺失，不覆盖新事件。
- **幂等**：append 用 `INSERT OR IGNORE`（已有），resync 按 id 去重（已有）。

### 3.2 阶段划分（增量落地，避免大爆炸重构）

#### 阶段 A：接入后端权威状态到 UI（不动 UI 结构）

- [ ] 让 `sessionStoreManager` 的 `activeSessionId`、`status` 改从后端 `session_get_status` 读取（`V2StateArbiter` 已存在，接上）。
- [ ] `dispatchEvent` 在事件缺失 store 时**不丢弃**，改为「按 `_routeSessionId` 建临时投影」或「回退后端会话列表」。
- 验收：web 与桌面打开同一会话，状态（running/idle/error）一致。

#### 阶段 B：workspace 分桶 UI 状态（对齐 ZCode `zcodeSessionStore`）

- [ ] 把全局 `activeSessionId` + `Map` 重构为 `workspaces: Record<workspaceKey, WorkspaceSessionState>`（对齐 `zcodeSessionStoreWorkspaceSlice` 的 `setActiveTaskId` / `startDraft` / `setTaskState` 等）。
- [ ] hooks 层不直连 store 内部（已有约定），新增 `useWorkspaceSession` 族。
- 验收：多窗口/多端各自切换会话不互相覆盖；草稿态、运行态按 workspace 隔离。

#### 阶段 C：后端 sessions-index 投影（对齐 ZCode `sessions-index`）

- [ ] 后端新增 `session_list_workspace(workspaceId)` + `session_subscribe(workspaceId, afterSeq)`（事件流，桌面 continuous / web replayable 共用）。
- [ ] 前端新增 `subscribeWorkspaceSessions`：首拉快照 + 增量帧 + gap repair（断线后 `readAfterSeq` 补齐）。
- [ ] `webReconnectResync` 从「一次性拉 JSONL」升级为「订阅重放」。
- 验收：桌面新建/删除会话，web 侧自动出现/消失；web 发送消息，桌面实时收到。

#### 阶段 D：统一仲裁（对齐 ZCode CommandInbox / owner-lease）

- [ ] 发送前先 `session_request_start`（后端仲裁：已 running 拒绝）；中断走 `session_request_interrupt`（后端校验 deviceId 权限）。
- [ ] 前端 `interruptSession` / `sendMessage` 不再本地自决，统一走后端。
- 验收：两端同时点发送/中断，只有一个成功，另一个得到明确拒绝原因。

### 3.3 数据结构（协议增量，保守对齐现有）

```ts
// 会话投影（后端权威，前端只读）
interface SessionProjection {
  sessionId: string          // 前端 sessionId
  conversationId: string | null
  title: string
  status: 'idle' | 'running' | 'error' | 'none'
  seq: number                // 跨端因果序
  updatedAt: number
  workspaceId: string | null
  engineId: string
  lastError: string | null
  startedByDevice: string | null
}
```

- 协议变更需**双向同步**：Rust `models/ai_event.rs` / 前端 `src/types/`（AGENTS.md §4.1 已强调）。
- 无运行时 schema 校验是已知缺口，本次保守：只加字段、不改已有枚举。

### 3.4 与现有 `session-v2` 的关系

- `session-v2` 的 `V2SessionEventLog` / `V2StateArbiter` / `V2SessionKernel` / `reconcile` **全部保留**，是阶段 A/C/D 的后端底座。
- 缺的只是「UI 接入」+「workspace 分桶」+「订阅投影」三块。
- `reconcile` 目前是验证用实现，可在阶段 C 作为「订阅快照 vs 本地」的对账器接入。

---

## 4. 验收标准（可执行）

| 编号 | 场景 | 验收 |
|---|---|---|
| A1 | 桌面开会话 A，web 打开 | web 看到 A 的 running/idle 状态与桌面一致 |
| A2 | 桌面发送消息 | web 实时收到（<2s），不丢事件 |
| B1 | 桌面看会话 A、web 看会话 B | 两端互不覆盖（无串台） |
| B2 | 切换 workspace | 各自草稿/运行态独立 |
| C1 | 桌面新建/删除会话 | web 列表自动增删（无需刷新） |
| C2 | 断线重连 | 增量补齐，不重复、不丢事件 |
| D1 | 两端同时发送 | 仅一端成功，另一端收到明确拒绝 |
| D2 | 两端同时中断 | 仅一端成功，状态一致收敛到 idle |

---

## 5. 风险与边界

- **协议漂移**：改 `models/ai_event.rs` + 前端类型必须同 PR；建议阶段 C 顺带补最小运行时校验（可先不加）。
- **巨文件**：`createConversationStore.ts`（2535 行）是阶段 B 主要触碰点，**按 AGENTS.md 只拆新增改动常触碰的部分**，不做无收益大规模重构。
- **中断竞态**：已知记忆 `ai-chat-interrupt-continue-root-cause`，阶段 D 必须保留幂等与顺序语义（`requestInterrupt` 返回 reason）。
- **存量数据兼容**：旧 JSONL 会话（`externalId`）与新的后端会话投影需映射兼容；迁移策略另出 spec。
- **本机验证**：`cargo test --lib` 不可用（Tauri DLL 限制），后端验证用 `cargo check`；前端 `pnpm typecheck` + 对应 vitest（`session-v2/tests/` 已有）。

---

## 6. 里程碑

| 阶段 | 产出 | 依赖 |
|---|---|---|
| A | UI 状态接后端权威 | 无（V2StateArbiter 已有） |
| B | workspace 分桶 store | A |
| C | sessions-index 订阅 | B |
| D | 统一仲裁 | C |

建议按 A → B → C → D 顺序，每阶段一个 PR、一个 `plans/` 子 spec、一组 vitest。
