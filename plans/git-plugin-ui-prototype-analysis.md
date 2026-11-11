# 分析：Git 插件 UI 原型设计与宿主支持缺口

> 状态：**分析完成 · 待裁定 · 未实施**（用户 2026-11-11 追加要求：先分析插件 UI 原型，并检查宿主是否需同步提供支持）
> 日期：2026-11-11 · 本次动作：**仅新增本分析文档，未改动任何代码**
> 上位文档：`plans/git-domain-plugin-extraction-requirement.md`（需求登记，R1/R2/R3）、`plans/core-slimdown-plugin-extraction-plan.md` §4.3（不拆定案，仍有效）、`docs/git-plugin-extraction-plan.md`（2026-08 方案）、`plans/git-panel-prd.md` + `plans/git-panel-vnext-prototype.html`（vNext 交互原型）、`plans/git-panel-master-plan.md`（单 cap.git 定案）
> 效力：本文是**分析**，不是实施 spec，不构成对 §4.3 定案的推翻授权。

---

## 0. 结论速览：四条宿主关系的判定

用户点名的四条，恰好覆盖 Git 面板与宿主的全部交界。逐条实测结论：

| # | 宿主关系 | 宿主现有支持 | 是否需要同步提供宿主支持 | 判定 |
|---|---|---|---|---|
| 1 | **工作区** | `__POLARIS_WORKSPACE_API__`（list/currentId/subscribe）可用；`__POLARIS_HOST_WORKSPACE__` 冷启动为空、无订阅 | **需要小幅补齐**（结构化 props + 事件订阅白名单 + 冷启动快照） | 🟡 已有 80%，补 3 项 |
| 2 | **AI 对话生成提交信息** | 只有 `onSendToChat(msg)` → 发到当前活跃会话；`__POLARIS_HOST_LISTEN__` 只透传 `mc-` 前缀 chat-event | **必须新增宿主 API**（kind 会话 / oneTimeSystemPrompt / 结果回流订阅 / workspace 锁定） | 🔴 最大缺口，不补则 R1 必降级 |
| 3 | **左侧板面板** | `views` 贡献点 + `slotMode:'shadow'` 接管 + `panel` entry + 样式作用域 + 保活 + 错误边界；`terminal-desk`（2026-11-11）已实测跑通 | **基本不需要新增**，只需裁定「内置席位去留」并接通 `supportsFullscreen` | 🟢 现成范式，直接复用 |
| 4 | **编辑器面板** | `editorExtensionRegistry` 存在但**仅主仓内部注册一次**；`pluginTabRendererRegistry` 无外部注册通道；`DiffViewer` 被宿主多处复用 | **必须新增契约**（声明式 CM6 扩展 + Tab 渲染器 + Overlay/全屏 + Diff 归属裁定） | 🔴 最硬交界 |

**一句话**：四条里两条已有（工作区大部、左栏几乎全部），两条必须补（AI 会话、编辑器）。**旧原型失败的根因不是画得不好看，而是没先做这四条契约盘点**——把界面画完了，才发现底下没接口。

---

## 1. 旧原型为什么失败（证据化复盘）

### 1.1 迁移产物 `polaris-git` 插件（插件仓 `c4b6900`，已被 `cff8e46` 删除）

`src/Panel.tsx` 是自包含 14KB 面板，`plugin.json` 宣称「完整的 Git 工作台：状态、变更、提交、分支、合并、rebase、历史、blame、远程、stash、.gitignore」。实测问题：

