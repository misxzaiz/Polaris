# terminal-desk 插件优化与内置终端移除规划

> 日期：2026-11-11 · 状态：**规划定案，待评审批准；未修改任何代码 / 插件 / 配置 / 提交**
> 上位文档：`plans/terminal-plugin-spec.md`（2026-11-10 四阶段方案）、`plans/terminal-desk-gap-analysis.md`（2026-11-11 差距证据）、`plans/terminal-panel-refactor-prototype.html`（v4 视觉基线）、`AGENTS.md` §五（功能路由）与 §九（拆分须克制）。
> 本文件是**终端插件化后续工作的唯一执行规划**；与 `terminal-plugin-spec.md` §六/§七 不一致处，以本文件为准（已在 spec 头部加注记）。

---

## 0. 六条定案（本轮要确定的内容）

| # | 定案 | 依据 / 否决了什么 |
|---|---|---|
| **D1** | 目标 = **功能等价零降级 + 视觉对齐 v4 基线 + 插件成为唯一终端实现**。内置终端移除的是 **UI 实现、store、前端装配与旧命令层**，不是终端能力本身。 | 用户「样式丑且功能未完全」+ 需求「功能不变甚至更好」；`terminal-desk-gap-analysis.md` §3 F1–F11 |
| **D2** | 采用 **边界 A**：保留 `cap.terminal` + `commands/terminal.rs` 的 PTY 核心（TerminalManager / TerminalEventSink / global sink / `open_in_external_impl`）+ `terminal_script.rs` 的 `discover_scripts_in_workspace` 作为**宿主终端运行时能力**。**否决边界 B**（连引擎一起删、插件自带 PTY）。 | `terminal_capability.rs:42,74,184,253` 直接复用这些类型；插件内 PTY 需平台二进制且 Web 端不可用（spec §十）；删除 50+ 动作等价与双端能力无保证 |
| **D3** | **保留 `terminal.panel` 席位契约**（方案 S），仅把席位内容换成「未安装/未启用插件」的空态引导卡；插件继续以 `slot:'terminal.panel'` + `slotMode:'shadow'` 接管。**否决** spec §七「移除 shadow、改回独立视图」。 | `LeftPanel.tsx:275-290` 的 shadow 消费要求 `target.panelType in builtinPanels`；若删席位，`ToolSwitcher.tsx:39` PINNED、`LeftPanelTabStrip.tsx` 固定 tab、`viewStore.ts:138` 宽度记忆、`App.tsx` 全屏布局、用户 pin 记忆全部要迁移，属可避免的功能降级 |
| **D4** | 职责切分：**宿主**负责 PTY、主题 tokens、席位与全屏、快捷键分发、旧数据导出；**插件**负责 UI、脚本管理、搜索/分屏、MCP、渲染性能。禁止插件内另建第二套 PTY / 另一套脚本存储 / 直调 `terminal_*` 命令。 | 呼应 2026-08 `polaris-git` 直调已摘除命令而成为死代码的教训 |
| **D5** | 分期 **P0 止损 → P1 视觉 → P2 功能等价 → P3 数据迁移 → P4 影子运行 → P5 摘装配 → P6 删实现 → P7 收尾**；每阶段有独立门禁与硬停点，未过门禁不得进入下一阶段。 | spec §三 四阶段只走到 B，C 完成 1/3、D 未做 |
| **D6** | 提交纪律：一次提交只做一件事；**宿主增量 / 插件实现 / 主仓删装配 / 主仓删实现分属不同 commit**，删除 commit 可独立 revert；两仓分别提交；**禁止保留可运行的内置终端作为隐藏兜底**。P4→P5 是回滚能力从「禁用插件」变成「revert commit」的分界。 | AGENTS.md §五/§九；Git 域需求文档的同一纪律 |

> **优先级铁律**：插件未达到 §7 的 R1 零降级验收前，**不启动 P5/P6 任何删码动作**。当前 `enabledByDefault:true` + shadow 接管让半成品成为默认体验，必须先止损。

---

## 1. 现状基线（不重复差距分析，仅索引）

- 已完成：`cap.terminal` 桌面 `lib.rs:648` / Web `lib.rs:1467` 双端注册、全局 sink、`router_dispatch` 与 `plugin_*_config` 白名单、`LeftPanel` shadow 消费、`terminal-desk` v0.2.2（WebGL / 搜索 / 分屏 / stdio MCP）。
- 未完成：`terminal-plugin-spec.md` 阶段 C 的「优化三步走」仅完成 WebGL 一项；阶段 D 完全未做。
- 差距证据：`terminal-desk-gap-analysis.md` —— 样式 S1–S7（S1 三个主题 token 不存在、S2 纯白 1px 边框为可证伪规则错误）、功能 F1–F13（F1–F10 为等价欠账，F12/F13 是未批准提案，不排期）。
- 可删除体量（前端）：`src/components/Terminal/` 6 文件 **1,242 行** + `src/stores/terminalStore.ts` **531 行** + `src/types/terminal.ts` **51 行**；`@xterm/*` 3 个依赖。后端删的是命令包装层，PTY 核心保留。
- 引用面共 29 个前端文件含 `terminal` 字样，其中仅约 14 个是真实装配依赖，其余是语义关键词或类型兼容（见 §4 清单）。

