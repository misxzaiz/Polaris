# terminal-desk 终端改造：样式与功能差距分析

> 日期：2026-11-11 · 状态：**仅分析，未修改任何代码 / 插件 / 配置 / 提交**
> 分析对象：主仓 `plans/terminal-plugin-spec.md`（2026-11-10 方案）、`plans/terminal-panel-refactor-prototype.html`（v4 视觉基线）、`plans/terminal-ai-callable-prototype.html`（v5）、`plans/island-task-jump-terminal-prototype.html`（v6）、插件仓 `plugins/terminal-desk` v0.2.2、主仓内置 `src/components/Terminal/` 与 `src/stores/terminalStore.ts`。
> 用户判断：**「样式丑且功能未完全」**。本文件给出根因级证据与逐项差距，不含修复实现。

---

## 0. 结论摘要

用户判断成立，且两类问题都不是零散 bug，而是**同一个结构性原因**：v0.2.2 是按 `terminal-plugin-spec.md` §五「v1 对齐内置」的功能清单实现的一个**新 UI**，既没有对齐 v4 原型确立的视觉基线（布局/图标/token），也没有覆盖内置终端与三份原型里的完整功能面；同时 spec 自定的四阶段只走到 B（共存 → 接管），阶段 C（优化）与 D（拆除）未完成。

放大影响面的一个决策：`plugin.json:6` 是 `enabledByDefault: true`，且 `plugin.json:17-18` 声明 `slot: "terminal.panel"` + `slotMode: "shadow"`。宿主 `LeftPanel.tsx:275-343` 已实现 shadow 消费，**插件装上即默认接管内置终端席位，内置完整面板被隐藏**。因此用户日常看到的就是这份半成品，而不是「可选的新视图」。

> 有利的一面：shadow 的回滚是天然的——禁用插件即恢复内置面板（`LeftPanel.tsx:342`），无需改码。

---

## 1. 范围与时间线

| 时间 | 产物 | 性质 |
|---|---|---|
| 2026-11-01 | `terminal-panel-refactor-prototype.html` v4 | 视觉/性能基线：明确写「复刻 TerminalPanel.tsx 真实布局」，QuickRunBar(36) + 可折叠 ScriptPanel + TabBar(36) + 终端区；并列出「优化三步走」 |
| 2026-11-01 前后 | v5「AI 可调用终端」、v6「灵动岛后台任务跳终端」 | 交互提案（统一命令面板、AI 任务同标签栏、来源/审计标注、跳终端三档） |
| 2026-11-10 | `terminal-plugin-spec.md` | 插件化四阶段方案：A 共存 → B 接管 → C 优化 → D 拆除；状态标注「实施中」 |
| 2026-11-10 | 主仓落地 `cap.terminal` | `terminal_capability.rs` 14,148 B；`lib.rs:648`（桌面）、`lib.rs:1467`（Web）已注册；白名单含 `router_dispatch` / `plugin_get_config` / `plugin_set_config` |
| 2026-11-11 | 插件仓 `terminal-desk` v0.2.2 | `ed21bd9` 分屏 → `ff56bfe` 修 listen 异步契约 → `377fa08` v0.2.2；约 1,700 行源码 + 9,462 行 bundle |

**判定**：A、B 已完成（能跑、能接管），C 只做了 WebGL/搜索/分屏三项，D 完全未做。spec §九 的验收项多数仍未勾选。所谓「功能未完全」首先是**阶段未完**。

---

## 2. 样式问题（按可证伪程度排序）

### S1 🔴 三个主题 token 在宿主根本不存在 —— 主因

`src/index.css:30-48` 定义的是 `--c-bg-base / --c-bg-elevated / --c-bg-surface / --c-bg-hover / --c-bg-active / --c-border / --c-status-danger / --c-status-success` 等。实测定义数：

| 插件使用的 token | 宿主定义数 | 后果 |
|---|---:|---|
| `--c-bg-subtle` | **0** | `rgb(var(--c-bg-subtle))` 整条声明失效 → 背景透明 |
| `--c-danger` | **0**（真实名 `--c-status-danger`） | 状态色走硬编码 fallback，自定义主题不跟随 |
| `--c-success` | **0**（真实名 `--c-status-success`） | 同上 |

