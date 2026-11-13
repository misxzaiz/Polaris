# 会话历史插件化 PRD（history-desk）

> 状态：**PRD v0.1（待评审）**
> 日期：2026-11-12
> 目标：把「AI 会话历史」面板改为插件实现，**位置还在那里**（右侧抽屉入口、触发方式、数据能力不变），实现外移至 `Polaris-plugin` 仓。
> 上游关联：`plans/core-slimdown-plugin-extraction-plan.md`（L1/L2/L3 分级与四问判定）、`plans/terminal-plugin-spec.md`（共存→接管→拆除方法论先例）、`plans/plugin-cap-full-freedom-v1.md`（覆盖链，本方案 v1 不依赖）、`plans/session-rearchitecture/S7-消息存储统一重构.md`（存储真相，本方案不触碰）、`plugins/docs/host-slimdown-plugin-contracts-plan.md`（cap.session 远期契约）。
> 行数口径：2026-11-12 `wc -l` 工作区实测。

---

## 0. TL;DR

会话历史 = **存储层（宿主本体）+ 查询编排层（半宿主半命令层）+ UI 层（纯前端，~3.0k 行）**。按四问判定：存储与消息真相是宿主本体不拆；查询层目前以裸 Tauri 命令暴露（`history_query/search/mark`、`dialog_read_page` 等），**不在插件可达通道上**——先 cap 化再拆；UI 层（SessionHistoryPanel 及其子组件 + historyService 编排）整体外移为 `history-desk` 插件，以 **overlay shadow 插槽**接管 `App.tsx` 右侧滑出抽屉，禁用/卸载即回退内置面板（天然回滚，terminal-desk/git 同款）。

本方案需要四项**宿主地基（P0，均为通用能力）**：
1. `cap.history` v2 动作扩容（query / search / mark / archive_page / delete 扩展 / list_running）——查询面上总线；
2. 新贡献点 `contributes.overlays[]`（具名覆盖式浮层插槽，首个插槽 `session-history`）；
3. `__POLARIS_HOST_LISTEN__` 透传 session 生命周期事件（session_start/session_end）；
4. `__POLARIS_SESSION_API__` 会话桥（restore / fork，复用既有 historyService 恢复链，v2-kernel 依赖不变）。

存储层（dialogs JSONL、session-v2 messages.db、dialogs/index.db、turn_persist、session_state）**零改动**；conversationStore / session-v2 核心冻结纪律不受影响。

---

## 1. 背景与目标

### 1.1 为什么拆

- 「插件优先」既定治理方向（AGENTS.md §五，2026-10-30 定案）：存量功能按 `core-slimdown` 批次外移；会话历史面板是下一块体量适中、边界清晰的功能域。
- **发布解耦**：历史面板迭代（筛选/视图/预览体验）当前绑定主程序发版；外移后走插件 `update.json` 热更新。
- **机制红利**：本方案落地的 `contributes.overlays` 是通用「浮层插槽」机制，下一个可直接复用的对象是 NotificationCenterPanel（同款 RightSlideOver 挂载）。
- **先例充分**：terminal-desk（PTY 留宿主、UI 插件化 + shadow 接管）、polaris-git（整域出仓 + shadow 席位 + 占位兜底）已验证全链路。

### 1.2 「位置还在那里」的精确含义

| 不变量 | 现状实现 | 拆后 |
|---|---|---|
| 入口 | QuickSwitchPanel「历史会话」按钮 → `viewStore.toggleSessionHistory()` | **不变**（宿主保留） |
| 位置/形态 | `App.tsx:446-454` `RightSlideOver` 右侧滑出抽屉（kept/exiting 退场动画） | **不变**（宿主保留外壳，仅内容可被插件接管） |
| 打开状态 | `viewStore.showSessionHistory` | **不变** |
| 数据能力 | 历史查询/搜索/标注/删除/恢复 | **不变**（改经 cap 通道，语义逐项等价） |
| 变化 | 面板内容 = 内置 SessionHistoryPanel | 面板内容 = 已启用 history-desk 插件面板；未启用/禁用/卸载 → 内置面板原样回来 |