---

## 2. 插件优化方案（Polaris-plugin 仓）

所有改动落在 `D:\space\base\Polaris-plugin\plugins\terminal-desk/`。**改 `src/styles.css` 后必须跑 `pnpm build`**（`scripts/build.mjs` 把 CSS 同步进 `plugin.json` 内联并重打 `dist/panel.js`）并重新打 zip，否则线上仍是旧样式。

### O1 · 样式止损（P0/P1，最高性价比）

| 动作 | 落点 | 验收 |
|---|---|---|
| 修 3 个不存在的 token：`--c-bg-subtle` → 按 `src/index.css:30-48` 实测定义选 `--c-bg-elevated`/`--c-bg-surface`；`--c-danger` → `--c-status-danger`；`--c-success` → `--c-status-success` | `src/styles.css`（`.td-tabbar:21` / `.td-drawer:149` / `.td-exitbanner:126` / `.td-errorbar:138` 等） | 脚本校验：插件 CSS 中所有 `var(--c-*)` 名均能在主仓 `src/index.css` 找到定义；明暗主题下四处区域有底色 |
| 所有 `--c-border` 补 alpha（`/ 0.08`~`/ 0.25`，对齐宿主 `index.css:282,445,1173,1712`） | `src/styles.css` 10+ 处 | 暗色主题无纯白描边；与内置 `border-border` 观感一致 |
| xterm 字体栈补 `SF Mono / Menlo / DejaVu Sans Mono`，补 `lineHeight:1.2` 与 `cursorStyle:'block'`；`.td-session` padding 对齐内置 `w-full h-full` | `src/SessionView.tsx:48-54`、`src/styles.css:110` | 字符网格与内置逐像素对比无偏移 |
| 遮罩/阴影改主题 token（去掉 `rgba(0,0,0,.45/.35)`） | `src/styles.css:249,261` | 浅色主题无重黑遮罩 |
| 图标 Unicode `＋ ⿴ ▶ ▴ ✕` → lucide（`Plus`/`X`/`Maximize2`/`Play` 等，14/16px、36×36 命中区） | `src/Panel.tsx:271-293`、搜索条 `:224` | 图标基线对齐、命中区统一 |

> O1 属**规则错误修复**，不是审美调整，禁止以「先补齐功能再说」为由延后。

### O2 · 布局重排到 v4 基线（P1）

按 `plans/terminal-panel-refactor-prototype.html` 的真实布局重排 `src/Panel.tsx` / `ScriptDrawer.tsx`：

1. **常驻 QuickRunBar（36px）**：名称 / 命令 / 运行状态 / 运行 / 停止 / 快速运行，数据来自脚本表与 runtime 表。
2. **脚本区回到顶部可折叠**（替代底部固定 256px 抽屉），折叠态持久化到宿主 `viewStore`（复用 `terminalScriptPanelCollapsed` 字段）或插件配置，禁止仅组件内 `useState`。
3. **Tab 栏**：36px 高、min 100 / max 200px、图标 + 运行状态/退出码徽标、右侧全屏按钮（依赖 H1）。
4. **空态**：48px 图标 + 提示文案，替代单行文字。
5. **信息密度**：36px 基准高度 + `--c-status-*` 状态色分层 + 三级文本层次，替代 10–13px 全平铺。

### O3 · 功能等价（P2，对应差距表 F1–F10）

| 编号 | 补齐项 | 实现约束 |
|---|---|---|
| O3-1 | F1 快捷运行条 | 见 O2-1；`stopScript` 语义 = `close`（与内置 `terminalStore.ts:456-466` 一致，**不是**写 Ctrl+C；spec §五 此处表述有误，一并订正） |
| O3-2 | F2 Tab 右键菜单 | 关闭 / 重命名 / 重跑 / 复制命令；重命名必须经 H3 回传宿主，禁止 `nameOverrides` 仅前端覆盖 |
| O3-3 | F3 脚本右键菜单 | 编辑 / 隐藏项目脚本 / 恢复隐藏 / 删除 / 在外部系统终端运行 |
| O3-4 | F4 全屏 | 依赖 H1；ESC 退出、面板内相对定位遮罩（参见 `LeftPanel.tsx:319` 注释） |
| O3-5 | F5 脚本编辑与隐藏恢复 | 插件脚本模型需扩展 `enabled` / `source` / `tags` / `hiddenDiscoveredScriptIds`（见 P3 字段映射） |
| O3-6 | F6 自动运行触发器 | `app_start` / `workspace_open` / `terminal_open` 三档 + `confirmBeforeAutoRun`，依赖 H4 事件桥 |
| O3-7 | F7 外部终端运行 | 调用 `cap.terminal open_in_external`（宿主已提供，Web-only 返回明确错误并禁用该菜单项） |
| O3-8 | F8 数据兼容 | 见 P3 / H2；按 `workspaceId` 分桶，禁止全局混放 |
| O3-9 | F9 会话恢复 | 挂载先 `cap.terminal list` 重建会话表并 attach，再决定是否 `create`；禁止「挂载即 create」产生孤儿 PTY |
| O3-10 | F10 重命名持久化 | 依赖 H3；重挂后名称不丢 |

