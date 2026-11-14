# AI 对话域插件化实施 spec（chat-desk）

> 状态：**待评审**（2026-11-14 起草，仅分析规划，未实施）
> 关联：`core-slimdown-plugin-extraction-plan.md`（红线修订）、`002-cap-session-capability-spec.md`（并入本文 P1.1）、`host-slimdown-plugin-contracts-plan.md`（契约吸收）、`plugin-based-ai-chat-analysis.md`（2026-10-23 可行性分析，本文接续其结论）、`terminal-plugin-spec.md` / `terminal-desk-optimization-and-removal-plan.md`（方法论模板）、`session-history-plugin-prd.md`（会话域 UI 出仓先例）
> 用户定案（2026-11-14）：**整个 AI 对话相关内容迁移为插件；宿主提供统一总线；模型供应商、会话等通过 hook 在总线上处理；样式交互完全不变。**

---

## 1. 目标

把「AI 对话域」——Chat 面板 UI、conversationStore、session-v2 kernel、事件路由、静默会话服务（标题生成/提示词优化/派发任务/跨端同步）——整体出仓为插件 **chat-desk**；宿主保留**统一总线运行时**：cap.ai.chat（执行面）、cap.session（状态/查询面，新增）、cap.history、dialog_storage / session_state / turn_persist（存储引擎）、引擎注册表（含插件引擎通道）、模型供应商配置，并在总线关键管线位暴露 **hook**（会话生命周期、引擎选择、供应商解析、消息落盘、流事件），使第三方插件可在总线上扩展处理逻辑。

一句话：**前端对话域全部插件化，后端执行与存储留作宿主总线运行时，扩展点 hook 化。**「日志即真相」不变且被强化——后端事件日志成为唯一权威，前端 store（无论宿主还是插件内）都只是可重建的缓存。

### 1.1 收益

- 主仓净删约 **37k 行**（迁出约 40k，新增契约约 2-3k），超过 B1+B2 全部批次之和，是单笔最大的瘦身。
- Chat 获得独立版本演进能力（发布链、热更新、回滚均走插件通道）。
- 会话/供应商/引擎管线 hook 化后，第三方可用插件扩展 AI 行为（审计、脱敏、路由策略、配额），无需改宿主。
- 与 AGENTS.md §五「新增功能一律默认插件」的方向完全对齐。

---

## 2. 范围界定

### 2.1 迁出（→ chat-desk 插件，前端）

| 域 | 规模 | 内容 |
|---|---|---|
| Chat UI | ~26k 行 / 101 文件 | `src/components/Chat/**` 全部：input（ChatInput 2131 等）、messages、chatBubbles、chatBlocks、tool-calls、session（SessionConfigSelector/NewSessionPanel/MultiSessionGrid 等）、dynamic-island、compact-handoff、search、common |
| 会话状态层 | ~7k 行 | `src/stores/conversationStore/**`（createConversationStore 3082、sessionStoreManager、eventHandler、useActiveSession 等） |
| 会话内核 | ~3k 行 | `src/session-v2/**`（V2SessionKernel、reconcile、hooks） |
| 对话服务 | ~4k 行 | `services/eventRouter.ts`、`titleGenerationService.ts`、`promptOptimizeService.ts`、`dispatchTaskService.ts`、`webReconnectResync.ts`、`remoteSessionFollower.ts`、`sessionHandoff.ts`、`contextCompactHandoff.ts`、`aiChatDispatch.ts`（改写为 hostInvoke 版）、`dialogStorage/` 前端封装、`tauri/chatService.ts` |
| 前端 AI 抽象 | ~8k 行 | `src/ai-runtime/**` + `src/engines/**`（评估后并入插件或裁撤，见 §11 D5；后端引擎不受影响） |

### 2.2 宿主保留（总线运行时，不出仓）