### 1.3 目标与非目标

**目标**
1. history-desk 插件实现与内置面板**功能等价**（对照清单见 §6-P1）；
2. 主仓净删前端 ~2.5–2.8k 行（面板域 UI + 编排服务）；
3. 查询面全部收拢到 `cap.history`（AI / 插件 / 远程同一通道 + 统一审计）；
4. 全程可回滚：插件禁用即内置恢复，数据层零迁移。

**非目标（明确不做）**
- 不动存储层与消息真相（S7 单一权威链路原样保留）；
- 不拆 conversationStore / session-v2 / turn_persist（宿主本体，核心冻结）；
- 不做 cap.history 的插件**覆盖注册**（v1 插件是消费者不是替换者；覆盖留待远期按 L2 白名单另评）;
- 不改 Chat / ChatInput / 会话发起链路。

---

## 2. 现状解剖（P1 产出落定）

### 2.1 分层清单与判定

| 层 | 模块 | 行数 | 判定 | 依据 |
|---|---|---|---|---|
| 存储 | `commands/dialog_storage.rs`（JSONL 读写/合并/分页/删除 + 索引挂钩） | ~700 | **留宿主** | 数据真相 + 单写路径 |
| 存储 | `services/session_db.rs`（messages.db，S7 权威） | ~800 | **留宿主** | 同上 |
| 存储 | `services/dialog_index.rs`（index.db：统一时间线 + FTS5 + 标注 + native 扫描） | ~1350 | **留宿主** | 派生索引，可重建，宿主写路径挂钩 |
| 存储 | `services/turn_persist.rs` / `services/session_state.rs` | — | **留宿主** | 消息真相/事件日志 |
| 契约 | `services/router/history_capability.rs`（cap.history 5 动作） | 197 | **留宿主并扩容** | 插件化的能力通道 |
| 契约 | `services/ai_history_core.rs` + `ai/history_claude.rs` + `ai/history_plugin.rs` | ~1600 | **留宿主** | cap.history 的业务核 |
| 查询编排 | `src/services/historyService.ts` | 727 | **外移**（恢复核心留宿主 ~150 行） | 纯编排，无宿主内部依赖（v2-kernel 仅依赖 restoreFromHistory 一个方法） |
| 查询编排 | `src/services/claudeCodeHistoryService.ts` | 199 | **外移** | cap.history 薄客户端 |
| 查询编排 | `src/services/sessionArchive.ts` | 45 | **外移** | message_read 薄封装 |
| UI | `components/Chat/session/SessionHistoryPanel.tsx` | 1088 | **外移** | 面板本体 |
| UI | `SessionPreviewModal.tsx` / `SessionTree.tsx` / `ForkSessionDialog.tsx` / `ForkIndicator.tsx` / `RemoteSessionsPanel.tsx` | ~900 | **外移** | 面板子组件 |
| 状态 | `stores/historyPrefsStore.ts` | 65 | **外移** | 仅面板消费（listPageSize/restorePageSize/recentCards） |
| 挂载 | `App.tsx` RightSlideOver 段 + `viewStore.showSessionHistory` + QuickSwitchPanel 入口 | — | **留宿主** | 「位置」本体 |
| 关联 | `services/remoteSessionFollower.ts` | ~650 | **部分保留** | ChatNavigator「加入会话」仍在宿主（remote-session-join-v2）；插件面板内置自己的轻量发现（见 §4.4） |

外移合计 ≈ **3.0k 行前端**；宿主净删 ≈ 2.5–2.8k（扣除保留的恢复核心与挂载壳）。

### 2.2 数据链路（拆后不变）