**必须保留、修复时不得回退**：WebGL + canvas 降级、Ctrl+F 搜索、左右分屏、stdio MCP 三工具、`scrollback 10000`、独立发版 / 热更新。

### O4 · 性能补完（P2，F11 剩余 2/3）

- 批量输出解码：`shared/td-core.js` 的 `decodeBase64ToBytes` 去掉逐字节 `for` 循环，改 `Uint8Array.from(binary, c => c.charCodeAt(0))` 一次性构造；批量 chunk 合并后单次 `xterm.write`。
- resize：100ms + 每次 `fit&resize` → 60ms 去抖 + 拖拽中只 `fit`、松手才 `resize`（v4 基线）。
- 预算：大输出（≥1MB）不掉帧、首次提示符 ≤1s、resize 跟手无可感跳变；禁止引入固定轮询或全量 Tab 刷新。

### O5 · 测试与构建

- `test/model-tests.mjs` 增：脚本字段映射、迁移幂等、会话 reconcile（list→attach）、autoRun 三触发器、危险命令确认。
- 新增 `test/styles-check.mjs`：静态校验 CSS token 名存在性与 `--c-border` alpha 覆盖率。
- 每次交付跑 `pnpm build` + `pnpm typecheck` + `pnpm test`，并核对 `plugin.json` 内联 CSS 与 `src/styles.css` 逐字一致、`dist/panel.js` 含最新代码。

---

## 3. 宿主增量清单（主仓，H1–H5）

> 全部由主仓提供，**禁止在插件内 workaround**。落点文件为规划定位，实施前重新 grep 复核行号。

| # | 增量 | 主仓落点 | 对应差距 | 阻塞级别 |
|---|---|---|---|---|
| **H1** | 消费 `panel.supportsFullscreen`：`PluginPanelHost` 提供全屏按钮，把 `viewStore.terminalFullscreen` 通用化为「当前激活面板全屏」（保留旧字段名兼容持久化），`App.tsx:280,380,384` 三处布局条件改按该通用状态判断 | `src/components/plugins/PluginPanelHost.tsx`、`src/stores/viewStore.ts:52,93,312`、`src/App.tsx` | F4 / S3 | P2 |
| **H2** | `cap.terminal` 增 `export_saved_scripts` action：一次性读 `config_store.terminal_scripts`，返回按工作区路径分组的脚本与 `hiddenDiscoveredScriptIds`；**只读，不修改、不删除旧字段** | `src-tauri/src/services/router/terminal_capability.rs`（`with_state(Arc<AppState>)` 已可访问 config） | F8 | P3 |
| **H3** | `cap.terminal` 增 `rename` action + `TerminalManager::rename_session`，`list`/`get` 结果稳定携带 `name` | `terminal_capability.rs`、`src-tauri/src/commands/terminal.rs` | F10 | P2 |
| **H4** | 放行 `workspace-changed` / `app_start` 类事件到插件可订阅通道，供 autoRun 三触发器使用；**不得改变 `__POLARIS_HOST_LISTEN__` 现有事件过滤语义**，若已有可用通道则只补文档与示例 | `src/main.tsx:116-130`、`src/plugin-system/hostWorkspaceApi.ts`、`src/services/eventBus.ts` | F6 / spec §六 已知边界 | P2 |
| **H5** | 席位空态与快捷键迁移：新增 `TerminalSlotEmpty` 引导卡（仅提示启用/安装插件 + 跳转按钮，**不含任何终端功能**）；删除 `useWindowManager.ts:79-80` 的 `terminal:open-runner` emit 与 `eventBus.ts:37,39` 两个事件；全局 Ctrl+Shift+R 改由插件面板自管（spec §六 已定） | `src/App.tsx:50,318`、`src/hooks/useWindowManager.ts`、`src/services/eventBus.ts`、新增 `src/components/Layout/TerminalSlotEmpty.tsx` | D3 / 席位契约 | **P5** |

