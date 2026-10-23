# 多设备会话同步 —— 问题诊断与重构方向规划

> 状态：方案规划（未实施）· 2026-10-23
> 读者：会话域 / 前端 / 后端协作
> 核心诉求：「无法多设备正常同时使用同一个会话」
> 关联：`plans/session-rearchitecture/`（S1-S7 已有全套 spec，S6/S7 已实施，S1-S5 已被回滚）

---

## 1. 结论先行

**当前 Polaris 会话体系是「单机正确、跨端缺失」状态。**

- ✅ **单机收敛已完成**（S6/S7，已合入 main）：消息真相收敛到后端 SQLite `session_messages` + `turn_persist` 兜底；前端 store 只是内存视图；重复 AI 回复问题已修。
- ❌ **跨端能力整体缺失**（S1-S5，2026-10-14 全部 Revert）：sessions_index 投影、workspace 分桶、跨端订阅广播、统一仲裁、session_mapping 映射表——全部不在 main 上。

你的痛点「多设备同时使用同一会话」**正是被回滚掉的那部分**，目前仍无人重新实现。

---

## 2. 现状诊断（已交叉核实）

### 2.1 数据流

```text
[桌面进程]                                  [web / 移动进程]
sessionStoreManager(Map)                   sessionStoreManager(Map)
  ├─ activeSessionId 全局单一                 ├─ activeSessionId 全局单一
  └─ stores[sessionId].messages              └─ stores[sessionId].messages
       ▲ 事件按 _routeSessionId 路由               ▲ 事件按 _routeSessionId 路由
       │                                            │
   EventRouter(单例)                           EventRouter(单例)
       ▲ chat-event（IPC）                        ▲ chat-event（HTTP/WS）
   ┌────┴────────────── 同一后端 ────────────┴────┐
   │  cap.ai.chat / turn_persist / session_db      │
   │  dialog_index（索引/搜索）                     │
   └──────────────────────────────────────────────┘
```

### 2.2 已核实的代码事实

| 项 | 现状 | 证据 |
|---|---|---|
| 全局活跃态 | `activeSessionId: string \| null` 单一全局 | `src/stores/conversationStore/types.ts:800` |
| 事件路由 | 无 store 直接丢弃 | `sessionStoreManager.ts:573`（`log.warn('事件未匹配到会话，丢弃')`） |
| 跨端投影 | 无 `sessions_index` 表 | git 回滚（`f5dc3c68` 等 14 个 Revert） |
| workspace 分桶 | 无，仅 `MultiSessionGrid` 单进程内多开 | `src/stores/viewStore.ts` `multiSessionIds` |
| 消息写路径 | 后端 `turn_persist` 兜底 + 前端恢复读 JSONL | `ai_chat_core.rs` 3 处调用；`createConversationStore.ts:36` 仍 import `dialogStorageService` |
| 仲裁 | `sendMessage`/`interrupt` 前端本地自决 | `createConversationStore.ts:1977/2176` |
| 后端底座 | `session_db.rs`(654行) + `session_state.rs` + `session_state_commands.rs` + `dialog_index.rs`(1170行) | 均在 main |

### 2.3 关键历史：S1-S5 为什么被回滚（需确认）

git 时间线（2026-10）:
- **10-11**：S1-S5 跨端同步 17 个提交一次性合入（后端投影表、workspace 分桶、订阅广播、消息双向同步、统一仲裁、映射表）。
- **10-14**：全部 Revert（14 个 Revert 提交 + 1 个总回滚 `f5dc3c68`，共 44 文件 31 删 13 改，标注「0 冲突」）。
- **10-14/15**：重设计 S6/S7（单机收敛），**刻意不做跨端**。
- **10-21**：`plans/session-rearchitecture/` 全套 S1-S7 spec 更新。
- **至今**：跨端未再尝试。

**回滚标注「0 冲突」= 主动回滚，非被迫。** 回滚原因在现有 docs/记忆里**没有明确记录**。这是重新规划前**必须补的一课**——否则新方案可能重蹈覆辙。

可能原因（需与用户确认）：
1. **实现质量**：15 个提交 3 天内塞入，可能引入回归/不稳；
2. **方案复杂度**：跨端双写、id 映射、设备仲裁太多边角，短期不可控；
3. **被更高优先级打断**：10-14 后转投 S6/S7（消息重复这个更痛的 bug）与 plugins。

---

## 3. 问题分层清单

### 3.1 跨端不可见（核心痛点）

| # | 问题 | 现状 | 影响 |
|---|---|---|---|
| 1 | 会话真相在进程内存 | 另一进程无该 sessionId 的 store | 桌面开的会话 web 完全看不到 |
| 2 | 事件只进发起进程 | `dispatchEvent` 未匹配即丢弃 | 另一端收不到流式/状态变化 |
| 3 | 单一全局 activeSessionId | 无 workspace 分桶 | 多端同时看不同会话互踩 |
| 4 | 无跨端列表订阅 | 仅断线后一次性 resync | 另一端新建/删除本地不感知 |
| 5 | 无统一仲裁 | 发送/中断前端自决 | 两端并发发送/中断竞态 |