```
写：AI 事件 → turn_persist（messages.db 权威）→ 轮末 archive_conversation 兜底 JSONL
                                            ↘ 前端轮末 saveConversation（富块完整版 JSONL）
   dialog_write/append/delete → dialog_index on_self_* 增量维护 index.db
读：SessionHistoryPanel → historyService ─┬─ history_query/search/mark（index.db）
                                          ├─ dialogStorage.getConversationPage（JSONL 尾部分页）
                                          ├─ message_read（messages.db 兜底合并）
                                          └─ cap.history（claude/plugin 引擎原生）
删：self → 中断运行中会话 → 删 JSONL + messages.db（写会话墓碑）+ 索引清理
    native → cap.history delete_session → 引擎文件
恢复：loadMessagesForItem → createSessionFromHistory → kernel.resyncSession → 入多窗口
```

### 2.3 四问判定（core-slimdown §3）

| 问 | 结论 |
|---|---|
| Q1 宿主性 | 存储与消息真相 = 宿主本体；**历史面板 UI 与查询编排不是宿主本体**（cap/命令的消费者） |
| Q2 边界性 | 面板自包含度高（抽屉形态、独立子组件树）；纠缠点仅恢复（sessionStoreManager）与远端跟随（follower） |
| Q3 通道性 | **当前不满足**：index 查询/标注、JSONL 分页、删除编排都是裸命令，插件面板不可达 → **先 cap 化再拆**（AGENTS.md §3.2 纪律） |
| Q4 收益 | ~3.0k 行、中等热度；叠加 overlay 通用机制收益 → **值得拆** |

**结论：拆（L1 前端外移），后端存储与 cap 留守。**

---

## 3. 方案形态

### 3.1 拆出（→ history-desk 插件）

SessionHistoryPanel + SessionTree + ForkIndicator + ForkSessionDialog + SessionPreviewModal + RemoteSessionsPanel（UI）；historyService + claudeCodeHistoryService + sessionArchive（编排）；historyPrefsStore（偏好）。插件自带轻量 i18n 与主题 token 消费（对齐 polaris-git 样式纪律：只用宿主 `--c-*` 变量，附 token 静态检查）。

### 3.2 宿主保留

- 右侧抽屉壳：`RightSlideOver` + `viewStore.showSessionHistory/toggleSessionHistory` + QuickSwitchPanel 入口；
- 恢复核心：从 historyService 抽出 `sessionRestore.ts`（loadMessagesForItem → ensureWorkspace → createSessionFromHistory → kernel.resyncSession，~150 行）——**v2-kernel.ts:359 的 RecoveryCapability 依赖它**，同时供 `__POLARIS_SESSION_API__` 桥使用；
- `remoteSessionFollower`：ChatNavigator「加入会话」入口仍依赖，保留宿主（插件面板内置轻量发现，见 §4.4）；
- 存储 + cap.history（扩容后）。

### 3.3 插件面板渲染器说明（诚实边界）

SessionPreviewModal 复用宿主 `renderChatMessage → AssistantBubble → renderContentBlock` 链，插件**无法 import 宿主组件**（自包含约束）。v1 插件内置精简消息渲染器（文本 / thinking / 工具调用摘要，参照 time-sift 阅读器先例）；完整块渲染保真（表单卡/插件卡/权限卡等）列为 P3 迭代项。这是本方案最主要的体验让步，评审时需确认可接受。

---

## 4. 契约设计（P0 宿主地基，全部为通用能力）

### 4.1 `cap.history` v2 动作扩容

现有 5 动作（list_sessions / get_session_history / delete_session / list_claude_sessions / get_claude_history）**保持不变**，新增/扩展（均过统一权限 gate + 审计，`standard_describe` 自描述）：

