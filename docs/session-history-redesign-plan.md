# 会话历史体系重构方案（Session History Redesign）

> 状态：方案评审中
> 前置：根因分析已完成（见文末附录 A），本方案以「用户体验」为北极星重新设计，替代原「手写两级 JSON 索引」思路。

---

## 1. 目标与设计原则

### 1.1 要解决的用户问题

| # | 用户感知 | 本质 |
|---|---------|------|
| P1 | 会话内容记录不全 / 回看时显示不全 | 写路径数据丢失（压缩态覆写污染 + 只在 session_end 落盘） |
| P2 | 换浏览器 / 换设备看不到历史 | Web 端数据落在浏览器私有 OPFS，未走已就绪的服务端 API |
| P3 | 打开历史列表和恢复会话都很慢 | 无索引全量扫描 + 全量读取全量渲染 |
| P4 | 找不到想继续的那个会话 | 信息架构以"存储实现"组织（双 Tab），缺搜索、缺标注、缺"继续工作"心智 |

### 1.2 设计原则

1. **数据正确性 > 性能 > 功能**。先保证一个字都不丢，再谈快和好用。
2. **JSONL 文件是唯一事实源（source of truth）**，任何索引都是可丢弃、可重建的缓存。杜绝 IndexedDB 时代"索引即数据"导致错乱的老路。
3. **不把存储实现暴露给用户**。"自有存储 / 引擎历史"是实现细节，用户看到的应该是"我的会话"一个时间线。
4. **续聊是第一场景**。历史面板不是存档馆，是"接着干活"的工作台。
5. **全端一致**。桌面、浏览器、移动 WebView 看到同一份数据。

### 1.3 对原始需求的修正说明

原始需求提出"分级索引，一级记录前 50 条，数量可配置"。引入 SQLite 索引后该需求被自然消解：

- 分级的动机是"避免读全量索引文件"，而 SQLite 的 `ORDER BY updated_at DESC LIMIT ?` 天然按需取前 N 条，不存在"全量读索引"问题，无需人为分级；
- "前 50 条可配置"保留为两个体验配置项：**列表分页大小**（默认 20）与**会话首屏消息数**（默认 50），见 §6.3。

---

## 2. 架构总览

```
                          ┌────────────────────────────────────┐
  桌面端 (Tauri IPC) ────►│  Rust 后端                          │
  浏览器 (HTTP)      ────►│                                     │
  移动端 WebView (HTTP) ─►│  <DataRoot>/dialogs/                │
                          │   ├─ {id}.jsonl     ← 事实源        │
                          │   └─ index.db       ← SQLite 索引   │
                          │       ├─ sessions   (元数据+标注)    │
                          │       ├─ sessions_fts (FTS5 全文)   │
                          │       └─ native_cache (原生会话缓存) │
                          └────────────────────────────────────┘
  浏览器 OPFS：仅"后端不可达"时的离线兜底（含一次性迁移上行）
```

- **写路径**：消息完成即 append（增量），轮末规整；索引同步 upsert。
- **读路径**：列表/搜索/筛选全部查 SQLite；打开会话尾部优先分页读 JSONL。
- **native 会话**（Claude/Codex 原生 JSONL）：不搬移不改写，仅在 index.db 建缓存行（mtime+size 失效），与自有会话在同一张表里按 sessionId 合并呈现。

---

## 3. Phase 0 — 数据止损（最高优先级）

> 目标：从今天起不再丢任何一个字。全部是 bug 修复级改动，不引入新概念。

### 3.1 修复压缩态覆写污染（P1 核心）

现状链路：离屏消息被 `messageCompactor` 截断 → 快照 LRU(20) 溢出 → 二级兜底 `hydrateFromLocalStorage` 读死 key（写入方 `historyService.saveToHistory` 无调用方）→ `session_end` 时 `getPersistableMessages` 拿到截断态 → **全量覆写 JSONL，完整历史被永久污染**。

修复（两道保险）：

