# chat-desk P6 摘装配 + 删实现 专项 spec

> 日期：2026-11-15 · 状态：**实施中**
> 上位文档：`plans/ai-chat-plugin-extraction-spec.md`（P0-P7 总规划；本文是其 P6 阶段的执行细则，冲突处以本文为准）
> 方法论模板：`plans/terminal-desk-optimization-and-removal-plan.md`（P5 摘装配 / P6 删实现 / grep 断言 / 保留项调用链证据的同一纪律）
> 用户定案（2026-11-15）：「可以，确定实施直到完成所有内容」——P5 影子接管已上线且多窗口网格刷新缺陷已修复（插件仓 `8856016a`），P6 启动。

---

## 0. 定案

| # | 定案 | 依据 |
|---|---|---|
| **D1** | 删除的是**宿主内置 Chat 的 UI 实现、会话状态层、会话内核、对话服务、前端 AI 抽象**；不是对话能力本身（能力由 chat-desk 插件经 cap.ai.chat / cap.session 承接） | 总 spec §1/§2.2；terminal D1 同款 |
| **D2** | **会话状态实现随域迁入插件**：P3 期的「宿主单实例 + 插件桥转发」是灰度过渡形态；P6 后 manager/useActiveSession/eventHandler 实现住在插件仓 `src/host/conversationStore/`，插件面板挂载时把实例**回挂** `window.__POLARIS_APP_CORE__.stores.sessionStoreManager`（反向桥），宿主 sessionDirectory 薄 store 继续从桥读投影——单实例语义不变，宿主源码归零 | 总 spec §6「store 原样搬运」；P3 已验收的单实例纪律（防双 manager 状态分裂） |
| **D3** | **保留 `chat.main` 席位契约**，禁用插件时渲染 `ChatMainSlot` 空态引导卡（已存在）；删除 `chatHostRemoved` 灰度开关与内置 Chat 渲染分支 | 总 spec §5.2；terminal D3 同款 |
| **D4** | 提交纪律：chrome 消费方改造 / App+useAppInit 摘接线 / 删实现，**分属不同 commit**，删除 commit 独立可 revert；P6 后回滚手段从「禁用插件」变为「revert commit」 | terminal D6 同款 |
| **D5** | ai-runtime **不全删**：`event.ts`（AIEvent 协议类型，1303 行零依赖）+ `event-bus.ts`（EventBus 单例）是宿主保留资产（DeveloperPanel / pluginToolUsageObserver / SessionTabContextMenu 消费），迁往 `src/types/aiEvent.ts` + `src/services/aiEventBus.ts`；其余（engine/session/task/tool-registry/base/engine-registry）随域删除 | 保留项调用链证据见 §4 |
| **D6** | dialogStorage / sessionBus / chatExport / promptHistory（纯函数）**保留宿主**——它们是存储引擎与 chrome 消费面，不是对话 UI | §4 逐项证据 |

---

## 1. 删除范围（主仓）

| 域 | 路径 | 规模 |
|---|---|---|
| Chat UI | `src/components/Chat/**` | ~101 文件 / ~26k 行 |
| 会话状态层 | `src/stores/conversationStore/**` | ~54 文件 / ~9k 行 |
| 会话内核 | `src/session-v2/**` | ~22 文件 / ~5.7k 行 |
| 前端 AI 抽象 | `src/ai-runtime/**`（除 event.ts、event-bus.ts 迁移）、`src/engines/**` | ~7.3k 行 |
| 对话服务 | `src/services/`：eventRouter / titleGenerationService / promptOptimizeService / dispatchTaskService(+test) / webReconnectResync / remoteSessionFollower(+test) / sessionHandoff / contextCompactHandoff / aiChatDispatch / sessionRestore / claudeHistoryConvert / sessionArchive / assistantTextUtils | ~3.5k 行 |
| hooks | `src/hooks/useChat.ts`（useChatEvent 全仓无消费）、hooks/index 摘 `useChatEvent` 导出 | ~60 行 |
| 引擎装配 | `src/core/engine-bootstrap.ts`（bootstrapEngines：唯一生产者是 useAppInit；SessionTabContextMenu 的 getEngineRegistry 改 engineMetadataStore.getEngineIds） | ~90 行 |
| 死代码 | `src/components/Session/SessionTabs.tsx` + `SessionTab.tsx`（无挂载点，仅 barrel 互引）、`src/components/Common/SessionDeleteConfirm.tsx`(+test)（同） | ~1.2k 行 |
| lightweightMarkdown | `src/utils/lightweightMarkdown.tsx`(+3 test)：唯一非测试消费方是 Chat 的 TextBlockRenderer | ~1.1k 行 |
| barrel 清理 | `src/components/Session/index.ts`、`src/components/Common/index.ts` 摘对应导出 | — |