| action | 入参 | 出参 | 包装的既有实现 |
|---|---|---|---|
| `query` | `HistoryQueryParams`（camelCase 原样：workspacePath/engines/starred/pinned/archived/source/forceScan/strictWorkspace/page/pageSize） | `HistoryQueryResult`（items/total/page/pageSize） | `dialog_index::history_query_inner` |
| `search` | `{ query, workspacePath?, limit?, strictWorkspace? }` | `HistorySessionRow[]`（含 snippet） | `dialog_index::history_search_inner` |
| `mark` | `{ id, marks{starred?,pinned?,archived?,color?,userTags?,note?} }` | `{ ok: true }`（会话不在索引 → 显式报错） | `dialog_index::history_mark_inner` |
| `archive_page` | `{ sessionId, beforeSeq?, limit }` | `{ meta, messages, earliestSeq, total, hasMore }`（**宿主侧解析 + id/内容指纹去重**，去重契约不出宿主） | `dialog_read_page_inner` + 既有行级解析 helper |
| `delete_session`（扩展） | `{ sessionId, source?, engineId? }`；source ∈ self/claude-code-native/plugin-native，缺省自推断（索引 source → 引擎目录存在性） | `{ ok: true }` | **self**：运行中先 best-effort interrupt → `dialog_delete_inner` → `message_delete_by_conversation_inner`（会话墓碑，阻断复活链）→ 索引随 on_self_delete 清理；**native**：既有 provider 删除（语义不变） |
| `list_running` | `{}` | `{ running: [{ conversationId, startedAt?, startedByDevice? }] }` | `session_state` running_conversation_ids + compute_status |

设计约束：
- 删除编排收进 cap 后，**墓碑链唯一写者仍是 session_db**，前端不再直调 `message_delete_by_conversation`（P4 起该命令对插件不可达也无必要）；
- `query/search/mark` 使 AI（cap_dispatch）与远程端（Web/移动，cap.history 无 Remote deny 规则，token 鉴权）与插件面板三方同通道；
- 旧 Tauri 命令 `history_query/history_search/history_mark/dialog_read_page` 过渡期保留（P4 再按「迁一个砍一个」清理）。

### 4.2 新贡献点 `contributes.overlays[]`（具名浮层插槽）

Rust（`models/plugin.rs`，deny_unknown_fields 同族）：

```rust
pub struct PluginOverlayContribution {
    pub id: String,            // 插件内唯一
    pub slot: String,          // 宿主具名插槽，白名单校验：v1 = ["session-history"]
    pub panel_type: String,    // 指向本插件 panel（loader 注册见下）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,  // v1 仅 shadow（缺省 shadow；其他值安装期报错）
}
```

前端（types + schema 单源 + pluginDiscoveryService normalize + registry）：

```ts
export const VALID_OVERLAY_SLOTS = ['session-history'] as const
export interface PluginOverlayContribution { id: string; slot: string; panelType: string; mode?: 'shadow' }
// registry:
getOverlayClaim(slot: string): { pluginId: string; panelType: string } | undefined
// 语义 = 已启用插件中声明了该 slot 且 mode=shadow 的首个贡献（order 升序）；
// 未启用/卸载 → undefined → 宿主兜底渲染内置面板（天然回滚，无需占位组件）
```

- `registry.registerPanel` 增加一段：遍历 `contributes.overlays` 为 `panelType` 注册 loader（与 views 同源 `createPanelLoader`）——否则无 views 的纯 overlay 插件没有面板入口；
- `validate_manifest_fields`（Rust）与前端 normalize 双侧校验：slot 不在白名单 / mode 非法 → 安装期显式报错（fail fast，防「面板静默消失」类事故）；
- App.tsx 挂载点替换（唯一 UI 接线改动）：

```tsx
const historyOverlay = pluginRegistry.getOverlayClaim('session-history')
// （并经 isPluginUiEnabled(pluginStates, historyOverlay.pluginId) 复核）
{(showSessionHistory || sessionHistoryKept) && (
  <RightSlideOver open={...} exiting={...} onExited={sessionHistoryExited}>
    <Suspense fallback={loadingFallback}>
      {historyOverlay
        ? <PluginPanelHost panelType={historyOverlay.panelType} />
        : <SessionHistoryPanelLazy onClose={closeSessionHistory} />}
    </Suspense>
  </RightSlideOver>
)}
```

### 4.3 会话桥 `__POLARIS_SESSION_API__`（main.tsx 挂载，同 WORKSPACE/THEME API 先例）