> H1 是「宿主声明了 `supportsFullscreen` 却无消费点」的既有欠账（`plugin-system/types.ts:107` 仅定义字段）；H5 的空态卡是**插件生态标准空态**，不是隐藏兜底，禁止在其中保留可运行的内置终端。

---

## 4. 内置终端移除方案（逐文件三类清单）

**处置图例**：🗑 删除 / ✏️ 修改（保留契约） / ✅ 保留（不随域删除）。行号以拆除前重新 grep 为准。

### 4.1 前端 — 删除

| 文件 | 行数 | 说明 |
|---|---:|---|
| `src/components/Terminal/`（6 文件：TerminalPanel 431 / TerminalScriptPanel 410 / TerminalRunCommandModal 143 / TerminalScriptContextMenu 99 / TerminalTabContextMenu 80 / TerminalQuickRunBar 79） | 1,242 | 内置 UI 全量 |
| `src/stores/terminalStore.ts` | 531 | 会话 + 脚本 store |
| `src/types/terminal.ts` | 51 | 仅内置组件与 store 引用；`types/index.ts:13` 的 export 一并删 |
| `src/stores/index.ts:33` | 1 | `useTerminalStore` 导出 |
| `package.json` 的 `@xterm/xterm` / `@xterm/addon-fit` / `@xterm/addon-web-links` | — | 主仓唯一使用方是 TerminalPanel；插件自行 bundle xterm，不受影响 |
| `src/utils/` 中若无他用的终端专属工具 | — | 拆除前逐个 grep 确认 |

### 4.2 前端 — 修改（保留席位契约，D3）

| 文件 | 改动 |
|---|---|
| `src/App.tsx:50,318` | `TerminalPanel` lazy import → `TerminalSlotEmpty` 引导卡；**保留** `:177,280,360,380,384` 的 `terminalFullscreen` 布局逻辑（按 H1 通用化） |
| `src/plugin-system/builtinPlugins.ts:59-66` | **保留** `terminal.panel` 视图定义（id / panelType / icon / labelKey / order / slot 全部不动） |
| `src/components/Layout/LeftPanel.tsx:223,243,266,275-343` | **保留** `terminalContent` prop 与 shadow 裁决；仅内容源换成引导卡 |
| `src/components/Layout/ToolSwitcher.tsx:39,48`、`LeftPanelTabStrip.tsx` | **保留** PINNED `terminal` 与固定 tab、图标映射 |
| `src/stores/viewStore.ts` | **保留** `panelStates.terminal` 宽度记忆与 `terminalFullscreen`；`terminalScriptPanelCollapsed` 由插件复用或按兼容策略保留 |
| `src/hooks/useAppInit.ts:20,258`、`useAppEvents.ts:19,166,185` | 删 `runAutoScripts` / `initScriptEventListeners` 调用（能力由插件 + H4 承接） |
| `src/hooks/useWindowManager.ts:79-80` | 删 `terminal:open-runner` 分支（H5） |
| `src/services/eventBus.ts:37,39` | 删 `terminal:open-runner` 与 `terminal-output` 两个事件（唯一消费者是内置 store/panel） |
| `src/types/index.ts:13,14` | 删 `export * from './terminal'`；**保留** `terminalScript` export（`types/config.ts:8` 依赖 `WorkspaceTerminalScripts`） |
| `src/types/config.ts:370` | **保留** `terminalScripts?` 字段（存量 config.json 只读兼容，不再有前端消费者） |
| `src/locales/{zh-CN,en-US}/common.json` | **保留** `labels.terminalPanel`（席位仍存在），空态卡新增文案 |
| 测试 `viewStore.test.ts` / `ToolSwitcher.test.tsx` | 按保留的席位断言调整，禁止为通过测试而删除席位 |

### 4.3 前端 — 通用化救出（禁止随域删除）

| 文件 | 复用方 |
|---|---|
| `src/utils/ansiToHtml.ts` | `src/components/Chat/chatBlocks/ToolCallBlockRenderer.tsx:32,249`（Bash 工具输出着色）——**与 Git 的 DiffViewer 同类，属宿主通用渲染能力** |
| `src/types/terminalScript.ts` | `src/types/config.ts:8` 的 `WorkspaceTerminalScripts` 类型 |
| `src/components/Chat/dynamic-island/useRuntimeSummary.ts` | 8 处 `terminal` 是进度文本启发式关键词，**非依赖**，不动 |

### 4.4 后端 — 删除（命令包装层）