| 问题 | 证据 | 后果 |
|---|---|---|
| **数据通道已彻底失效** | 面板直调 `window.__TAURI_INTERNALS__.invoke('git_get_status', …)`；主仓 `src-tauri/src/lib.rs:58-59` / `:1159-1160` 明确「git_* 命令不再注册，唯一入口 = cap.git」；`src/services/transport/index.ts:243-283` 的 `git_* → cap.git` shim 包在 `invoke()` 里，直调 internals **绕过 shim** | 现在连仓库状态都读不出来，面板是死代码 |
| **绕过宿主白名单** | `src/main.tsx:35-46` 的 `HOST_INVOKE_ALLOWLIST` 只含 `plugin_*` / `message_read` / `router_dispatch(_stream)` / `health_check` / `get_cli_info`，无任何 git 命令；`get_current_dir` 也不在 | 即便改用宿主桥，旧调用方式仍被拒 |
| **功能覆盖约 6 / 50+** | 面板只调 `git_get_status` / `get_worktree_file_diff` / `get_index_file_diff` / `git_stage_file` / `git_commit_changes` / `git_get_log`；内置是 7 个 Tab（changes/history/branch/remote/tags/stash/gitignore）+ 12 个 store slice + 冲突三方合并器 / Rebase TODO / Push / Blame / Reflog / Undo / Risk / Atomic / OperationsLog 等 14+ 浮层 | 「完整」是 manifest 文案，不是事实；这正是 2026-08 折中成「轻量入口」的原因 |
| **工作区靠手填路径** | 首屏第一行是路径输入框；`__POLARIS_HOST_WORKSPACE__` 初始为 `''`（`main.tsx:85`），仅由 `workspace-changed` 事件更新，无冷启动值、无订阅；fallback `get_current_dir` 不在白名单 | 与内置「自动跟随全局工作区」(`useGitActiveWorkspace.ts`) 差一个量级 |
| **Diff 是玩具** | `renderUnifiedDiff` 按行号逐行字符串比较，无 LCS/Myers、无 split、无字级高亮、无 Web Worker、无窗口化、无二进制/大文件省略、无行级选区 stage | 内置 `components/Diff/` 16 文件、被 12 处引用（含 Chat `InlineDiffView` / `PatchDiffRenderer`、`CenterStage` diff tab、`NarrowTabOverlay`） |
| **主题 / i18n 硬编码** | 色值写死 `#1E1E24` / `#3F3F46`，中文文案写死 | 宿主有 88 维主题 API + CSS 变量 + i18n 命名空间 + `[data-plugin-scope]` 样式作用域，一条没接 |
| **接口靠猜** | commit 注释原文：「可能要求 stagedOnly / options，尽力适配」 | 核心写路径未验证 |
| **双引擎分裂** | MCP 13 工具走系统 git CLI，面板走宿主 git2 | 同一仓库两套状态、两套错误语义，AI 与 UI 不同源 |
| **绕过总线** | 不走 `cap.git` | 权限 gate、审计流水、taskId 长任务、`WRITE_GATE` 写串行、Web-only 通道全断 |

> 结论：这份「原型」不是可迁移的底座，是**已经过期的演示**。它依赖的命令层在 2026-10 的 PR-2b 已被整域摘除。

### 1.2 `plans/git-panel-vnext-prototype.html`（802 行 PRD 交互原型）

这是**视觉愿景原型**，不是插件原型，把它当插件 UI 蓝本会更危险：

1. **假数据、假反馈**：`COMMITS` / `HUNKS` / diff 行全部写死，`toast()` 与 `addAct()` 只造视觉反馈，无数据通道、无状态机、无加载/错误/空态。可演示，不可验收。
2. **容器假设错误（最致命）**：三栏固定 `230px + 322px + flex`，占满 `100vh`，自带顶栏 / 分支 widget / 性能预算条，是「独立 Git 客户端」。而宿主中 Git 是 LeftPanel 的 activityBar 面板，**宽度钳位 200–600px**（`LeftPanel.tsx:56-59`）；`CenterStage.tsx:240-241` 更明确写着「git 工作台 tab 已下线（面板回归侧栏自适应宽度形态）」。三栏在 200px 下必然崩，在 600px 下也塞不下。
3. **原型自己否定了插件化**：`git-panel-prd.md` §1 裁定「面板位置**保持内置**……中央 `'git'`/`'diff'` Tab、编辑器 gutter 集成是插件面板宿主给不了的」。
4. **只画了面板，没画编辑器里的 Git**：gutter / blame hover / Alt+Up·Down 改动导航（3 个 CM6 扩展）、Chat `@git` 联想 / 上下文芯片、文件树状态徽章——这些恰是「功能不变」的另一半。
5. **AI 卡片假设了插件拿不到的能力**：原子提交、Review、冲突预测、AI 建议全部依赖 `kind` 作用域会话 + `oneTimeSystemPrompt` + 回流 hook；插件面板 props 实际只有 `{ pluginId, onSendToChat }`。