1. **写侧合并保护**：`dialogStorageService.saveConversation` 覆写前按消息 id 与磁盘旧版合并——新消息以内存为准；旧消息若内存版带 `__compacted__` 标记而磁盘版完整，**保留磁盘版**。截断态从此写不进磁盘。
2. **兜底改道**：压缩消息的二级恢复从 localStorage 死链改为**读自有 JSONL**（磁盘上就有完整版），按 conversationId + messageId 定位；同时删除 `event_chat_session_history` 相关死代码（`historyService.saveToHistory`、`conversationStoreUtils.hydrateFromLocalStorage` 的 localStorage 路径、`sessionHandoff.ts:325` 同步改造）。

涉及：`src/services/dialogStorage/service.ts`、`src/stores/conversationStore/conversationStoreUtils.ts`、`createConversationStore.ts (getPersistableMessages)`、`eventHandler.ts (saveDialog)`。

### 3.2 增量落盘：消息完成即 append（P1 第二根因）

现状只在 `session_end` 整体覆写：流式中途崩溃/刷新，当轮全丢（含用户自己发的消息）。

改造：

- 前端维护**已落盘 seq 水位**（per session）。用户消息发送时、assistant 消息完成时（`message_complete` 级事件），把水位之后的新消息 append 到 JSONL（新增 Rust 命令 `dialog_append(name, lines)`，O(1) 追加写）。
- **append 时机即消息刚完成的时刻，消息必然未被压缩** —— 从时序上根绝"截断态入盘"，3.1 的合并保护降级为纵深防御。
- `session_end` 保留一次规整覆写（更新 meta 行 messageCount/updatedAt、清理重复 seq），沿用现有原子写（tmp + rename）。
- 首条消息落盘即建文件：**会话从第一句话起就出现在历史里**，不再要求"完整聊完一轮"（P4 的"会话不见了"由此顺带解决一半）。

效果：崩溃丢失窗口从"整轮"缩小到"正在流式中的半条消息"。

### 3.3 Web 端统一走后端存储（P2 根治）

后端 HTTP API 已暴露全部 dialog 命令（`src-tauri/src/web/api/ipc.rs:316-320`），只差前端选型：

- `getDialogBackend()`（`dialogBackend.ts:242`）改为：transport 可达（Tauri IPC **或** HTTP）→ `TauriBackend`（更名 `RemoteBackend`）；仅后端完全不可达时降级 OPFS 并在 UI 明示"离线本地模式"。
- **一次性迁移**：启动时若 OPFS 存有会话且后端可达，逐个上传（同 id 冲突取 updatedAt 新者），完成后写迁移标记。
- 效果：桌面、任意浏览器、移动端看到同一份历史。

### 3.4 保存状态可见

聊天区顶部/会话卡片增加轻量保存指示（已保存 ✓ / 保存中 / 本地离线），建立"数据不会丢"的信任感。仅订阅 append 结果，无轮询。

**Phase 0 验收**：长会话滚动后继续对话，重开会话内容零截断；流式中途杀进程，重启后仅丢当前半条；Chrome 存的会话 Edge 可见；OPFS 存量自动上行。

---

## 4. Phase 1 — SQLite 索引与统一时间线

### 4.1 索引层：`dialogs/index.db`