失效的具体位置（`src/styles.css`）：`.td-tabbar:21`（tab 栏背景）、`.td-drawer:149`（脚本抽屉背景）、`.td-exitbanner:126`、`.td-errorbar:138`。**四个区域同时失去底色**，界面层级直接糊成一片——这是「丑」最直接的来源，且 CSS 注释还声称「色值一律取主题 CSS 变量、禁硬编码色值」，属于 token 名写错而非设计取舍。

对照：v4 原型 `:root` 用的是**正确的** `--c-status-danger / --c-status-success / --c-bg-elev`，并在 `.term-frame` 用 `rgb(var(--c-border) / 0.08)`。即设计基线是对的，实现抄错了。

### S2 🔴 边框是纯白 1px 实线

`src/index.css:40` 定义 `--c-border: 255 255 255`，注释写明「alpha 由 tailwind token 控制」；宿主自身用法一律带透明度（`/ 0.08`、`/ 0.25`、`/ 0.5`，见 `index.css:282,445,1173,1712`）。

插件 `styles.css` 共 10+ 处 `1px solid rgb(var(--c-border))`，**全部不带 alpha**：tab 栏、抽屉、退出横幅、错误条、输入框、mini 按钮、chip、弹窗、搜索条、分屏分隔线。结果是暗色主题下一圈刺眼纯白描边，与内置 Tailwind `border-border` 的观感差异极大。

### S3 🔴 布局结构与 v4 基线不一致

| 结构 | 内置 / v4 基线 | 插件 v0.2.2 |
|---|---|---|
| 快捷运行条 | `TerminalQuickRunBar`（常驻 36px，名称/命令/状态/运行/停止/快速运行） | **无** |
| 脚本区 | 顶部 `TerminalScriptPanel`（410 行），可折叠，折叠态由 `viewStore.terminalScriptPanelCollapsed` 持久化 | 底部固定 **256px** 抽屉（`.td-drawer:145`），状态仅在组件内 useState |
| Tab 栏 | 36px 高、min 100 / max 200px、`TerminalIcon` 图标、右侧 36×36 全屏按钮 | 4px padding 的紧凑行、无图标、Unicode 文本按钮 |
| 空态 | 48px `TerminalIcon` + 提示文字 | 一行文字 + mini 按钮 |
| 全屏 | `viewStore.terminalFullscreen` + ESC 退出 + `animate-panel-in` 动画 | manifest 声明 `supportsFullscreen: true`，但**宿主无消费点**（全仓仅 `plugin-system/types.ts:107` 定义该字段，`PluginPanelHost.tsx` 无相关代码）→ 实际没有全屏入口 |

### S4 🟠 图标与控件语言不统一

插件全部使用 Unicode 字符：`＋`、`⿴`、`▶`、`▴/▾`、`✕`（`Panel.tsx:271-293`、搜索条 `:224`）。内置使用 lucide-react（`Plus` / `X` / `Terminal` / `Maximize2` / `Minimize2`，尺寸 14/16，统一 36×36 命中区）。Unicode 字形随系统字体漂移、基线不齐、无等宽命中区，是「廉价感」的直接观感来源。

### S5 🟠 终端字体与排版退化

- 内置：`'Consolas, "SF Mono", Menlo, "DejaVu Sans Mono", "Courier New", monospace'` + `fontSize:14` + `lineHeight:1.2` + `cursorStyle:'block'`（`TerminalPanel.tsx:90-98`）
- 插件：`"Consolas, 'Courier New', monospace"` + `fontSize:14`，**缺 lineHeight 与 cursorStyle**（`SessionView.tsx:48-54`）；v4 原型的 `--mono` 含 `SF Mono / Cascadia Mono / Menlo`
- `.td-session` 有 `padding: 2px 4px 4px 8px`（`styles.css:110`），内置终端容器是 `w-full h-full` 无内边距 → 字符区不对称留白

### S6 🟡 硬编码深色遮罩

`.td-modal-mask` 用 `rgba(0,0,0,0.45)`、`.td-modal` 用 `0 12px 40px rgba(0,0,0,0.35)`（`styles.css:249,261`），浅色主题下仍是重黑遮罩；宿主弹层走主题 token。

### S7 🟡 层级密度偏平