### 1.3 共同根因

两份原型都是「先把界面画出来，再假设底层能接上」。**没有先做宿主契约盘点**，导致一个落成玩具，一个落成不可能落地的图。因此本轮的正确顺序是：**先定四条宿主关系 → 再定数据通道 → 最后才画界面**，且原型必须是跑在真宿主里的可运行纵切，而不是静态 HTML。

---

## 2. 四条宿主关系逐条检查

### 2.1 工作区 🟡 已有 80%，补 3 项

**内置现状**
- `useGitActiveWorkspace.ts`：直接跟随 `workspaceStore.currentWorkspaceId`，无面板级切换；`GitPanel/index.tsx:65` 的 `effectivePath = selectedRepoPath ?? currentWorkspace?.path` 支持**多仓库**选择（`:539-636` 仓库扫描 / 置顶 / 空仓库态）。
- `stores/gitStore/fileWatcherSubscriber.ts`：监听 `file-system-change`，并订阅 `kernelSessionIsStreaming` 在 AI 流式输出期间抑制刷新（避免风暴）；`workspaceStore.ts:182` 发 `workspace-changed`，`main.tsx:86-89` 把路径写到全局。

**插件当前能拿到**
- `__POLARIS_WORKSPACE_API__`：`list()` / `currentId()` / `subscribe()`（`subscribe` 挂载时立即回调一次，能拿到初始值）→ **冷启动问题其实有解，旧原型没用**。
- `__POLARIS_THEME_API__`、`__POLARIS_HOST_WORKSPACE__`（有缺陷见下）。

**缺口**
1. `__POLARIS_HOST_WORKSPACE__` 初始 `''`、只靠事件更新、无订阅 → 冷启动读到空串；旧面板因此回退到手填路径。**应废弃该全局，统一走 `__POLARIS_WORKSPACE_API__`。**
2. `__POLARIS_HOST_LISTEN__` 未放行 `file-system-change` / `repo_touched` 等仓库事件（白名单式设计目前只针对 `chat-event` 做过滤，其他事件透传，需实测确认 Tauri `listen` 是否可用）；插件无法复刻「文件变更自动刷新 + 流式抑制」。
3. 多仓库扫描结果（当前工作区下的多个 git repo、置顶偏好）没有宿主 API；插件需自己实现，或宿主提供 `scm.listRepositories()`。
4. 工作区切换时 store 重置 / 缓存失效 / watcher 重绑，是插件自己的责任，但宿主需要给出**可订阅的规范化事件**（含 workspaceId，而非只有 path）。

**需要宿主同步提供**：把工作区上下文收进结构化 `PluginPanelProps`（见 §5 H1），补事件订阅白名单，废弃冷启动为空的全局。

### 2.2 AI 对话生成提交信息 🔴 最大缺口，必须新增

**内置现状**（`src/services/commitMessageChat.ts` / `atomicCommitChat.ts`）
- 不是 headless 一次性调用，而是**复用会话基建**：`sessionStoreManager` 新建/复用 `kind='commit-message'`（按 `commitWorkspaceId` 隔离）会话 → `sendMessage(userContent, workspacePath, …, { oneTimeSystemPrompt: COMMIT_MSG_SYSTEM_PROMPT })` → 用户可换引擎、可追问微调 → `useCommitMessageSuggestion` 用 `pickLatestAssistantText` + `useKernelSessionState` 把结果**回流**到 CommitInput。
- AI-2 原子提交同理：`kind='git-atomic'`，`ATOMIC_COMMIT_SYSTEM_PROMPT`，`useAtomicCommitSuggestion` 回流低置信组建议。
- 上下文构造依赖 `gitContextService`（`invoke('git_get_log' / 'git_get_worktree_diff' / 'git_get_index_diff' / 'git_get_status')`）+ `isAgenticEngine`（`engineMetadataStore` 后端权威元数据，双档注入防幻觉）。
- 另有 Chat 输入侧 `GitSuggestion.tsx`（`@git` / `@git diff` / `@git commit` / `@git log` / `@git branch` 联想）、`ContextChip.tsx`（commit/diff 上下文芯片）、`gitContextAiGuard`。