依赖已就绪（`rusqlite 0.32 bundled`，LSP 索引已在用）。

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,          -- externalId / native sessionId
  source        TEXT NOT NULL,             -- 'self' | 'claude-native' | 'codex-native'
  engine_id     TEXT NOT NULL,
  title         TEXT NOT NULL,
  workspace_path TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  file_size     INTEGER,
  preview       TEXT,                      -- 最后一条消息摘要（续聊场景比首条更有用）
  first_user_text TEXT,
  git_branch    TEXT,
  linked_pr     TEXT,                      -- JSON
  -- 用户标注（self 与 native 会话统一在此，引擎原生文件永不改写）
  starred       INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  archived      INTEGER NOT NULL DEFAULT 0,
  color         TEXT,
  user_tags     TEXT,                      -- JSON array
  note          TEXT,
  -- native 缓存失效键
  src_mtime     INTEGER,
  src_size      INTEGER
);
CREATE INDEX idx_sessions_updated ON sessions(archived, updated_at DESC);
CREATE VIRTUAL TABLE sessions_fts USING fts5(id UNINDEXED, title, content);
```

- **写**：`dialog_append` / `dialog_write` / `dialog_delete` 内同步 upsert/删除索引行；FTS content 按消息文本增量插入。
- **native 扫描**：后台任务扫 Claude/Codex 目录，`(mtime,size)` 变化才重新解析（现 `parse_session_metadata_light` 每次全解析所有分页文件的问题就此消除）；解析结果含消息文本时顺带喂 FTS。
- **自愈**：`schema_version` 不符或文件损坏 → 删库后台重建（扫 JSONL 目录 + native 目录）。索引永远可牺牲。
- **命令面**：新增 `history_query(filter, sort, page)`、`history_search(q, page)`、`history_mark(id, marks)` 三个命令（Tauri + HTTP 双注册，注意 `#[cfg(feature="tauri-app")]` 门控惯例），前端 `historyService` 收敛到这三个入口。

### 4.2 统一时间线（信息架构重构）

- 撤掉「自有存储 / 引擎历史」双 Tab。同一 sessionId 的自有记录与引擎原生记录**合并为一条**（自有为主，原生补充 fileSize/git/fork 字段），来源仅作为详情里的小徽标。
- 默认视图 = 当前工作区 + 未归档，按 updated_at 降序；「全部工作区」一键切换。
- MiMo / Simple AI 会话天然在列（它们只有自有存储，此前在"引擎历史"Tab 下永远为空的问题随 Tab 一起消失）。

### 4.3 全文搜索

- 搜索框升级：标题 + 全部消息内容（FTS5），返回命中片段并高亮；键入防抖 200ms，后端 `history_search`。
- 这是"找回那次对话"的最大体验杠杆——现状只搜标题和首条消息。

**Phase 1 验收**：500+ 会话下列表首屏 < 100ms；搜索任意历史消息正文 < 300ms 返回；同一会话不再在两个 Tab 重复出现。

---

## 5. Phase 2 — 打开提速（恢复路径）

1. **尾部优先加载**：新增 `dialog_read_page(name, before_seq, limit)`（Rust 倒序扫描行）。恢复会话时只取最近 N 条（默认 50，可配置）进 `messages`，更早消息句柄化。
2. **接通归档空壳**：现有 `archivedMessages` + `loadMoreArchivedMessages`（`createConversationStore.ts:1467`）从未有写入方——改为"向上滚动 → 从磁盘分页补读 → prepend"，正好复用这套接口与 UI。
3. **解析下移**：大文件 `parseDialog` 移入 Web Worker（复用 DiffViewer 的 Worker 模式），主线程不再被几 MB JSON.parse 卡住；Rust 直连场景由 `dialog_read_page` 天然规避。
4. **预览同构**：`SessionPreviewModal` 改用同一分页接口，预览大会话不再整读。

**Phase 2 验收**：1 万条消息的会话，点击恢复到可交互 < 1s；向上滚动补页无感（< 200ms/页）。

---

## 6. Phase 3 — 续聊工作台（UX 功能层）

### 6.1 "继续工作"区

历史面板（及新会话空态页）顶部固定两组卡片：

- **置顶**（pinned）：用户手动钉住的工作线。
- **最近活跃**：近 3~5 条，卡片展示标题、**最后一条消息摘要**（preview 列）、工作区、引擎、相对时间；主按钮即「继续」。

点「继续」= 现有 restore 流程 + 自动定位输入框。目标：从打开面板到接着打字 ≤ 2 次点击。

### 6.2 标注与筛选

- 标注：星标、置顶、颜色点、自定义标签、备注——列表项悬浮/右键即改，写 `history_mark`，对 self 与 native 会话一视同仁（全存 index.db，不碰引擎文件）。
- 筛选栏（组合式）：工作区 ▸ 引擎 ▸ 星标/标签 ▸ 时间段；自动维度（git 分支、有无 PR、工具使用 tags）作为二级筛选。
- 归档：`archived=1` 默认隐藏，替代"舍不得删但碍眼"的删除焦虑。