- **后端**：`src-tauri/src/ai/`（registry/traits/claude.rs/simple_ai/plugin_engine/plugin_process_engine）、`ai_chat_core.rs`、`ask_listener.rs`、`session_state/turn_persist/dialog_index/dialog_storage`、`hook_registry`、`provider_router`、`model_profile_service`、`cap.ai.chat` / `cap.history` 能力层。
- **前端**：插件系统（registry/loader/bridge/styles）、cap 总线前端封装（transport、aiHistoryDispatch）、`ModelProviderTab` / `AIEngineTab`（供应商配置管理面）、`configStore` / `modelProfileStore` / `engineMetadataStore` / `sessionConfigStore`（配置域）、新增 `cap.session` 前端封装与 sessionDirectory 薄 store（供宿主 chrome 消费）。
- **布局层**：RightPanel 容器、设置页层叠覆盖（settingsRendering + inert）、窄窗形态、rightPanelCollapsed 仍由宿主负责；插件只承接内容面。

### 2.3 明确不做（本期）

- 不出仓后端 Rust 引擎实现（claude-code / simple-ai）——它们就是总线执行面本身；simple-ai 改写为 node 服务属高风险重写，列入后续可选（§11 D1）。
- 不改 AIEvent 协议、不改 cap.ai.chat 既有动作语义、不改中断时序语义（AGENTS §4.2）。
- 不动 history-desk（已交付）、不动设置页供应商管理。
- 不做消息存储换引擎（dialog_storage JSONL / turn_persist 保持）。

---

## 3. 现状要点（勘探结论摘要）

1. **命令面已收敛**：chat 域前端只经 `router_dispatch('cap.ai.chat')`（19 同步 + 2 流式动作）与少量散命令（`create_file`、`nexus_start_roster`、`add_claude_permission_rules`、`respond_plugin_card`）。chat 专属 Tauri 命令层已摘除。
2. **状态权威已双轨**：磁盘 JSONL + session_state/turn_persist 为持久真相；前端 store 是缓存；session-v2 已把运行状态权威上收后端（session_get_status）。**消息列表权威仍在前端 store**——QuickSwitchPanel 全量导出、若干服务直读 store.messages，这是本次要翻转的最后一块。
3. **Chat 不碰引擎**：Chat 目录对 ai-runtime/engines 零直接 import，引擎差异经 utils 间接体现；发送/中断全走 store→cap.ai.chat。前端引擎注册表基本是 vestigial（仅 claude-code 有前端工厂，热路径不经过）。
4. **插件机制现成**：同 window 动态 ESM + react shim + `__POLARIS_HOST_INVOKE__`（含 router_dispatch / router_dispatch_stream）+ contributes.styles（--c-* token）+ shadow 接管 + dev-link。缺口：`__POLARIS_HOST_LISTEN__` 对 chat-event 做了过滤（仅 mc- 前缀与 session_start/end 元数据，正文流不透传）；react shim 未含 react-dom（Chat 有 8 处 createPortal）。
5. **Hook 骨架已就位**：后端 HookSystem 已插桩 `ai.session.start/end`、`ai.tool.before/after`（cap.hook 承载）；缺前端 `contributes.hooks` 声明接线，缺会话创建前/引擎选择/供应商解析/消息落盘四个新 hook 点。
6. **非对话消费方 11 处**：SessionTabs/SessionTab/WorkspaceMenu/CreateSessionModal/SessionDeleteConfirm（元数据+动作）、NotificationCenterPanel（switchSession）、QuickSwitchPanel（全量消息导出）、ModelProviderTab（profile 联动）、App.tsx、useAppInit/useWindowManager（initialize）、dynamic-island（流式中间态，随域迁出）。
7. **体量对比**：terminal 出仓删 2.2k、browser 12.1k、IM 12k；本次约 40k，为最大单域，必须按最保守的分期推进。

---

## 4. 目标架构