```ts
interface PolarisSessionApi {
  /** 恢复历史会话到本端窗口（等价现 restoreFromHistory 全链路，含 resync 对账与入多窗口） */
  restore(conversationId: string, opts?: {
    engineId?: string; projectPath?: string; claudeProjectName?: string; title?: string
  }): Promise<boolean>
  /** 从历史会话创建分支（等价现 handleFork），返回新 sessionId；失败 null */
  fork(conversationId: string, branchName?: string): Promise<string | null>
}
```

- 实现委托宿主保留的 `sessionRestore.ts`（restore）与从 SessionHistoryPanel.handleFork 抽出的 `forkSession`（先落 sessionRestore.ts）；
- 只暴露这两个动作，不暴露 store 句柄（最小面）；conversationId 须经 `archive_page`/`query` 证实存在才执行（防误触）。

### 4.4 生命周期事件透传 + 插件侧远端发现

- `__POLARIS_HOST_LISTEN__('chat-event')` 现仅透传 `mc-` 前缀信封 → **追加透传** `payload.type ∈ {session_start, session_end}` 的普通会话信封（低敏元数据：sessionId/engineId/reason；~6 行改动）。插件面板据此做 800ms 防抖自动刷新（与内置面板同语义），并维护「其他设备进行中」增量集合；
- 冷启动 running 集合：插件调 `cap.history list_running`（替代 follower 的 `session_event_read_after_seq` 全量扫描）；单条回补走 `message_read`（已在 hostInvoke 白名单）。
- 宿主 `remoteSessionFollower` 不动（ChatNavigator 加入入口继续用）；插件内的轻量实现与其并存一个版本周期，P4 后评估收敛（已知债务，如实登记）。

### 4.5 权限与安全

| 面 | 分析 | 处置 |
|---|---|---|
| 插件面板 Source | 面板 blob 加载进主窗口（label=main）→ router_dispatch 判定 **Bootstrap**，权限全放行 | 既有「同 window 零隔离」已知面；本插件为一方插件，且全部调用走 cap 通道留审计；hostInvoke 白名单继续封侧门（dialog_* 等裸命令仍不可达） |
| Web/移动端 | 面板同样运行，invoke 走 HTTP → Source::Remote | cap.history 无 Remote deny → token 鉴权后可用（与现状远程查历史一致） |
| 删除编排入 cap | 删除是不可逆数据面 | 动作进审计链（dispatch.ok 含 action=delete_session）；墓碑语义不变；前端确认框（UX-4）在插件内保留 |
| 覆盖注册 | 本方案不覆盖 cap.history | 若远期插件要替换查询逻辑，走 `replace:true` + L2 白名单（config.capOverride.allow）另评 |
| `__POLARIS_SESSION_API__` | 可触发会话恢复/Fork | 仅暴露 restore/fork 两个动作；内部复用既有恢复链，无新增权限面 |

---

## 5. 插件原型（history-desk v0.1）

### 5.1 manifest 原型

```jsonc
{
  "id": "history-desk",
  "name": "会话历史",
  "version": "0.1.0",
  "description": "会话历史面板：统一时间线（继续工作卡片 + 列表）、组合筛选、全文搜索（FTS 命中片段）、Fork 树、只读预览、继续/Fork/删除（确认 + 墓碑）、星标/置顶/归档标注、跨端进行中会话条。数据经 cap.history v2（query/search/mark/archive_page/delete/list_running）+ 会话桥 restore/fork；存储仍在宿主数据根，插件零写入。",
  "enabledByDefault": false,          // P1 共存期默认关闭；P2 接管时改 true
  "contributes": {
    "panel": { "entry": "./dist/panel.js", "supportsFullscreen": false },
    "overlays": [
      { "id": "history-desk.drawer", "slot": "session-history", "panelType": "history-desk", "mode": "shadow" }
    ],
    "styles": [
      { "id": "panel", "target": "slot", "slotId": "session-history", "css": "/* hd- 前缀；仅用宿主 --c-* token */" }
    ]
  },
  "permissions": { "appConfigRead": true },
  "origin": { "repository": "https://github.com/misxzaiz/Polaris-plugin", "updateUrl": ".../history-desk/update.json", "downloadUrl": ".../history-desk/history-desk.zip" }
}
```