### 6.3 体验配置（Settings › 通用/数据存储）

| 配置 | 默认 | 说明 |
|---|---|---|
| 历史列表分页大小 | 20 | `history_query` page size |
| 会话首屏消息数 | 50 | `dialog_read_page` limit（即原"一级 50 条"诉求的落点） |
| 最近活跃卡片数 | 5 | 继续工作区 |
| 自动归档阈值 | 关 | 可选：N 天未活跃自动归档 |

### 6.4 标题质量（可选增强）

现状标题 = 首条用户消息前 50 字。增强：轮末用当前引擎低成本生成 12 字内摘要标题（失败静默回退），显著提升列表可扫读性。作为开关项，默认开。

---

## 7. Phase 4 — 生命周期与打磨

- 存储占用可视化 + 批量清理（按时间/大小/引擎，`DataStorageCard` 扩展）。
- 会话导出（单会话 JSONL/Markdown）与导入。
- Fork 树视图与 PR 关联维持现有能力，数据源切到 index.db。

---

## 8. 风险与兼容

| 风险 | 缓解 |
|---|---|
| append 与规整覆写并发 | 每会话单 writer（store 即会话粒度）；Rust 端按文件名加互斥锁 |
| index.db 与 JSONL 漂移 | JSONL 为事实源，索引可整库重建；启动时轻量一致性抽查（行数/updatedAt 抽样） |
| JSONL 格式演进 | meta 行 `v: 2`（新增 preview 等），parse 向后兼容 v1，无需数据迁移 |
| OPFS 迁移冲突 | 同 id 取 updatedAt 新者；迁移完成打标记，OPFS 数据保留 30 天后清 |
| web-only 编译门控 | 新增 Rust 命令遵循 `#[cfg(feature="tauri-app")]` + inner 函数复用惯例（HTTP dispatch 调 inner） |
| 双 EngineId 同步 | 不新增引擎，无此风险；source 字段独立于 EngineId |

## 9. 实施顺序与工作量估计

| 阶段 | 内容 | 规模 | 依赖 |
|---|---|---|---|
| **Phase 0** | 止损：合并保护、append 落盘、Web 走后端、迁移、保存指示 | 中 | 无 |
| **Phase 1** | index.db、统一时间线、全文搜索 | 大 | Phase 0.3 |
| **Phase 2** | 尾部分页、归档接通、Worker 解析 | 中 | Phase 1 命令面 |
| **Phase 3** | 继续工作区、标注筛选、配置项 | 中 | Phase 1 |
| **Phase 4** | 清理/导出/打磨 | 小 | 随时 |

Phase 0 独立可发布，建议先行合入。

---

## 附录 A：根因定位速查

| 现象 | 根因锚点 |
|---|---|
| 截断污染 | `messageCompactor.ts` MAX_SNAPSHOTS=20 → `conversationStoreUtils.ts:166` 兜底读死 key（`historyService.saveToHistory` 无调用方）→ `eventHandler.ts:92 saveDialog` 全量覆写 |
| 只在轮末保存 | `eventHandler.ts` 仅 `session_end` 触发 `saveDialog` |
| 跨浏览器不通 | `dialogBackend.ts:242` 非 Tauri 即 OPFS；HTTP API 已就绪未被使用（`web/api/ipc.rs:316`） |
| 引擎历史列表慢 | `history_claude.rs:164 parse_session_metadata_light` 逐行全解析当前页每个文件，无缓存 |
| 恢复慢 | `service.ts getConversation` 整读 + `parseDialog` 主线程全量 parse + `setMessagesFromHistory` 全量入 store |
| 归档机制空壳 | `archivedMessages` 无任何非空写入方；`loadMoreArchivedMessages` 不可达 |
| 引擎历史 Tab 下 MiMo/SimpleAI 恒空 | `listNativeHistory` 无这两个引擎的数据源 |