| 位置 | 内容 |
|---|---|
| `src-tauri/src/lib.rs:74-80` | `commands::terminal::{terminal_create,...}` 与 `terminal_script::terminal_discover_scripts` 的 import（sink 注入用全路径，不受影响） |
| `src-tauri/src/lib.rs:1186-1193` | `generate_handler!` 中 8 个 `terminal_*` 命令 |
| `src-tauri/src/web/api/ipc.rs:281-289` | 9 个 `"terminal_*" => dispatch_terminal_*` arm |
| `src-tauri/src/web/api/ipc.rs:1274-1378` | `dispatch_terminal_*` 函数组（**保留** `optional_string` / `u16` / `string_map` 等共用 helpers） |
| `src-tauri/src/commands/terminal.rs` | 8 个 `#[tauri::command]` 包装函数（`terminal_create/write/resize/close/list/get/open_in_external`） |
| `src-tauri/src/commands/terminal_script.rs` | `terminal_discover_scripts` 命令包装（保留 `discover_scripts_in_workspace`） |
| `src-tauri/src/web/integration_tests.rs:493,511` | 两个旧 REST 端点用例改为断言 `cap.terminal` 经 `/api/router-dispatch` 可达；若存在独立路由注册则一并删除（拆除前 grep `/api/terminal-` 复核） |

### 4.5 后端 — 必须保留（宿主终端运行时，D2）

- `src-tauri/src/commands/terminal.rs`：`TerminalManager`、`TerminalSession`、`TerminalEventSink`、`set_global_terminal_sink` / `global_terminal_sink`、`open_in_external_impl`、读线程与 base64 事件协议。
- `src-tauri/src/services/router/terminal_capability.rs` 全部（含 H2/H3 新增 action）、`mod.rs` 注册。
- `src-tauri/src/commands/terminal_script.rs::discover_scripts_in_workspace`。
- `src-tauri/src/lib.rs:614-615,648,1440-1441,1467`：sink 注入与 cap 注册（桌面 Dual / Web）。
- `src-tauri/src/state.rs:12,252,712,795`：`AppState.terminal_manager` 及 `clone_for_web` 的 fresh manager（双轨期会话分池，P5 后仍是唯一池）。
- `src-tauri/src/models/config.rs:1521,1681`：`terminal_scripts` 字段 + `serde(default)`，**永久保留**，仅用于存量 config.json 与 H2 一次性导出。
- `src-tauri/src/services/config_store.rs:1019`、Web integration test 的 `test_app()` 构造。

### 4.6 拆除后 grep 断言（spec §九 细化）

```
grep -r "terminalStore|@/components/Terminal|terminal_create|terminal_write|terminal_resize|terminal_close|terminal_discover_scripts|terminal_open_in_external" src src-tauri/src
→ 仅允许命中：cap.terminal 链路、config 兼容字段、历史文档/测试断言字符串
grep -r "@xterm" src → 0 命中
grep -r "terminal:output|terminal:exit" src → 允许（宿主事件协议，插件订阅）
```

### 4.7 保留项的调用链证据（为什么「不能删」）

> 上一版只给了结论，本节给出逐项可复核的使用链。**拆除按依赖归属删，不按目录名/文件名删。**