```
┌─ 宿主（Polaris core）────────────────────────────┐
│  布局层: App 壳 / RightPanel 容器 / 设置页层叠 / 窄窗形态 │
│  插件系统: registry / loader(react+react-dom shim) /   │
│            bridge(invoke/listen/theme/workspace/…)     │
│  统一总线: RouterBus(28 caps) + 事件广播 + 审计链        │
│  ├─ cap.ai.chat   执行面(start/continue/interrupt/…)    │
│  ├─ cap.session   状态/查询面(新增, 见 §5.1)            │
│  ├─ cap.history   历史查询                              │
│  ├─ cap.config    供应商/引擎/模型 Profile 配置          │
│  ├─ cap.hook      hook 注册与派发(扩展, 见 §5.5)         │
│  └─ 存储引擎: dialog_storage / session_state /          │
│               turn_persist / dialog_index（日志即真相）  │
│  引擎运行时: EngineRegistry(claude-code/simple-ai/      │
│              plugin_engine/plugin_process_engine)       │
│  供应商管线: provider_router + apply_model_profile_…    │
│  sessionDirectory 薄 store（宿主 chrome 消费, §5.1）     │
└──────────────┬──────────────────────────────┘
               │ window 桥 + chat-event(授权全量) + hooks
┌──────────────▼──────────────────────────────┐
│  chat-desk 插件（core，不可卸载，可禁用）        │
│  Chat UI 全家（input/messages/blocks/island/…） │
│  conversationStore（插件内 zustand，缓存层）     │
│  session-v2 kernel（reconcile，对账层）          │
│  静默会话服务（标题/优化/派发/跨端同步）          │
└─────────────────────────────────────────────┘
```

数据流向：用户发送 → 插件 store → `router_dispatch_stream('cap.ai.chat')` → 宿主引擎运行时 → AIEvent → `chat-event` 广播 → 插件（授权订阅）eventHandler 归约渲染；同时后端影子写 session_state / turn_persist / dialog_storage（真相落盘）。宿主 chrome（SessionTabs/通知/QuickSwitch）只读 sessionDirectory 薄 store（由 session_start/end、元数据事件驱动），不再触达消息级状态。

---

## 5. 总线契约设计（P1 宿主地基，全部纯增量）

### 5.1 cap.session（状态/查询面）

吸收 `002-cap-session-capability-spec.md` 的三命令簇收敛（dialog.*/message.*/state.*，35 命令），并补齐插件化所需动作：

```
cap.session
├─ dialog.list / dialog.read_page / dialog.append / dialog.delete   （既有 dialog_* 映射）
├─ message.query     {sessionId, range|full}   → 结构化消息（QuickSwitchPanel 导出改走此动作）
├─ state.get         {sessionId}               → 权威运行状态（等价 session_get_status）
├─ state.subscribe   元数据流（会话列表/activeId/isStreaming 摘要，喂 sessionDirectory）
├─ session.set_active {sessionId}              → 宿主持有的导航态（双向同步见 §7）
├─ session.restore / session.fork               （既有 __POLARIS_SESSION_API__ 语义入总线）
└─ session.list_running / session.archive_page  （与 cap.history 对齐，避免双头）
```

约束：不新增第三条写路径——所有写仍由 cap.ai.chat / 既有后端服务执行，cap.session 是**读/查询/导航**面 + 既有 dialog 命令的收口。`002` spec 的「不拆三能力」结论沿用。

### 5.2 主面板席位（mainSurface）

- `contributes.views[].area` 枚举扩展：`'activityBar'` 之外新增 **`'mainSurface'`**（Rust `validate_manifest_fields` 与前端 `schema.ts` 双侧同步，含镜像测试）。
- App.tsx 挂载逻辑：存在已启用插件声明 `area:'mainSurface'` + `slotMode:'shadow'` → 渲染 `PluginPanelHost`；否则渲染内置 Chat（**灰度期回滚 = 禁用插件，内置原样回来**）。
- 席位契约保留：内置 chat 席位声明不删（对齐 terminal D3 教训，避免宽度/记忆/层叠迁移），接管期后内置实现删除、席位改空态引导卡。
- 设置页层叠、窄窗形态、rightPanelCollapsed 等布局语义留在宿主容器层，插件只填充内容。

### 5.3 事件订阅权限（chat-event 全量授权）

- manifest `permissions` 扩展 `events: string[]`（如 `["chat-event"]`）或 `chatEvent: "full" | "lifecycle" | "none"`（默认 lifecycle，即现状过滤行为）。
- `__POLARIS_HOST_LISTEN__('chat-event')` 按**调用方插件**的授权等级过滤：chat-desk 授 full（正文 token/thinking/工具流可见）；其他插件维持现状。授权校验在宿主桥内完成（正门），白名单继续收窄直连（侧门）。
- 审计：full 授权在审计链打标（对话正文对插件可见 = 高权限，对齐 host-slimdown 安全纪律）。