**插件当前能拿到**
- `onSendToChat(msg)`：`App.tsx:96-101` 实际就是 `void sendMessage(msg)` —— **发到当前活跃会话**，没有 kind 隔离、没有 oneTimeSystemPrompt、没有 workspace 锁定、没有指定会话、没有结果订阅。
- `__POLARIS_HOST_LISTEN__('chat-event', …)`：`main.tsx:61-66` **只透传 `contextId` 以 `mc-` 开头的信封**，且宿主没有提供给插件创建 `mc-` 命名空间会话的 API。
- `__POLARIS_SEND_TO_CHAT__` 同上，是降级兜底。
- `chatCards` 贡献点只能渲染 MCP 工具结果卡片，不解决「面板发起 AI 会话并回流」。

**不补的后果**：AI 提交信息 / 原子提交 / 冲突建议 / Review 门 / `@git` 联想全部降级或消失，直接违反 R1（功能不变）。这是四条里唯一「现有机制完全无法 workaround」的一条。

**需要宿主同步提供（最小 API）**
```
host.ai.createSession({ kind, workspaceId, workspacePath, systemPrompt }) -> sessionId
host.ai.send({ sessionId, content, oneTimeSystemPrompt, engineId? })
host.ai.subscribe(sessionId, cb) -> 最新 assistant 文本 / isStreaming / error
host.ai.listSessions({ kind, workspaceId })
host.ai.getEngineCapabilities(engineId)   // 替代 engineMetadataStore，双档注入要用
```
外加 Chat 输入注册点：`@` 联想 provider、上下文芯片 provider、commit/diff 上下文注入（现成的是 `chatCommandRouter` 斜杠命令，非注册式）。

> 设计约束：会话 kind 必须按插件 id 命名空间化（如 `plugin:polaris.git:commit-message`），防止插件伪造宿主 `kind`；回流文本只读，插件不得读主会话历史。

### 2.3 左侧板面板 🟢 现成范式，几乎不需要新增

**宿主已具备（且今天刚验证过）**
- `builtinPlugins.ts:29-37` 已把 `git.panel`（`panelType:'git'`, `slot:'git'`, `order:20`）作为**插件 view contribution** 注册 —— Git 面板早就走插件机制了，只是渲染的是内置组件。
- `registry.ts:344-388` 提供 `slotMode: 'append' | 'shadow' | 'chain'`；`LeftPanel.tsx:276-292` 实现 shadow 接管（内置席位改渲染插件面板，tab strip 不变，禁用/卸载即回内置 = 天然回滚），`registry.ts:357-377` 有「目标 view 拆除后自愈为独立入口」语义。
- `terminal-desk` 插件（2026-11-11 交付）**已跑通完整范式**：`slot:'terminal.panel'` + `slotMode:'shadow'` + 自包含 `dist/panel.js` + `contributes.styles`（主题 CSS 变量 `rgb(var(--c-*))`，禁硬编码色值）+ MCP。Git 插件直接照抄这份 manifest 结构即可，不要重新发明。
- `PluginPanelHost` 有错误边界 / 重试 / `data-plugin-scope` 样式作用域；`LeftPanel` 保活（children 不卸载），宽度钳位 200–600px，compact 抽屉形态。