| # | 保留项 | 谁在用（实测） | 删了会怎样 | 拆除后怎么用 |
|---|---|---|---|---|
| 1 | `src/utils/ansiToHtml.ts` | **AI 对话**，不是终端：`ToolCallBlockRenderer.tsx:32` import、`:241-251` 对 `bash`/`command`/`execute` 类工具调用块把输出转彩色 HTML（先转义 HTML 特殊字符再替换 `\x1b[Nm`，兼作 XSS 防护）。全仓仅此一个消费者 | 编译断（import 找不到）；Chat 里 Bash 工具输出失去着色 | 原地不动、不改名、不搬进 Terminal 目录。属宿主通用渲染能力（同 Git 域 DiffViewer） |
| 2 | `viewStore.terminalFullscreen` + `App.tsx` 布局 | **整个应用三栏布局的开关**：`TerminalPanel.tsx:377` 全屏按钮 → `toggleTerminalFullscreen()`（`viewStore.ts:312`）→ `App.tsx:280` 关闭左栏自适应、`:360` `<LeftPanel fullscreen>` 撑满且隐藏拖拽条（`LeftPanel.tsx:154`）、`:380` 不渲染 CenterStage、`:384` 不渲染 RightPanel；`TerminalPanel.tsx:308-317` 挂 ESC、`:250-259` 切形变动效 | 全屏功能消失；只删字段不改 `App.tsx` 会直接编译错 | H1 把它从「终端专属」通用化为「当前激活面板全屏」：宿主 `PluginPanelHost` 消费 `supportsFullscreen` 触发同一 store 状态，插件按钮走宿主 API；`App.tsx` 四处布局判断保留，字段名保留以兼容持久化 |
| 3 | `src/types/terminalScript.ts` | **配置文件类型**，不是 UI 类型：`types/config.ts:8` import `WorkspaceTerminalScripts`，用于 `:370 AppConfig.terminalScripts?: Record<工作区绝对路径, WorkspaceTerminalScripts>`；`types/index.ts:14` re-export | `types/config.ts` 编译断，configStore 反序列化后的类型契约丢失 | 保留文件与 `config.ts` 字段；或把该类型内联进 `config.ts` 后再删文件（二选一，本规划采用前者）。**注意同目录 `types/terminal.ts` 才是可删的**——它只被内置组件/store 引用，两者名字相近但命运不同 |
| 4 | `models/config.rs:1521 terminal_scripts` + `TerminalScriptItem` / `WorkspaceTerminalScripts` | **用户真实数据的落盘结构**：前端 `terminalStore.ts:93-97` 读 `config.terminalScripts?.[workspacePath]`，`:164-174` 经 `updateConfigPatch({ terminalScripts })` 写回；值含 `scripts[]`（id/name/command/cwd/env/tags/source/enabled/autoRun/autoRunTrigger/confirmBeforeAutoRun）与 `hiddenDiscoveredScriptIds`；后端 `AppConfig` 字段带 `serde(default)`，`config_store.rs:1019` 默认值，`models/config.rs:1681` 默认构造 | **最隐蔽的数据事故**：`AppConfig` 无 `deny_unknown_fields`，读旧 config.json 时未知字段被静默忽略，但 `config_store.rs:196-207` 的 `save()` 是 `serde_json::to_string_pretty(&self.config)` **全量写回** → 删掉字段后，下一次任意配置保存就把用户所有自定义脚本从磁盘抹掉，且无任何报错 | 永久保留字段 + `serde(default)`，只读、永不改写；作为 H2 `export_saved_scripts` 的唯一数据源。迁移完成后也不删（存量文件可能来自旧版本） |
| 5 | `commands/terminal.rs` 的 PTY 核心（`1–541`、`654–762`） | 见上图：`terminal_capability.rs:42,74,82,160,184,253` 直接依赖 `TerminalSession` / `TerminalManager` / `global_terminal_sink` / `open_in_external_impl` / `discover_scripts_in_workspace`；`lib.rs:614-615,1440-1441` 注入 Dual/Web sink；`state.rs:252` 持有 `Mutex<TerminalManager>`；插件 `bridge.ts:125,132` 订阅 `terminal:output` / `terminal:exit`（事件协议由 `TerminalEventSink` 产生） | 整文件删 → cap.terminal 编译失败、桌面/Web 双端终端全灭、插件收不到输出；改事件名 → 插件静默无输出 | **手术式抽取**：只删 `542–653` 六个 `#[tauri::command]` 与 `763+` 一个包装，保留核心与事件协议；`lib.rs`/`state.rs`/`terminal_capability.rs` 全部不动 |

**一句话判据**：名字带 `terminal` 不等于属于终端域。1 属于 Chat 渲染、2 属于应用布局、3/4 属于配置数据、5 属于宿主运行时——只有 `components/Terminal/`、`terminalStore.ts`、`types/terminal.ts` 与命令包装层真正属于「内置终端实现」。

---

## 5. 数据迁移与兼容（P3）

**问题**：内置自定义脚本存 `config.json` 根级 `terminalScripts: Record<workspacePath, { scripts, hiddenDiscoveredScriptIds }>`（`src/types/config.ts:370`、`models/config.rs:1521`）；插件存 `plugins["terminal-desk"].customCommands`（`CustomCommand` 仅 id/name/command/cwd/env/createdAt，**全局**）。二者字段与作用域都不通，迁移后老脚本会「凭空消失」。

| 内置 `TerminalScript` | 插件目标字段 | 处理 |
|---|---|---|
| `id` / `name` / `command` / `cwd` / `env` | 同名 | 直接映射 |
| `enabled` / `autoRun` / `autoRunTrigger` / `confirmBeforeAutoRun` | 新增同名字段 | 扩展 `CustomCommand`；缺失按内置默认值补齐 |
| `tags` / `source` / `sourcePath` | 新增同名字段 | 保留，用于区分 `package.json` 发现脚本与用户脚本 |
| `hiddenDiscoveredScriptIds`（workspace 级） | `hiddenByWorkspace[workspaceId]` | 按工作区分桶 |
| 工作区路径 key | `workspaces[workspaceId].commands` | 用 `__POLARIS_WORKSPACE_API__.currentId()` 作稳定 key；路径仅作展示 |

**流程（幂等、一次性）**：
1. 插件首次启动（或用户点「导入旧脚本」）→ 调 `cap.terminal export_saved_scripts`（H2）拿全量快照。
2. 逐字段映射到新结构，按 workspaceId 分桶写入 `plugin_set_config`；写 `legacyMigration: { version: 1, migratedAt, sourceCount }` 标记。
3. 检测到标记则跳过；用户可手动「重新导入」（去重按 `id`，不覆盖已编辑项）。
4. **旧 `config.json` 字段只读、永不删除、永不改写**；迁移失败时插件显示可重试提示，不得静默丢弃。
5. 回滚：清 `legacyMigration` 标记并保留新数据即可；旧数据始终在原位。