### 5.4 react shim 扩展 react-dom

`ensureReactShim()` 增加导出宿主 react-dom 的 `createPortal` / `flushSync`（宿主 bundle 已含 react-dom，零新增依赖）。插件 bundle 继续 `external: ['react','react/jsx-runtime','react-dom']`。这是 Chat 内 8 处 `document.body` portal（NewSessionPanel、MarkdownImageViewer 等）能原样运行的前提。

### 5.5 hooks 体系（供应商/会话/引擎/流）

后端 `hook_registry` 扩展四个新点，前端补 `contributes.hooks` 声明接线（解析 manifest → `cap.hook.register`，插件启停时注册/注销）：

| hook | 时点 | 语义（v1） |
|---|---|---|
| `ai.session.before_create` | start_chat_inner 解析引擎前 | **观察**会话意图（engineId/model/profileId/kind）；v1 不可拒绝 |
| `ai.session.start` / `ai.session.end` | 已有 | 沿用 |
| `ai.engine.select` | EngineId 解析处（ai_chat_core.rs:1190） | 观察请求的引擎/模型；v1 不可改写 |
| `ai.provider.resolve` | apply_model_profile_options 前 | 返回**脱敏** Profile 视图（api_key 永不出宿主）；插件可建议 profileId 切换（v1 记录建议，不强制） |
| `ai.message.before_persist` | turn_persist observe 前 | 观察；为审计/脱敏类插件预留（v1 不改写） |
| `ai.stream.event` | event_callback 出站处 | 观察 AIEvent（敏感字段裁剪由宿主做，插件只读） |
| `ai.tool.before` / `ai.tool.after` | 已有 | 沿用 |

纪律：v1 全部 **observe-only**（不可改写、不可拒绝），超时放行、失败不阻塞主链路（沿用 HookSystem 既有超时语义）；mutating 语义留 v2 评审（§11 D3）。hook 派发经 EventAdapter 广播 + cap.hook 回调双通道，与现状一致。

### 5.6 模型目录 / 插件卡片 / 杂项桥

- `__POLARIS_MODEL_CATALOG_API__`（只读）： profiles（脱敏）、engineMetadata、cliInfo——供插件内 SessionConfigSelector 消费；或直接走 `cap.config` 只读动作（优先，少一个桥）。
- 插件卡片：chat-desk 需要读取宿主 `chatCardRegistry`（他插件 contributes.chatCards）与 uiSlot/capCatalog（`/cap` 命令）。暴露只读桥 `__POLARIS_CHAT_CARDS_API__`（list/subscribe），渲染与应答（respond_plugin_card）走插件内 PluginCardHost 原逻辑。
- 散命令收口：`create_file` → 插件改走 `cap.fs`；`add_claude_permission_rules`、`nexus_start_roster` 纳入 HOST_INVOKE 白名单或对应 cap 动作（评审时定，倾向前者——它们是引擎/工具域命令，不值得为此扩 cap 面）。
- `__POLARIS_SEND_TO_CHAT__` 语义保持：宿主桥内转投「活跃会话」，由 sessionDirectory 记录 activeId + 插件注册的接收器完成（他插件无感）。

---

## 6. chat-desk 插件设计

- **身份**：`id: "chat-desk"`，显示名「AI 对话」（直白命名纪律），`core: true`（不可卸载）、`enabledByDefault: false`（P2-P4 灰度期）→ `true`（P5 接管）。版本从 1.0.0 起。
- **manifest 要点**：`contributes.views: [{ area:'mainSurface', panelType:'chat-desk', slot:'chat.main', slotMode:'shadow', icon:'MessageSquare', supportsFullscreen:false }]`；`contributes.panel.entry:'./dist/panel.js'`；`contributes.styles`（global 注入编译期 Tailwind 产物，见 §9 R1）；`permissions: { events:['chat-event'], appConfigRead:true, aiToolAccess:true }`；`contributes.hooks: [...]`（消费示例，非必需）。
- **目录**（对齐 terminal-desk 范式）：