> 注：无 `views`（不占活动栏 tab，纯抽屉接管）；panelType loader 由 `registerPanel` 对 overlays 的扩展注册。`styles.target:'slot'` 的作用域前缀机制沿用（`data-plugin-scope`），slotId 语义与既有字段对齐。

### 5.2 目录结构

```
plugins/history-desk/
├── plugin.json
├── package.json            # esbuild → dist/panel.js（react external，宿主 shim）
├── src/
│   ├── index.tsx           # default export Panel
│   ├── Panel.tsx           # 头部（刷新/关闭）+ 筛选行 + 搜索框 + 列表 + 继续工作区
│   ├── HistoryList.tsx     # 分页列表 + 行操作（星/置顶/归档/Fork/继续/删除）
│   ├── SessionTree.tsx     # Fork 树视图
│   ├── PreviewModal.tsx    # 只读预览（自研精简消息渲染器 + 尾部分页补读）
│   ├── ForkDialog.tsx / ConfirmDialog.tsx
│   ├── RemoteStrip.tsx     # 其他设备进行中（list_running + 生命周期事件增量）
│   ├── data.ts             # cap.history v2 客户端（query/search/mark/archive_page/delete/list_running）
│   ├── sessionBridge.ts    # __POLARIS_SESSION_API__ 封装（restore/fork）
│   ├── messageRender.tsx   # 精简消息渲染（text/thinking/tool 摘要）
│   ├── prefs.ts            # listPageSize/restorePageSize/recentCards（plugin config 承载）
│   └── i18n.ts / theme.ts  # 自带双语；--c-* token 取色
├── test/                   # node 冒烟：cap 动作契约 + 渲染快照
└── dist/panel.js
```

### 5.3 面板信息架构（线框）

```
┌──────────────────────────────────────────────┐
│ 会话历史                              [⟳][✕] │  ← 头部：手动刷新（forceScan）/关闭
├──────────────────────────────────────────────┤
│ [当前项目][全部] [引擎▾] [★] [归档]   [列表|树] │  ← 组合筛选 + 视图切换
├──────────────────────────────────────────────┤
│ 🔍 搜索标题与对话内容…                         │  ← FTS（250ms 防抖，命中片段高亮）
├──────────────────────────────────────────────┤
│ 〔其他设备进行中：● session-xxxx · 3 分钟前〕  │  ← RemoteStrip（list_running + 事件增量）
│ 继续工作                                      │
│ ┌────────┐┌────────┐┌────────┐               │  ← 置顶 + 最近 N 卡（prefs.recentCards）
│ │ 标题    ││ …      ││ …     │  [▶ 继续]      │
│ └────────┘└────────┘└────────┘               │
│ ★ 置顶会话行 …                                │
│ 今天                                          │
│  · [★][📌] 标题 [引擎徽标] 12 条 · 10:24 [继续]│  ← 行：星标/置顶/归档/Fork/继续/删除
│  · …                                          │  ← 触底加载下一页（query page+1）
│ 昨天 …                                        │
└──────────────────────────────────────────────┘
  行点击 → PreviewModal（只读，围绕完整消息流，向上补读 archive_page）
  删除 → ConfirmDialog（不可逆提示）→ cap.history delete_session（self 编排含中断+墓碑）
  继续 → __POLARIS_SESSION_API__.restore(id, opts) → 关闭抽屉
  Fork → ForkDialog（分支名）→ sessionBridge.fork(id, branchName)
```

### 5.4 数据访问映射（移植即改写）