### 3.2 单机既有功能隐患（修复式补丁堆积）

| # | 问题 | 证据 | 说明 |
|---|---|---|---|
| 6 | `createConversationStore.ts` 2660 行 | 巨文件第四名 | 生命周期内塞入 messages/progress/attachment/notification/running 全状态 |
| 7 | `eventHandler.ts` 1186 行 + 30+ 事件类型 | 每个 case 一堆去重/兼容 | toolCallDedup、dedupMessages、id 漂移指纹去重、补丁 B，修复式补丁多 |
| 8 | JSONL 双源问题 | 前端读 JSONL + 后端 SQLite 兜底 | S7 已收敛但前端恢复仍走 JSONL，两源需持续对齐 |
| 9 | `dialog_index.sessions` 无软删除/意图位/未读 CAS | 表结构已核实 | 无法可靠表达已删会话/标题 override/未读 |
| 10 | `session_state.rs` 与 `session_db.rs` 共用 messages.db 且各自 PRAGMA user_version 删库 | 评审决策记录了陷阱 | 任何新增表须 `CREATE TABLE IF NOT EXISTS` 幂等补建，禁止触版本号 |

### 3.3 与 zcode 的差距（治理层）

| 维度 | zcode | Polaris |
|---|---|---|
| 唯一写者原则 | 「会话事实归 CLI，组织态归 Host，每字段一个写者」+ 17 条不变量 | 无对应纪律，事件处理器内补丁堆叠 |
| workspace key | `identity ?? path` 统一 | 仅 `workspace_id`，无身份隔离 |
| 订阅语义 | desktop continuous / mobile replayable 区分 | 无（只有一次性 resync） |
| 断线补齐 | afterSeq gap repair | 无 |
| 仲裁 | CommandInbox 串行 admission + owner/lease + stale-run 防护 | `request_start/interrupt` 雏形但未接 UI |

---

## 4. 重构方向（三选一，待确认）

### 方案 A：在 S6/S7 单机收敛基础上，重启「后端权威跨端投影」（推荐）

沿用已定稿的 `session-rearchitecture/S1-S5` spec，但：
- **先补"为什么回滚"的根因复盘**（读 git 原提交 diff、找当时测试/issue），修复原实现质量问题再重做；
- 分阶段（S1 后端投影 → S2 前端分桶 → S3 订阅 → S4 仲裁 → S5 迁移），每阶段独立可验证；
- 复用已有的 `session_db.rs` + `session_state.rs` + `cap.ai.chat` 底座，不重复造。

**优点**：方向与 zcode 一致、有多端完整模型可参照、spec 已齐。
**缺点**：工作量大；S1-S5 曾失败过一次，需先解根因。

### 方案 B：最小可行跨端（先解决"能看到、能恢复"）

不重做完整分桶/仲裁，只做一层轻投影：
- 后端已有 `session_db.rs` / `dialog_index.rs` → 加一张 workspace 级会话快照表 + `session_list_workspace` 命令；
- 前端加「远端会话可恢复条」（类似当年 MultiSessionGrid 的 RemoteSessionsStrip）；
- 不做实时流式跨端预览、不做双端同时操作一个活跃会话（保持单写者=发起端）。

**优点**：实现量小（可能 1-2 周）、直接命中「另一设备看不到会话」这个最痛的点。
**缺点**：不解决"同时交互一个会话"，是中间态。

### 方案 C：消息走后端单一真相，跨端=只读副本消费

消息已由 `turn_persist` 落 SQLite（这是最大成就），把**前端读取也统一改走后端**，跨端自然一致：
- 前端不再读 JSONL，恢复/实时都从 `session_messages` 读；
- 跨端展示 = 每个端都是同一 SQLite 的只读投影；
- 写入唯一 = 后端 `turn_persist`（已存在），前端只发命令。

**优点**：把"跨端"问题降维成"单一存储多端读"，架构最干净，最符合 zcode 唯一写者原则。
**缺点**：消息读写路径改造（S7 spec 里的 Phase 0-4 已有评估），且引擎 conversationId 与前端 sessionId 仍需映射。

---

## 5. 建议路径

1. **先补历史课**：查 S1-S5 被回滚的真实原因（用户侧知情 + git 原代码 diff 分析 + 当时测试）。
2. **确认方案**：从 A/B/C 中选一（或组合：C 的存储单一真相 + B 的轻投影先行）。
3. **补 spec 到 `plans/`**：按 AGENTS.md §4 要求，目标、所有者、接口、验收先写齐。
4. **分阶段实施**：每阶段一个 PR + vitest + `cargo check`，避免 10-11 那种一次性 17 提交塞入。

---

## 6. 待用户确认的问题

1. **S1-S5 当初为什么回滚？** 是方案不可行、实现质量问题，还是复杂度/优先级？这决定 A 怎么重做。
2. **跨端要达到什么程度？** 仅是"另一设备能看到+能恢复"（B），还是"真正同时交互同一会话"（A）？
3. **移动端是否在范围内？** `polaris-mobile`/`polaris-pocket` 刚被移除（10-23 提交 `0f6b18ff`），移动端现状如何？