```
plugins/chat-desk/
├─ plugin.json / update.json
├─ dist/panel.js            # esbuild 产物（react/react-dom external）
├─ dist/chat.css            # 插件自编译 Tailwind（同一 token 变量）
├─ src/
│  ├─ index.tsx             # default export ChatPanel
│  ├─ bridge.ts             # hostInvoke/listen/theme/session/modelCatalog 封装
│  ├─ store/                # 原 conversationStore（aiChatDispatch 改 hostInvoke）
│  ├─ kernel/               # 原 session-v2
│  ├─ chat/                 # 原 components/Chat（分目录整体搬运）
│  ├─ services/             # 原 eventRouter/titleGeneration/promptOptimize/…
│  └─ ai/                   # 原 ai-runtime + engines（按 D5 裁决）
├─ scripts/build.mjs        # esbuild + tailwind 编译 + styles 同步进 manifest
└─ test/                    # 金标移植测试（eventHandler 归约、中断时序、恢复对账）
```

- **状态层改造原则**：store 代码**原样搬运、最小改动**——只把 transport invoke 换成 hostInvoke、listen 换成授权版 `__POLARIS_HOST_LISTEN__`。不改 eventHandler 归约逻辑、不改中断 8s/5s 兜底时序、不改 WAL 增量持久化（dialogStorage 走 cap.session dialog.* 动作）。
- **初始化**：插件面板挂载时执行原 useAppInit 的会话域初始化子集（store 装配、kernel 注册、历史恢复）；宿主 useAppInit 中对应段落随 P6 摘除。

---

## 7. 非对话域消费方处置表

| 消费方 | 现状依赖 | 处置 | 阶段 |
|---|---|---|---|
| SessionTabs / SessionTab / WorkspaceMenu / CreateSessionModal / SessionDeleteConfirm | useSessionMetadataList / useActiveSessionId / useSessionManagerActions / useSessionStreaming | 改接 **sessionDirectory 薄 store**（宿主新增，只含元数据/activeId/流式摘要，由 cap.session.state.subscribe 驱动）；删除会话等动作走 cap.session / cap.ai.chat | P3 |
| NotificationCenterPanel | switchSession | 改调 `cap.session.session.set_active` → 总线事件 → 插件应用 | P3 |
| QuickSwitchPanel | useActiveSessionMessages 全量导出 | 导出改 `cap.session.message.query {full}`；切换走 set_active | P3 |
| ModelProviderTab | sessionStoreManager（激活 profile 联动） | 改经 cap.config + 事件（profile 激活本就是配置域） | P3 |
| App.tsx:59-60 | actions/streaming/error/元数据 | 摘除；isCompact/层叠布局保留；`__POLARIS_SEND_TO_CHAT__` 改挂桥接 | P5 |
| useAppInit / useWindowManager | conversationStore initialize | 会话域初始化移入插件挂载流程 | P5/P6 |
| dynamic-island / compact-handoff / MessageSearchPanel / ChatNavigator | store 深度消费 | **随域迁出**（属对话 UI） | P2/P3 |
| titleGeneration / promptOptimize / dispatchTask / webReconnectResync / remoteSessionFollower | 静默会话 + 直读 store | 随域迁出（cap.ai.chat + 授权事件即可工作） | P3 |
| history-desk（已交付） | `__POLARIS_SESSION_API__` / chat-event 生命周期 | 不动；其消费的桥语义不变 | — |
| 其他插件（multi-chat 等） | mc- 前缀事件、SEND_TO_CHAT | 不动（过滤行为不变） | — |

**activeSessionId 所有权**：宿主持有（导航态），插件订阅 + 回写（单写者 = 宿主 sessionDirectory，插件经 `cap.session.session.set_active` 提交意图）。避免双头。

---

## 8. 分阶段实施

> 铁律沿用 terminal-desk：**插件未达 §10 零降级验收前，不启动任何删码动作**；宿主增量 / 插件实现 / 摘装配 / 删实现分属不同 commit，删除 commit 独立可 revert。