**唯一需要处理的三件小事**
1. **席位裁定**：shadow 要求「被接管的内建 view 仍在」。若按 R3 真删 `git.panel` 定义，shadow 会自愈成独立入口——这本身可用，但 `panelType:'git'` 与 `viewStore.panelStates['git']`（`viewStore.ts:177,209`）的记忆、工具切换器描述（`toolSwitcherData.tsx:19`）会错位。**建议：保留 `git.panel` 这个 view 契约/座位与 `panelStates['git']`，只删内置面板实现**（组件、store、服务），让插件以同 `panelType` 直接占位。这样 tab strip / 快捷键 / 宽度记忆 / 工具切换器零改动。
2. `supportsFullscreen` manifest 有字段但**前端未消费**（只在 `LeftPanel.tsx:53,154` 有 `fullscreen` prop，插件面板未接通）。三方合并器 / Rebase TODO 等宽视图需要它。
3. `schema.ts:116` 的 `contributes` 是 `z.record(z.string(), z.unknown())`，无强校验；新增扩展点应同步补 schema（前后端镜像纪律，AGENTS.md §4.1）。

### 2.4 编辑器面板 🔴 最硬交界，必须新增契约

**内置现状**
- `plugin-system/editor/index.ts:66` 由 `registerGitEditorExtensions()` 把 `gitGutter` / `gitBlameHover` / `gitChangeNavigator` 注册进 `editorExtensionRegistry`；`Editor.tsx:413-418` 在创建 CM6 实例时 `collectExtensions(filePath)` 同步收集。
- 数据来自 `services/gitEditorService.ts`（status 1.5s TTL / blame 60s TTL 缓存，4 个 `git_*` 调用）。
- `components/Diff/DiffViewer` 被 12 处引用：`CenterStage.tsx` 中央 diff tab（`:213-241` 刷新时还直接 `await import('@/stores/gitStore')`）、`Editor/NarrowTabOverlay.tsx:26-30`（窄窗口 diff，还用 `useTranslation('git')`）、Chat `InlineDiffView` / `PatchDiffRenderer`、`utils/patchParser.ts`、`narrowTabStore.ts` 等。

**缺口**
1. `editorExtensionRegistry` **没有 manifest 贡献点、没有 window 暴露**——全仓只有主仓内部那一处 `register()`。外部插件 bundle 无法贡献 CM6 Extension，gutter/blame/导航三项能力无处挂载。
2. `pluginTabRendererRegistry` 同样只是内部 Map，无外部注册通道 → 插件无法注册中央 diff / blame / history graph / 三方合并器 Tab。
3. 无插件 Overlay / Portal 契约；`supportsFullscreen` 未接通 → 宽视图（合并器、Rebase TODO、Push 对话框）在 200–600px 侧栏里放不下。
4. **DiffViewer 归属必须先裁定**：它被 Chat patch、窄窗口 diff、中央 tab 复用，且这些都在宿主侧。若随 Git 域一起删，宿主这些位置会断；若保留在宿主，插件又不能 `import '@/components/Diff'`。→ **建议把 DiffViewer 定位为宿主通用渲染能力**（通过 `host.ui.openDiffTab()` 或插件贡献 Tab 渲染器复用），而不是「Git 功能」随域迁出。这也回答了需求文档 §4 第 5 问。

**需要宿主同步提供**：声明式 `contributes.editorExtensions`、`contributes.tabRenderers`、Overlay/全屏契约、`host.ui` 通用能力（diff 渲染 / 打开文件 / 打开 Tab）。

---

## 3. 数据通道：一个能同时缓解四条的前提

**关键实测**：`HOST_INVOKE_ALLOWLIST` 含 `router_dispatch` / `router_dispatch_stream`；`commands/router.rs:73-84` 的 `Source` 由 `resolve_ipc_source(webview.label())` 注入（主窗口 = `Bootstrap`，前端不可自填）；`git_capability.rs:18-19` 只拒绝 `Source::Plugin` 的写类动作，`Bootstrap` 与 `Remote` 放行。

因此插件面板可以走：

```
插件 panel.js
  → __POLARIS_HOST_INVOKE__('router_dispatch',
        { req: { target:'cap.git', payload:{ action:'get_status', workspacePath } } })
  → cap.git（权限 gate / 审计流水 / WRITE_GATE 写串行 / taskId 长任务 / Web 桥）
  → GitService(git2)
```