---

## 6. 分期路线与门禁

| 阶段 | 目标与交付 | 门禁（全过才进入下一阶段） | 回滚 |
|---|---|---|---|
| **P0 止损** | `plugin.json:6` `enabledByDefault` → `false`；插件仓发版；主仓文档登记 | 全新安装默认显示**完整内置终端**；手动启用插件仍可用 | 改回 `true` |
| **P1 视觉** | O1 + O2；`pnpm build` 重打 zip | 明暗主题、200/360/600px 三档截图与 v4 基线一致；`styles-check` 零未定义 token、边框 alpha 全覆盖；内联 CSS 与源码一致 | 插件版本回滚 |
| **P2 功能等价** | O3 + O4 + H1/H3/H4 | §7 功能等价矩阵 F1–F11 全部「保留/增强」，**降级项 = 0**；桌面 + Web-only 双端跑通 `create→write→resize→list→close` 与脚本运行；四套门禁全过 | 插件版本回滚 |
| **P3 数据迁移** | H2 + 插件模型扩展 + O3-8 | 迁移幂等（重复执行结果一致）、字段映射逐项对账、workspace 分桶正确、旧 config 未被改写 | 清迁移标记 |
| **P4 影子运行** | `enabledByDefault` → `true`（shadow 接管），内置代码**完整保留**作为开关级回滚；灰度观察 | 灰度期零 P0/P1 缺陷；性能预算达标；用户可在设置里禁用插件立即回到内置 | **禁用插件即回内置（零成本）** |
| **P5 摘装配** | H5 + §4.2 前端装配修改 + §4.4 后端命令层删除 + 集成测试改写；席位改空态卡 | `pnpm typecheck` / `pnpm test:run` / `cargo check` / web-only `cargo check --no-default-features --bin polaris-web --bin polaris-mcp` 全过；grep 断言 §4.6 通过；**删除 commit 独立可 revert** | `git revert` 单个 commit |
| **P6 删实现** | §4.1 前端删除 + `@xterm` 依赖移除 | 启动包无 xterm 相关 chunk；四套门禁再跑一遍；桌面/Web 端到端回归 | `git revert` 删除 commit |
| **P7 收尾** | 文档唯一权威同步（spec 状态改「已完成」、`core-slimdown` §4.3 Terminal 行改「已移除」、AGENTS cap 清单若有涉同步）、性能与截图归档、行数对账 | 无「保留内置」与「已删除」两份冲突结论 | — |

**硬停点**（触发即停止并报告，不得自行绕过）：
1. 任一阶段四套门禁未全绿。
2. 功能等价矩阵出现任何「降级」，或桌面/Web 单端不可用。
3. H1–H5 任一宿主增量被判定无法提供，且插件侧存在 workaround 冲动时（必须回到评审，不得 workaround）。
4. 数据迁移出现字段丢失或旧 config 被改写。
5. 发现新的内置终端引用面未在 §4 清单内。
6. 插件 `enabledByDefault` 在 P1–P3 未达标前被提前改回 `true`。

---

## 7. 验收口径（R1 零降级）

**功能等价矩阵**（GLM 实施前先补成可勾选表格，逐项标「保留 / 增强 / 降级」）：
- `cap.terminal` 9 个 action（create/write/resize/close/list/get/discover_scripts/open_in_external + H2/H3 新增）× 参数 / 返回 / 权限 / 桌面·Web 差异。
- 内置 UI 功能 F1–F11 全项（§2 O3、O4）。
- 脚本模型全部字段与工作区隔离语义（§5）。
- 会话：`list` 恢复 + attach、重命名持久化、退出码徽标、孤儿 PTY = 0。
- 视觉：v4 布局基线、明暗主题、三档宽度、图标与字体栈。
- 双端：Tauri 桌面 + Web-only 浏览器（`tauri:dev:web` 9827）；`open_in_external` 在 Web 明确禁用而非报错崩溃。

**四套固定门禁**：`pnpm typecheck`、`pnpm test:run`、`cargo check`、web-only `cargo check --no-default-features --bin polaris-web --bin polaris-mcp`（AGENTS.md 固定命令，不得增殖 feature 组合）。

**性能预算**：首次提示符 ≤1s、resize 60ms 去抖跟手、≥1MB 输出无可感掉帧、无固定轮询、无全量 Tab 刷新、无重复 diff/解码计算。

**构建门禁**：`plugin.json` 内联 CSS == `src/styles.css`；`dist/panel.js` 含最新交互点；zip 重打；插件仓 `pnpm test` 全过。