| 阶段 | 内容 | 验收 | 回滚 |
|---|---|---|---|
| **P0 立项** | 本 spec 评审通过；修订 core-slimdown §4.3 红线表（Chat 行移出，登记新批次）；确定 §11 决策点 | 文档对账完成，无矛盾文档并存 | — |
| **P1 契约地基**（纯增量，6 个独立 commit） | §5.1-§5.6 全部：cap.session、mainSurface 席位、事件授权、react-dom shim、hooks 接线与新 hook 点、目录/卡片桥 | 四门禁全绿；既有 UI **零变化**（内置 Chat 照常渲染）；新能力有 describe + 审计；web-only 门禁过 | 逐 commit revert |
| **P2 插件骨架** | chat-desk 仓建立；最小闭环：面板挂载、会话列表、发送（start/continue 流式）、中断、文本/思考/工具块渲染；store/kernel 原样搬运 + 桥接改写 | 真宿主（dev-link）跑通对话闭环；桌面 + Web 双端 | enabledByDefault=false，不影响任何用户 |
| **P3 功能等价** | 对照 §10 矩阵逐项补齐：输入区全功能、全部交互块、会话管理、island、压缩交接、搜索、静默服务、跨端同步；宿主 chrome 改接 sessionDirectory | 等价矩阵逐项标「保留/增强/降级」，**降级=0** 才放行 | 同上 |
| **P4 数据对账** | 消息权威收敛后端：插件缓存全量重建演练（禁用→启用消息不丢）；QuickSwitch 导出切 cap.session；WAL 水位对账 | 断网重连、强杀进程、跨端三场景消息零丢失 | — |
| **P5 影子接管** | enabledByDefault=true，主面板默认 chat-desk 渲染；内置 Chat 保留未挂载（灰度期回滚手段）；App.tsx 接线保留 | 灰度观察期（建议 ≥1 周 + 双端回归）；用户可一键禁用回内置 | 禁用插件即回内置，零成本 |
| **P6 摘装配 + 删实现**（独立 commit） | 删 `src/components/Chat/**`、`stores/conversationStore/**`、`session-v2/**`、对话 services、前端 ai-runtime/engines（按 D5）；App.tsx / useAppInit 摘接线；席位改空态引导卡；白名单收敛 | 四门禁全绿；`grep -r "conversationStore|session-v2|components/Chat" src` 仅剩允许清单；行数对账 ±20% | git revert 删除 commit |
| **P7 收尾** | AGENTS.md §五 cap 清单 + two-bus-architecture.md 增补 cap.session；core-slimdown 勾销；插件 publish（zip+sha256+tag+CDN）；热更新链路验证一次 | 三处同步完成；商城可见 | — |

依赖关系：P1 全部 → P2 → P3 → P4 → P5 → P6 → P7，严格串行；P1 内部各 commit 可并行。

---

## 9. 风险与对策

| # | 风险 | 等级 | 对策 |
|---|---|---|---|
| R1 | **Tailwind 样式**：Chat ~40 文件使用宿主语义 token 类（text-text-primary 等），宿主 Tailwind 不会为插件源码生成工具类 | 高 | 插件构建期自编译 Tailwind（复用宿主 theme token → 同名 CSS 变量），产物经 `contributes.styles` global 注入；类名与宿主确定性一致、规则同源不冲突；`check-styles` 门禁对齐 terminal-desk（禁硬编码色、必须继承 --font-sans/--radius 等） |
| R2 | **react-dom portal**：插件 shim 无 react-dom | 中 | P1.4 shim 扩展 createPortal/flushSync；build external react-dom；P2 首日即验证 NewSessionPanel/MarkdownImageViewer |
| R3 | **状态连续性**：接管期禁用插件回内置时，内置 store 为空 | 中 | 后端是唯一真相——内置 Chat 挂载时走既有历史恢复全量重建（P4 已演练同一机制）；灰度期窗口短，可接受 |
| R4 | **非对话消费方漏改**（11 处） | 中高 | §7 处置表逐项挂到 P3 验收；grep 断言兜底（P6） |
| R5 | **插件 bundle 体积**：mermaid/virtuoso/hljs/dompurify/diff/zustand 自带 | 中 | loader 上限 50MB，预估 <15MB；mermaid 保持动态 import；面板本就懒加载，不进宿主首屏（反而比现状更优——现状 Chat 重组件已懒加载，插件化后整体出首屏） |
| R6 | **hooks 滥用/时延**：hook 派发增加流式路径开销 | 中 | v1 observe-only + 超时放行 + 失败不阻塞；ai.stream.event 派发在出站闭包内同步 list 调用，无await 阻塞；基线对比 P1 前后流式首字延迟 |
| R7 | **权限放大**：chat 插件持 full chat-event + 广 cap 面 | 中 | core 插件不可卸载但审计打标；事件授权粒度落在 manifest permissions；审计链记录 full 授权授予 |
| R8 | **Web 模式差异**：transport 双态 | 低 | 插件一律走 hostInvoke/hostListen（history-desk 已验证该路径在 Web 可用）；P2/P5 双端冒烟 |
| R9 | **中断/恢复时序回归** | 中 | 逻辑原样搬迁不改语义；eventHandler/中断路径以宿主既有测试为金标移植断言（scheduler 金标法）；P4 三场景演练 |
| R10 | **多窗口/多实例** | 低 | store 本就每窗口一份，插件化不改变该语义 |