| 现内部调用 | 插件改写为 |
|---|---|
| `invoke('history_query', { params })` | `cap('query', params)` |
| `invoke('history_search', …)` | `cap('search', …)` |
| `invoke('history_mark', …)` | `cap('mark', …)` |
| `dialogStorageService.getConversationPage(...)` | `cap('archive_page', { sessionId, beforeSeq, limit })` |
| `loadBackendMessages`（message_read） | `__POLARIS_HOST_INVOKE__('message_read', …)`（白名单内） |
| `aiHistoryDispatch({action:'list_sessions'|'get_session_history'|'get_claude_history'|'list_claude_sessions'})` | `cap('list_sessions' | 'get_session_history' | 'get_claude_history' | 'list_claude_sessions', …)`（动作不变） |
| `historyService.deleteHistorySession` | `cap('delete_session', { sessionId, source, engineId })` |
| `historyService.restoreFromHistory` | `__POLARIS_SESSION_API__.restore(...)` |
| `handleFork` | `__POLARIS_SESSION_API__.fork(...)` |
| chat-event 刷新监听 | `__POLARIS_HOST_LISTEN__('chat-event')`（透传后的 session_start/end）+ `list_running` 冷启动 |

---

## 6. 分阶段路线与验收

### P0 宿主地基（预计 1–2 天，纯增量，零行为变化）

- [ ] `cap.history` v2：新增 query/search/mark/archive_page/list_running + delete_session 扩展（Rust，history_capability.rs + 必要的 inner 复用）；describe 契约测试同步
- [ ] `contributes.overlays`：Rust 模型 + 校验；前端 types/schema/normalize/registry（getOverlayClaim + registerPanel 扩展）；App.tsx session-history 插槽消费
- [ ] `__POLARIS_SESSION_API__` 桥 + `sessionRestore.ts` 抽取（historyService.restoreFromHistory 与 handleFork 的宿主侧落点；v2-kernel 依赖改指 sessionRestore）
- [ ] `__POLARIS_HOST_LISTEN__` chat-event 透传 session_start/session_end
- [ ] 验收：`cargo check` + `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` + `pnpm exec tsc --noEmit` + `pnpm lint` + 相关 vitest（registry overlay 用例、cap describe 契约）全绿；**无插件安装时 UI/行为逐像素不变**

### P1 插件共存（插件仓 v0.1，enabledByDefault=false）

- [ ] 面板全功能实现（§5.3 信息架构），数据全走 §5.4 映射
- [ ] 双端验证：桌面（tauri dev）+ Web（tauri:dev:web 9827，Remote 源）
- [ ] 功能对照清单逐项通过：统一时间线 / 继续工作卡 / 工作区+引擎+星标+归档筛选 / 全文搜索与命中片段 / 树视图（Fork 关系）/ 只读预览（含向上补读）/ 继续 / Fork / 删除（确认框 + 运行中会话中断 + 删除后不复活）/ 标注 / 手动刷新 / chat-event 自动刷新 / 远端进行中条 / 偏好（页大小、卡片数）
- [ ] 回滚演练：禁用插件 → 内置面板即时恢复；重新启用 → 插件面板恢复

### P2 接管

- [ ] 对照清单全绿 + 无 P0/P1 级缺陷 → 插件 `enabledByDefault: true`（或按用户裁决翻默认）
- [ ] 内置面板代码保留为兜底（不删）
- [ ] 验收：删除链路墓碑专项（流式中删除 → 晚到 Token/SessionEnd 不复活）；大批量历史（千级会话）查询性能不劣化（index.db 路径未变）

### P3 插件独立迭代（update.json 热更）

- [ ] 消息渲染保真提升（更多块类型）、保存的筛选视图、AI 会话摘要（插件自带 MCP，参照 time-sift 模式）等
- [ ] 每次发版走插件仓 publish 流程（sha256 / 版本对齐）

### P4 主仓拆除