**不删**（保留项，证据见 §4）：dialogStorage/、sessionBus.ts、chatExport.ts、promptHistory.ts（纯函数，被 promptHistoryService 用）、tauri/chatService.ts（桥上 pending question/plan 通道）、promptHistoryService.ts（appCoreBridge + newSessionPrefsService 消费）、uiDispatchService（inputUIStore 装配）、streamRateTracker / fileSearch / imageSaveService / claudeSettingsService / conversationPackager（插件桥消费）、i18n chat 词典（宿主持有，插件 shim 转发实例）。

## 2. 摘接线

| 文件 | 动作 |
|---|---|
| `src/App.tsx` | 删 8 个 Chat 组件 import + MultiSessionGridLazy + conversationStore hooks（isStreaming/error/sendMessage/interrupt/editAndResend/activeSessionId/sessionMetadataList/activeSessionIsFree/editMode/handleEditMessage）；删 `chatHostRemoved` 开关与内置 Chat 渲染分支 → `ChatMainSlot` 唯一兜底；`__POLARIS_SEND_TO_CHAT__` 桥改挂插件通道（保留函数式兜底）；`demoPluginContent` 的 `onSendToChat={sendMessage}` 与 `onSendToChat` prop 改桥 |
| `src/hooks/useAppInit.ts` | 删 `sessionStoreManager.initialize()` + `bootstrapEngines`（会话域初始化随域进插件面板挂载流程）；保留 OPFS 迁移（存储域）与 agent 预加载 |
| `src/hooks/useAppEvents.ts` | 删 eventRouter 初始化、isAIEvent 分支、initDispatchTaskListener；保留 pluginLifecycleSubscriber 与 tab/workspace 事件 |
| `src/main.tsx` | `remoteSessionFollower.start()` 摘除（随域进插件；RemoteSessions 面板数据源改插件内启动） |
| `src/plugin-system/appCoreBridge.ts` | 删 conversationStore/session-v2/对话服务/aiRuntime 桥条目（插件改用自带实现）；保留 chrome 需要的 stores（view/config/workspace/…）与新迁的 aiEventBus |
| `src/stores/sessionDirectoryStore.ts` | 写动作改经 cap.session/cap.ai.chat 总线（switchSession/deleteSession/updateSessionWorkspace 等），不再直连 manager |
| `src/plugin-system/builtinPlugins.ts` | UiFrameCard 注册改指向新址（见 §3.1） |

## 3. 域外消费方处置（先行 commit）

1. **SessionConfigSelector**（830 行）→ 迁 `src/components/Session/SessionConfigSelector.tsx`（CreateSessionModal 域外唯一消费；与插件仓同源，主仓版为基准）。
2. **UiFrameCard + uiTemplateNodes + chartNodeView**（cap.ui.render 宿主卡片通道，builtinPlugins 注册）→ 迁 `src/components/UiFrame/`。
3. **promptHistory.ts 纯函数** → 迁 `src/utils/promptHistory.ts`（promptHistoryService import 改路径）。
4. **RemoteSessionsQuickSection / RemoteSessionsNavSection**（RemoteSessionsPanel 218 行，QuickSwitchContent + ChatNavigator 消费）→ 整文件迁 `src/components/Session/RemoteSessionsPanel.tsx`（依赖 remoteSessionFollower → 见 5）。
5. **remoteSessionFollower.ts**（668 行）：main.tsx 的 start() 摘除后，发现循环/lifecycle 订阅由 chat-desk 面板挂载时启动（插件 shims 已有 lazyObj 转发，无需改）；宿主保留文件本身（SessionTabContextMenu/QuickSwitch 间接消费其类型与 isListableRemote）。
6. **QuickSwitchPanel**：`useSessionManagerActions`/`useActiveSessionMessages` 改 sessionDirectoryStore 动作 + `readSessionMessages`（cap.session 权威读，P4 已有该动作）；`sessionHandoff` 的 `getHandoffEligibility`/`handoffSessionToNewSession` 保留（服务本身保留在宿主，删码时改接插件桥）。
7. **SessionTab/SessionDeleteConfirm/SessionTabs/capSlashCommand/SessionTabContextMenu**：仅类型引用（SessionMetadata/ContextBlock）→ 类型改从 `@/types` 或 sessionDirectoryStore 取；getEngineRegistry 改 engineMetadataStore。
8. **lightweightMarkdown**：随域删（唯一消费者 TextBlockRenderer 在 Chat 域）。