---

## 8. 风险与禁止事项

| 风险 | 缓解 |
|---|---|
| 删席位导致 shadow 自愈为独立视图（用户 pin/tab/宽度记忆全变） | D3 保留席位契约；`LeftPanel.tsx:275-290` 的 `target.panelType in builtinPanels` 条件必须继续成立 |
| 插件直调已摘除的 `terminal_*` 命令（重演 `polaris-git` 死代码） | 所有插件调用必须经 `router_dispatch → cap.terminal`；代码评审加 grep 断言 |
| 旧脚本迁移丢失 `autoRun` / `enabled` / 工作区隔离 | §5 字段映射逐项对账 + 幂等标记 + 旧字段永久只读 |
| 会话孤儿：插件重载后宿主 PTY 仍活着但 UI 无会话 | O3-9 挂载先 `list` 再决定是否 `create` |
| Web 端 9 个旧 dispatch arm 与 2 个集成测试被误删导致门禁红 | §4.4 单列，P5 独立 commit |
| `ansiToHtml` 被误删导致 Chat Bash 输出着色失效 | §4.3 明确保留 |
| 回滚能力在 P4→P5 从「开关」退化为「revert」 | P5 之前必须完成全部 R1 验收；删除 commit 独立可 revert |

**禁止**：
1. 插件未达 R1 就删主仓代码，或把内置实现留作隐藏兜底（空态引导卡不算）。
2. 在插件内另建 PTY、第二套脚本存储、另一套会话表或自挂全局快捷键通道。
3. 用假数据 / `toast()` 假反馈充当纵切验收（vNext 原型的教训）。
4. 状态类 UI（冲突/计数/徽章/running/busy）由局部 flag 驱动；写操作后必须 reconcile 真实快照（Git 插件 spec §5.4 同源纪律）。
5. 把 v5「AI 可调用终端」/ v6「灵动岛跳终端」当作既有欠账排期——它们是未批准提案，另行评审。

---

## 9. 待裁定项（给默认值，未否决即按默认执行）

| # | 事项 | 默认结论 |
|---|---|---|
| 1 | 排期：与 Git 域插件化、B2-2 IM、B2-4 Translate 的先后 | 终端作为**当前唯一在途的插件化收尾项目**优先，P0 立即执行；Git 域仍处评审阶段，不互相阻塞 |
| 2 | 灰度观察期长度与范围 | P4 先内部自用 1 周，零 P0/P1 缺陷再进 P5；不设百分比灰度（桌面应用无灰度下发通道） |
| 3 | v5 / v6 原型是否纳入本轮 | **不纳入**；本轮只做等价 + 视觉 + 拆除，新能力另立需求 |

---

## 10. 交给 GLM 的执行入口

```
请先按以下顺序补读，再开始分析/实施：
1. plans/terminal-desk-optimization-and-removal-plan.md（本规划，唯一执行依据）
2. plans/terminal-desk-gap-analysis.md（S1–S7 / F1–F13 差距证据）
3. plans/terminal-plugin-spec.md（四阶段背景；§六/§七 与本规划冲突处以本规划为准）
4. plans/terminal-panel-refactor-prototype.html（v4 视觉基线，勿参考 vNext 固定三栏原型）
5. 主仓 src/index.css:30-48（主题 token 唯一权威）、src/plugin-system/*、src/components/Layout/LeftPanel.tsx
6. 插件仓 plugins/terminal-desk/{plugin.json,src/*,shared/td-core.js,scripts/build.mjs,test/*}

本轮只允许做 P0–P2 的分析与实施准备；未经另行批准不得进入 P5/P6 删码。
产出：① 功能等价矩阵（action × 参数/返回/权限/双端）；② H1–H5 的主仓落点与先后顺序；
③ P0–P2 逐项验收清单；④ 你识别到的本规划缺口或矛盾（只列出，不自行填补）。
遇 §6 硬停点立即停止并报告，不得用假数据或内置残留掩盖。
```

---

## 11. 口径与限制

- 本轮**只读源码与文档**，未修改任何生产代码 / 插件 / 配置，未构建、未提交；主仓已有的其他未提交改动（`core-slimdown` 文档、`public/ic-sound-test/` 等）未触碰。
- §4 的行号与文件数基于 2026-11-11 工作区实测，拆除前必须重新 grep 复核（spec §七 同样要求）。
- 后端「删命令包装层」后 PTY 核心仍在，主仓代码量减少有限；本规划的价值是**唯一实现 + 独立发版**，不是行数瘦身。
- `plans/terminal-plugin-spec.md` §三 四阶段仍成立，本规划把 C 拆成 P1–P3、D 拆成 P5–P7，并新增 P0 止损与 P4 灰度两级。