好处：UI 与 AI 同源、复用宿主 git2 引擎（**不必重写 Node git CLI，功能等价风险大幅下降**）、Web-only 通道天然可用、权限与审计链不中断。旧原型「绕过总线直调内部 API」的病根一次性治掉。

**但这引出一个必须由用户裁定的边界**：若保留 `cap.git` + `services/git/`，「删除内置 Git 与版本管理」删的是什么？

| 解释 | 删除范围 | R1 可行性 |
|---|---|---|
| **A（建议）**：`cap.git` 重定义为「宿主提供的 SCM 插件运行时能力」，不算 Git 功能 | 删前端 UI / store / services / 编辑器装配 / 内置 Tab 分支 / 宿主硬编码字面量；保留后端能力与其 API 契约 | 高，可逐项回归 |
| **B（严格）**：连 `cap.git` + `services/git/`（git2 引擎）一起删 | 插件必须自带引擎（Node 调 git CLI 或独立 Rust 进程） | 低：50+ action 的 porcelain 行为对齐、rebase/冲突/lane graph/undo 等价、Web 端可用性与性能都无保证 |

需求 R3 说的是「删除内置的 Git 与版本管理」，本文不替用户裁定 A/B；但**必须在画原型前定**，因为它决定数据通道、也决定 §2.2 的 AI 上下文由谁提供。

---

## 4. 新 UI 原型设计

### 4.1 第一条原则：不再做静态 HTML 原型

新原型必须是**跑在真实宿主里的可运行纵切（thin vertical slice）**，用来证明「形态可行」，而不是重画一遍漂亮图：

- 真插件包（`plugin.json` + 自包含 `dist/panel.js`），装到真 Polaris；
- 真数据（走 §3 的 `cap.git`，不写死任何 commit / diff）；
- 真容器（LeftPanel 宽度 200 / 360 / 600px 三档 + compact 抽屉）；
- 真主题（切主题验收）、真工作区切换（切换后自动重绑）；
- 一个完整闭环：**状态 → 变更列表 → diff → stage → commit**（含加载 / 错误 / 空态）。

### 4.2 四层承载，而不是三栏平铺

| 层 | 承载内容 | 宿主契约 | 状态 |
|---|---|---|---|
| **L1 侧栏主面板**（200–600px） | 单列：可横向滚动的 7 Tab strip + Changes 默认页 + 底部提交条 | `views` + `panel` + `slot`（现成） | ✅ |
| **L2 中央工作台 Tab**（宽视图） | diff / blame / history lane graph / 三方合并器 / Rebase TODO | `contributes.tabRenderers` + `host.ui.openDiffTab` | ❌ 需新增 |
| **L3 编辑器内嵌** | gutter 标记 / blame hover / Alt+Up·Down 改动导航 / 窄窗口 diff | `contributes.editorExtensions` + 宿主通用 DiffViewer | ❌ 需新增 |
| **L4 Chat / 文件树** | AI 提交信息会话 / 原子提交 / `@git` 联想 / 上下文芯片 / 状态徽章 | `host.ai.*` + Chat 输入注册点 + `fileExplorerToolbarSlot` | ❌ / ✅ 混合 |

**布局按可用宽度断点自适应（取代固定三栏）**

| 宽度 | 形态 |
|---|---|
| < 280px | 图标 tab strip、单行文件项、详情走抽屉、无内联 diff |
| 280–420px | 单列 + 底部提交条 + 弹出式详情；diff 一键「放大到中央 Tab」 |
| > 420px | 单列主区 + **可折叠**详情侧栏（不是独立 322px 固定栏） |
| fullscreen / 中央 Tab | 才允许接近旧原型的三栏 Workbench |

> 内置 `GitPanel/index.tsx:805-845` 的 7 Tab strip 已经是「单列 + 横向滚动 tab」形态并验证过，**新原型应延续它，而不是回到 vNext 的三栏**。R2「做得更好」建议落在「插件独立发版 / 热更新 / 不影响宿主」，而不是重做视觉布局。