## 4. 保留项调用链证据（为什么不能删）

| # | 保留项 | 谁在用（实测） | 删了会怎样 |
|---|---|---|---|
| 1 | `services/dialogStorage/` | SessionDeleteConfirm（删除会话清盘）、DataStorageCard（设置页存储统计）、useAppInit（OPFS 迁移）、appCoreBridge（插件桥）、sessionRestore | 存储引擎属宿主总线（总 spec §2.2），删=数据面断 |
| 2 | `services/sessionBus.ts` | sessionDirectoryStore（P3.d 改接）、QuickSwitchPanel（getSessionStatus 导出校验） | cap.session 前端封装，chrome 唯一读面 |
| 3 | `services/chatExport.ts` | QuickSwitchPanel 导出（ChatMessage 类型来自 `@/types`，不依赖 Chat 组件） | 导出功能断 |
| 4 | `ai-runtime/event.ts` + `event-bus.ts` | DeveloperPanel（onAny 事件流）、pluginToolUsageObserver（tool_call_end 记账，main.tsx 启动）、SessionTabContextMenu（改 engineMetadataStore 后仅类型）、插件桥 aiRuntime | AIEvent 协议类型是前后端契约（对齐 `models/ai_event.rs`），EventBus 单例是事件广播底座 |
| 5 | `services/remoteSessionFollower.ts` | RemoteSessions 面板（迁移后）、main.tsx（start 摘除）、插件桥 | 跨端会话跟随数据源 |
| 6 | `services/sessionHandoff.ts` | SessionTab/SessionTabContextMenu/QuickSwitchPanel 的「续接到新会话」；插件桥 | chrome 会话操作能力 |
| 7 | i18n `locales/*/chat.json` | 宿主 chrome 56 处 `useTranslation('chat')` + 插件（shims 转发宿主 i18next 实例） | 词典删=chrome 文案断 |

## 5. 门禁（每 commit 后全跑）

- `pnpm exec tsc --noEmit`、`pnpm lint`、`pnpm test:run`、`cargo check`、`cargo check --no-default-features --bin polaris-web --bin polaris-mcp`
- grep 断言（终态）：

```
grep -r "components/Chat|stores/conversationStore|session-v2|ai-runtime|engines/|eventRouter|titleGenerationService|promptOptimizeService|dispatchTaskService|webReconnectResync|remoteSessionFollower|sessionHandoff|contextCompactHandoff|aiChatDispatch|sessionRestore|claudeHistoryConvert|sessionArchive|engine-bootstrap|useChat" src
→ 仅允许命中：sessionBus（cap.session 封装）、dialogStorage、chatExport、promptHistoryService、
  appCoreBridge（瘦身后）、sessionDirectoryStore（总线动作）、类型迁移落点（types/aiEvent.ts、
  services/aiEventBus.ts）、i18n 词典、测试断言字符串
grep -r "VITE_CHAT_HOST_REMOVED" src → 0 命中
```

- 行数对账：净删 ~37k ±20%（对照总 spec §1.1）
- 真宿主验收：polaris-web 9829 冒烟——chat-desk 面板对话闭环、多窗口网格、QuickSwitch 导出、禁用插件 → ChatMainSlot 空态卡

## 6. 回滚

| 阶段 | 回滚 |
|---|---|
| 域外消费方改造 commit | git revert 单 commit |
| 摘接线 commit | git revert 单 commit（内置 Chat 分支恢复） |
| 删实现 commit | git revert 删除 commit |
| 终态（P6 后） | revert 删除 commit；插件 dist 不回滚（能力在插件） |

## 7. 插件仓配套（Polaris-plugin）

- manager/useActiveSession/eventHandler 等实现已在插件仓 `src/host/conversationStore/`（createConversationStore 3082 行等完整实现同源在库）——P6 把宿主 1082 行 sessionStoreManager 的**增量实现**（事件 emit、deleteSession 磁盘清理、profile 镜像同步等）合入插件仓同源文件，替换 65 行转发文件；`build.mjs` alias 把会话域四文件从 shims 改指 host 实现；插件 index.tsx 挂载时执行 `__POLARIS_APP_CORE__.stores.sessionStoreManager = <插件内实例>` 反向注册 + 会话域初始化子集。
- 插件面板启动 remoteSessionFollower（shims 已转发，挂载时调用 start）。