插件字号 10–13px 全平铺（tab 12、脚本名 12、命令 11、徽标 10、hint 11），缺少 v4 的 36px 基准高度、`--c-status-*` 状态色分层和 `text-secondary/muted/tertiary` 三级文本层次。

### 构建同步性（排除项）

已验证：`plugin.json` 内联的 `contributes.styles[panel].css` 与 `src/styles.css` **逐字一致（6,782 B）**，`dist/panel.js` 含 `td-search-input` / `WebglAddon` / `splitPartner` 等最新代码。所以**不是构建没同步或装了旧包**，问题在源码本身。

---

## 3. 功能差距（对照内置 + spec + 原型）

| # | 功能 | 内置终端 | 插件 v0.2.2 | 判定 |
|---|---|---|---|---|
| F1 | 常驻快捷运行条（运行/停止/快速运行、状态显示） | `TerminalQuickRunBar` | 无 | **缺** |
| F2 | Tab 右键菜单（关闭/停止脚本/重跑/复制命令） | `TerminalTabContextMenu` | 仅双击重命名 | **缺** |
| F3 | 脚本右键菜单（外部终端/编辑/隐藏/删除） | `TerminalScriptContextMenu` | 仅「运行/停止/删除」行内按钮 | **缺** |
| F4 | 全屏（撑满 + ESC + 动画） | `viewStore.terminalFullscreen` | manifest 声明，宿主未接线 | **缺** |
| F5 | 脚本编辑、项目脚本隐藏/恢复 | `saveScript` / `hideProjectScript` / `restoreHiddenProjectScripts` | 只有添加 / 删除自定义命令 | **缺** |
| F6 | 自动运行触发器（`autoRun` / `autoRunTrigger` / `confirmBeforeAutoRun`） | `runAutoScripts`，`terminalStore.ts:490-510` | 无 | **缺**（spec §六 已明确降级） |
| F7 | 在外部系统终端运行 | `runInExternalTerminal` | 未调用 `cap.terminal open_in_external`（该 action 宿主已提供） | **缺** |
| F8 | 脚本数据兼容 | `config.json` 的 `terminal_scripts`，**按工作区 key** | `plugins["terminal-desk"].customCommands`，**全局**、字段仅 name/command/cwd/env | **数据不通**：用户既有自定义脚本迁移后不可见，无一次性导入路径；且丢失工作区隔离与 enabled/autoRun 语义 |
| F9 | 会话列表恢复 | `refreshSessions()` + Zustand 全局 store | 组件内 `useState`，挂载只 `create`，**从未调用 `cap.terminal list`** | **部分缺**：`LeftPanel` 用 `hidden` 保活（`:338`），切视图不丢；但应用/插件重载、禁用再启用后会话 UI 全丢，宿主 PTY 会话成为孤儿且无法重新 attach |
| F10 | 重命名持久化 | store 会话对象 | `nameOverrides` 仅前端覆盖，注释自承「不回传后端」（`Panel.tsx:48-49,231-250`） | **半实现**：重挂即丢 |
| F11 | v4「优化三步走」 | — | ① WebGL ✅；② 批量输出解码 ❌（`decodeBase64ToBytes` 仍是 for 循环逐字节，`model.ts:88-93`，与内置 `TerminalPanel.tsx:147-150` 完全一样）；③ resize 60ms + 拖拽中只 fit ❌（仍 100ms + 每次 fit&resize，`SessionView.tsx:91-116`） | **1/3** |
| F12 | v5 统一命令面板（人/AI 命令同标签栏、来源标注、审计链、流式输出） | — | 仅有 stdio MCP 三工具 | **未落地**（原型提案，非已批准需求） |
| F13 | v6 灵动岛后台任务 → 跳终端（三档） | — | 无 | **未落地**（同上） |

**插件确实超越内置的部分**（应保留，避免修复时一并回退）：WebGL 渲染 + 降级、Ctrl+F 搜索条、左右分屏、stdio MCP 三工具（`terminal_list` / `terminal_run_in_new_session` / `terminal_write`）、独立发版/热更新、`scrollback 10000` 保留。

**一处需要修正的既有表述**：spec §五写「停止 = 写 Ctrl+C」，但内置 `stopScript` 实际就是 `closeSession`（`terminalStore.ts:456-466`），插件 `Panel.tsx:181-184` 同样 close —— 两边一致，不算功能缺口。