- [ ] 删除：`SessionHistoryPanel.tsx`、`SessionTree.tsx`、`ForkIndicator.tsx`、`ForkSessionDialog.tsx`、`SessionPreviewModal.tsx`、`RemoteSessionsPanel.tsx`、`historyService.ts`、`claudeCodeHistoryService.ts`、`sessionArchive.ts`、`historyPrefsStore.ts`、App.tsx 相关 lazy 引用
- [ ] 保留：`sessionRestore.ts`（v2-kernel + 桥）、`remoteSessionFollower.ts`（ChatNavigator）、RightSlideOver 壳、viewStore 字段、后端全部
- [ ] 拆前 grep 复核 `historyService|SessionHistoryPanel|historyPrefsStore` 全部消费方（含测试），逐个迁移或确认随删
- [ ] 验收：主仓 grep 仅剩 overlay 插槽与桥链路；`pnpm typecheck` + `pnpm test:run` + `cargo check`（两向）全绿；历史面板相关 chunk 从主包消失

---

## 7. 风险与回滚

| 风险 | 对策 |
|---|---|
| 插件面板消息渲染保真不足（自研渲染器） | v1 明示边界（文本/思考/工具摘要）；P3 迭代补齐；预览入口保留「继续会话」逃生门（进宿主完整渲染） |
| 删除编排从客户端移到 cap，语义漂移 | 编排逻辑逐条对齐现 historyService.deleteHistorySession（中断→600ms 等待→JSONL→messages.db 墓碑→索引）；P1 对照清单含「删除后不复活」用例 |
| restore/fork 桥被滥用 | 仅两个动作、conversationId 须证实存在；内部复用既有链路，无新权限面 |
| follower 双实现（宿主 ChatNavigator vs 插件轻量发现）短期并存 | 已知债务，登记于 P4；一个版本周期后评估收敛 |
| Bootstrap 面板权限面大（既有零隔离问题） | 不新增裸命令白名单；一切经 cap（审计同源）；hostInvoke 侧门不变 |
| 接管后体验回退引发不满 | P1 默认关闭共存试跑；P2 才翻默认；禁用即回内置（秒级回滚） |
| 本机 `cargo test --lib` 不可用 | cap 新动作逻辑尽量薄包装既有 inner；测试以 `cargo check` 两向 + describe 契约测试 + 前端 vitest + 手测记录代替，如实标注 |

---

## 8. 与既有 spec 的关系

- **方法论**：复用 terminal-plugin-spec 的「共存→接管→优化→拆除」四阶段与 core-slimdown 的 L1/L2/L3 分级；本功能判定为 L1（前端外移）。
- **不冲突**：S7 消息存储统一（存储真相不动）；plugin-cap-full-freedom-v1（本方案不使用覆盖注册，仅消费 cap）；plugin-based-ai-chat-analysis（那是「新版对话 UI」插件化，本方案是「历史面板」插件化，正交）。
- **前置呼应**：host-slimdown-plugin-contracts-plan 的 cap.session 为远期方向；本方案的 `__POLARIS_SESSION_API__` 是其 restore/fork 子集的前身，cap.session 落地后插件可平移。
- **机制沉淀**：`contributes.overlays` 为通用浮层插槽，下一个候选 NotificationCenterPanel（同为 RightSlideOver 挂载）。

---

## 9. 待确认问题（评审输入）

1. **overlays 贡献点形态**：独立 `contributes.overlays[]`（本方案推荐）vs 扩展 `views.area`。推荐前者：抽屉与活动栏面板生命周期/形态不同，独立建模可避免 area 白名单语义稀释。
2. **cap.history 扩容后旧命令清理节奏**：`history_query/search/mark`、`dialog_read_page` 建议保留至 P4（双端兼容），P4 按「迁一个砍一个」清理——是否同意。
3. **渲染保真底线**：v1 精简渲染器（文本/思考/工具摘要）是否可接受；不可接受则 P1 需追加块渲染投入（评估约 +2~3 天）。
4. **delete_session 的 source 语义**：必填 vs 自动推断（本方案：可省略、自动推断，显式优先）。
5. **P2 翻默认的裁决人与时点**：建议以 P1 对照清单全绿 + 一周共存试跑无回归为准。