### 4.3 功能等价映射（R1 回归清单的 UI 部分）

| 内置 UI 面 | 插件承载 | 依赖宿主支持 |
|---|---|---|
| 7 个 Tab（changes/history/branch/remote/tags/stash/gitignore） | L1 主面板 | 现成 |
| DiffViewer（split/unified、worker、字级、窗口化、行级选区 stage） | 插件 bundle 自包含 + L2 中央 tab | 需 `tabRenderers`；宿主侧复用需 `host.ui` |
| 冲突三方合并器 / Rebase TODO / Push / Branch 等对话框 | 插件自绘 + Overlay / 全屏 | 需接通 `supportsFullscreen` + overlay 契约 |
| gutter / blame hover / change navigator | L3 CM6 扩展 | 需 `editorExtensions` |
| 文件树 `GitStatusIndicator` 徽章 | `fileExplorerToolbarSlot` | ✅ 现成（P0-5） |
| AI 提交信息 / 原子提交 / Review / 冲突建议 | `host.ai.*` | 需新增 |
| `@git` 联想 / commit·diff 上下文芯片 | Chat 输入注册点 | 需新增 |
| i18n / 主题 | CSS 变量 `rgb(var(--c-*))` + 插件自带文案 bundle | 需约定（禁用硬编码色值，照抄 terminal-desk） |
| 文件监听自动刷新 + 流式抑制 | 插件自订阅仓库事件 | 需事件白名单 |
| Undo / OperationsLog / 快照 | 插件自存（cap.kv 或插件 service） | 现成 |

### 4.4 原型范围（建议的 P1 纵切）

只做一条闭环，且**每个环节都验证一条宿主关系**：
- 工作区：冷启动自动绑定 + 切换工作区后重绑（验证 §2.1）
- 左栏：`slot:'git.panel'` + `slotMode:'shadow'` 接管原席位（验证 §2.3）
- 数据：`router_dispatch → cap.git` 读 status / diff / stage / commit（验证 §3）
- AI：一个「生成提交信息」按钮走 `host.ai.*`（验证 §2.2，需宿主先给 H2）
- 编辑器：一条 gutter 标记（验证 §2.4，需宿主先给 H3）

**只有当这五条全部在真宿主里跑通，才进入逐 Tab 搬迁。**

---

## 5. 宿主支持增量清单（按优先级，供评审排期）

| # | 增量 | 落点 | 服务的关系 | 优先级 |
|---|---|---|---|---|
| **H1** | 结构化 `PluginPanelProps`：`workspace`（含 subscribe / 冷启动快照）、`theme`、`i18n`、`capDispatch`（封装 `router_dispatch`，按插件权限 gate）；废弃冷启动为空的 `__POLARIS_HOST_WORKSPACE__` | `PluginPanelHost.tsx` / `plugin-system/types.ts` / `main.tsx` | ① 工作区 | P0 |
| **H2** | `host.ai.*` 会话 API（kind 命名空间化 / oneTimeSystemPrompt / 回流订阅 / engineCapabilities）+ Chat 输入注册点（`@` 联想、上下文芯片） | 新增 `plugin-system/hostAiApi.ts`；`ChatInput.tsx` 注册点 | ② AI 提交信息 | **P0（阻塞 R1）** |
| **H3** | `contributes.editorExtensions`：声明式 CM6 扩展工厂，宿主负责装载 / 卸载 / 错误隔离 / 热重载 | `schema.ts` + `editorExtensionRegistry.ts` + `pluginDiscoveryService.ts` | ④ 编辑器 | P0 |
| **H4** | `contributes.tabRenderers` + 接通 `supportsFullscreen` + Overlay/Portal 契约 | `pluginTabRendererRegistry.ts` / `CenterStage.tsx` / `LeftPanel.tsx` | ④ 编辑器 · ③ 左栏 | P1 |
| **H5** | 插件事件订阅白名单（`file-system-change` / `repo_touched` / git 长任务 progress）+ 规范化 `workspace-changed`（带 workspaceId） | `main.tsx` 桥 / `eventBus.ts` | ① 工作区 | P1 |
| **H6** | `DiffViewer` 定位为宿主通用渲染能力 + `host.ui.openDiffTab/openFile`；`schema.ts` contributes 深度校验补齐（前后端镜像） | `components/Diff/` 归属裁定 + `schema.ts` | ④ 编辑器 | P1（删码前必须定） |