---

## 4. 影响面与现场原因

1. **默认启用 + shadow 接管**是用户「一打开就看到半成品」的直接原因：`plugin.json:6,17-18` + `LeftPanel.tsx:275-343`。同样的问题若 `enabledByDefault:false`（对比 B2-1 电台骨架的策略）就只会影响主动尝鲜的用户。
2. **回滚零成本**：禁用插件即回内置面板，无需 revert。这也是后续修复可以先做灰度验证的原因。
3. **阶段未完而非全盘失败**：A/B 的数据通道是扎实的——cap.terminal 桌面/Web 双端注册、全局 sink、`router_dispatch` 白名单、`plugin_*_config` 白名单、`listen` 异步契约修复（`ff56bfe`）都已落地；PTY 留宿主、双端可用的架构判断成立。问题集中在**插件 UI 层与功能承接面**。
4. spec 状态仍是「实施中」，`§九` 阶段 C/D 验收项未勾；主仓内置 `src/components/Terminal/`、`terminalStore.ts` 仍在，属于双轨共存期，尚未拆码。

---

## 5. 建议的修复顺序（仅建议，本轮不实施）

| 优先级 | 动作 | 理由 |
|---|---|---|
| P0 | 把 `enabledByDefault` 改回 `false`（或先补齐再默认启用） | 一行改动，立刻止损，让完整的内置面板回归默认 |
| P0 | 修 3 个 token 名 + 给所有 `--c-border` 补 alpha（`/ 0.08`~`/ 0.25`） | 最小改动、最大观感收益；顺带把 xterm 字体栈/lineHeight/cursorStyle 与 `.td-session` padding 对齐内置 |
| P1 | 按 v4 结构重排：补 QuickRunBar、脚本区改回顶部可折叠、tab 图标改 lucide、接全屏（宿主需消费 `supportsFullscreen` 或提供面板内全屏 API） | 恢复视觉基线；全屏属宿主增量，需主仓配合 |
| P1 | 补 F2/F3 右键菜单、F4 全屏、F5 脚本编辑/隐藏恢复 | 与内置功能等价 |
| P2 | F8 数据兼容：从宿主 `terminal_scripts` 一次性导入，并按 workspaceId 隔离；补 F6 自动运行、F7 外部终端 | 涉及宿主契约与数据迁移，需独立 spec |
| P2 | F9 会话恢复：调用 `cap.terminal list` 重建会话表；F10 重命名回传宿主 | 消除孤儿 PTY |
| P3 | F11 剩余两项性能优化；F12/F13 先评审是否纳入范围，不要当既有欠账直接排期 | v5/v6 是提案原型 |

**门禁提醒**：改 `src/styles.css` 后必须跑 `pnpm build`（`scripts/build.mjs` 负责把 CSS 同步进 `plugin.json` 内联）并重新打 zip；否则 manifest 里仍是旧样式。回归须覆盖 shadow 接管/禁用回滚、明暗主题、桌面与 Web-only、以及内置面板在禁用态的可用性。

---

## 6. 口径与限制

- 本轮**只读源码与文档**，未修改任何代码、插件、配置，未构建、未提交。
- 样式结论分两类：S1/S2 是**可静态证伪的 CSS 规则错误**（变量未定义、alpha 缺失），结论确定；S3–S7 是与 v4/内置基线的**结构对照**，最终观感仍需真机（桌面 + Web）截图确认，本轮未启动应用。
- F12/F13 依据的是设计原型 HTML，属**未批准提案**，列出仅为说明「规划面 > 落地面」，不应据此认定改造承诺违约。
- 证据定位：`plans/terminal-plugin-spec.md`、`plans/terminal-panel-refactor-prototype.html`（v4/v5/v6）、`plans/terminal-panel-refactor-prototype.html:8-26` token、`src/index.css:30-48`、`src/main.tsx:35-49`、`src/components/Layout/LeftPanel.tsx:275-343`、`src/components/Terminal/*`、`src/stores/terminalStore.ts:41-83,456-466,490-510`、`src-tauri/src/lib.rs:648,1467`、插件仓 `plugins/terminal-desk/{plugin.json,src/*}`。