---

## 10. 零降级验收矩阵（P3 出口标准）

- 发送/续聊/中断/编辑重发/regenerate：行为、按钮态、错误提示逐项一致
- 流式渲染：token/thinking/工具卡/usage/首字延迟无回退（对比基线）
- 交互块：question/form/plan_mode/permission/plugin_card/ui_frame/chart 全类型渲染与提交链路
- 输入区：附件（选择/粘贴/拖拽）、@建议、斜杠命令（/cap /agent /dispatch /nexus /assault）、prompt 优化、草稿恢复、历史回溯
- 会话管理：新建/切换/删除/多窗/重命名、跨端跟随、断线恢复
- island / 状态栏 / 压缩交接 / 搜索 / 通知联动 / QuickSwitch
- 主题：明暗切换、token 热更新、聊天显示设置（字号/密度 CSS 变量）
- 双端：桌面 Tauri + Web 9827 全矩阵
- 性能：首屏 bundle 不增（Chat 移出）、会话启动 TTI 不劣化

---

## 11. 待拍板决策点

| # | 决策 | 建议 |
|---|---|---|
| D1 | 后端引擎层（claude-code/simple-ai Rust）是否本期出仓 | **保留宿主**（它们是总线执行面；simple-ai 出仓=纯 node 重写，高风险零收益）。后续如需，单独立项 |
| D2 | 插件 id / 显示名 | `chat-desk` /「AI 对话」 |
| D3 | hooks v1 是否允许改写（mutating） | **observe-only**；mutating（before_create 拒绝、engine.select 改写）留 v2 单独评审 |
| D4 | 禁用 chat-desk 后主面板形态 | 空态引导卡（对齐 terminal 席位契约），不隐藏 RightPanel |
| D5 | 前端 ai-runtime/engines 处置 | 并入插件（保留类型与事件契约资产）；其中确无消费的 vestigial 注册表路径在 P6 一并裁撤 |
| D6 | cap.session 是否同时服务 history-desk 等既有插件 | 是——cap.history 保留，cap.session 只做状态/查询/导航收口，避免语义重叠（重叠动作不双开） |

---

## 12. 文档对账清单

- [ ] `core-slimdown-plugin-extraction-plan.md` §4.3：Chat/会话域行移出「不拆清单」，登记为本表新批次（附本 spec 链接与用户定案日期）——按 git 域先例，唯一权威，不留矛盾文档。
- [ ] `002-cap-session-capability-spec.md`：标记「并入 ai-chat-plugin-extraction-spec P1.1」。
- [ ] `host-slimdown-plugin-contracts-plan.md`：cap.session / chatActions / ai.stream.end 条目标注「由本 spec 承接/调整」（其 §8 不做清单中 Chat 本体一项同步修订）。
- [ ] `plugin-based-ai-chat-analysis.md`：文首加「已由本 spec 落地接续」。
- [ ] `AGENTS.md` §五：cap.session 加入清单（P1 落地时）。
- [ ] `two-bus-architecture.md`：bus/dispatch 归属表补 cap.session（主进程侧）。