> H2/H3 是**硬阻塞**：不做，AI 提交信息与编辑器 Git 标记无法在插件形态下等价；H1/H5 是体验与稳定性；H4/H6 是宽视图与删码边界。
> 好消息：③ 左栏零新增；`terminal-desk`（2026-11-11）已把 manifest 结构、shadow 接管、主题 CSS 变量、样式作用域全部趟通，Git 插件照抄即可。

---

## 6. 原型验收口径（杜绝「假数据原型」重演）

1. 插件包可从 `index.json` 安装 / 热更新 / 禁用回滚，宿主不重启。
2. 冷启动自动绑定当前工作区（不出现路径输入框）；切换工作区后面板 1s 内重绑，缓存与 watcher 正确重挂。
3. 200 / 360 / 600px 三档 + compact 抽屉无横向溢出、无遮挡、无组件错位；tab strip 可滚动。
4. status → diff → stage → commit 闭环全程真数据；加载 / 错误 / 空 / 冲突态均有真实表现；写操作经 `cap.git` 审计流水可查。
5. 「生成提交信息」在独立 kind 会话中产出、可追问、可一键回流到 CommitInput；AI 不可用时 Git 面板完整可用（断路设计）。
6. 打开文件可见 gutter 标记、blame hover、Alt+Up/Down 导航；窄窗口 diff 不降级。
7. 切换明暗主题后面板色值随 CSS 变量变化，无硬编码色；文案随插件自带 i18n 切换。
8. 桌面端与 Web-only 端均可用；若 Web 端有缺项，显式列出，不以「功能不变」掩盖。

---

## 7. 待用户裁定

1. **删除边界 A / B**（§3）：`cap.git` + `services/git/` 是否算「内置 Git」一并删除？A 保留为宿主 SCM 能力（建议，R1 可达）；B 连引擎一起删（插件自带引擎，R1 风险高）。**此项决定原型数据通道，需最先定。**
2. **AI 会话 API 是否由宿主提供**（§2.2 / H2）：若不做，需接受「AI 提交信息降级」并明确写入 R1 例外——但这与「功能不变甚至更好」冲突。
3. **编辑器扩展契约形态**（§2.4 / H3）：插件贡献 CM6 Extension 工厂，还是宿主保留薄实现、插件只供数据？前者更彻底，后者改动小但仍有内置残留。
4. **DiffViewer 归属**（§2.4 / H6）：定位为宿主通用渲染能力（建议）还是随域迁出（会断 Chat patch / 窄窗口 / 中央 tab）。
5. **原型形态**：确认先做「真宿主可运行纵切」而非静态 HTML 线框；并确认与 R6 欠账、B2-1 电台 L1 的排期关系。

---

## 8. 状态与文档关系

- 本文只做**分析与缺口盘点**，不推翻 `core-slimdown-plugin-extraction-plan.md` §4.3 的不拆定案，也不构成实施授权。
- 需求登记见 `plans/git-domain-plugin-extraction-requirement.md`；其 §4 六问中，**第 1 问（cap.git 归属）细化为本文件 §3 / §7.1，第 2 问（编辑器扩展点）细化为 §2.4 / H3，第 3 问（面板自包含）由 `terminal-desk` 现成范式部分回答，第 5 问（DiffViewer 归属）细化为 §2.4 / H6**。新增第 7 问（AI 会话契约）见 §2.2 / H2。
- 评审通过后，应按 core-slimdown §9 补**独立实施 spec**（宿主契约增量 → 可运行纵切原型 → 逐 Tab 搬迁 → 主仓删码 → 文档同步），再单项 commit 落地。
