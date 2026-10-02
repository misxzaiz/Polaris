# Polaris 体验架构分析 — 超越主题的深层问题

> 状态：仅分析，未实施（2026-10-02）
> 前置阅读：`style-interaction-modernization-analysis.md`（视觉层，本文不重复）
> 本文回答：**为什么"换了好看的主题还是会觉得落后"？** 因为问题在体验架构层——心智模型、导航拓扑、组件形态、交互范式。

---

## 0. 三层问题分解

| 层 | 症状 | 本质 | 改造成本 |
|---|---|---|---|
| L1 视觉层 | 枯燥、配色保守、无品牌感 | token 决策问题 | 低（见前一份报告） |
| **L2 结构层** | **"找不到、理不清、等得焦虑"** | **信息架构与导航拓扑** | **中高** |
| **L3 范式层** | **"像 2018 年的 IDE，不像 2026 年的 agent 工作台"** | **交互范式（命令/状态/审批/时间线）** | **高** |

只做 L1 = 化妆；L2+L3 不动，"落后感"依然存在。

---

## 1. 心智模型错位（最根本的问题）

### 1.1 产品是什么 vs UI 说它是什么

- **PRODUCT.md 定位**：多 AI coding engine 的统一工作台，"developer cockpit"，核心价值是**多 agent 并行、可监督、可继续**。
- **实际 UI 骨架**：VSCode 克隆（TopMenuBar + ActivityBar + 左侧工具面板 + 中间编辑器 + 右侧 AI 面板）。

矛盾点：
1. **产品差异化核心（多会话 Agent Board）被塞在右侧面板里**——它是"主舞台内容"却被放在"侧栏位置"。没有编辑器 tab 时 RightPanel fillRemaining 只是被动兜底（`App.tsx` L395），不是主动设计。
2. **AI 运行状态没有一级公民位置**：跑了什么、卡在哪、等谁审批、哪个会话完成了——分散在 ChatStatusBar（654 行）、SessionCell 头部、NotificationBell、BackgroundTasks 面板、DispatchCenterButton、CompactHandoffProgress 胶囊 6 个地方。
3. **"当前上下文"感知弱**：引擎、模型、工作区、分支、权限模式这些 agent 运行的前提条件分散在输入框工具条、SessionCell 徽章、设置页里，没有统一的"上下文条带"。

### 1.2 既有文档已诊断，但方向未落地

`polaris-agent-first-layout-v2.md` 已经给出正确答案（v2-A：Agent Control Bar + Context Sidebar + Agent Board + Session Dock + Run Dock），**结构方向锁定了但代码零落地**。这是本文最重要的"存量共识"。

---

## 2. 导航拓扑碎片化（L2 核心病灶）

### 2.1 同一功能的入口最多有 4 套

以"切换左侧工具面板"为例：

| 入口 | 组件 | 触发条件 |
|---|---|---|
| ActivityBar 图标列 | `ActivityBar.tsx`（自适应数量，放不下进"更多工具"） | 常态 |
| ToolSwitcher 浮层 | `ToolSwitcher.tsx` | activityBar 折叠或小屏时移到顶部栏 |
| RadialMenu 扇形菜单 | `RadialMenu.tsx` | 小屏模式 |
| 面板内互跳 | `ExecutionConsole` 等直接调 `setLeftPanelType('...')` | 深链 |

会话/任务入口也有 4 套：QuickSwitchPanel（右侧悬停+钉住）、MultiWindowMenu、NewSessionButton、SessionHistoryPanel。

**入口多 ≠ 可发现性好**——每个入口只覆盖一个场景（常态/折叠/小屏/深链），用户在任何一个场景下只见到其中一套，学习成本×4。

### 2.2 面板类型系统已失控

```ts
// viewStore.ts L9
export type LeftPanelType = string   // ← 无约束的 string！
```

- 16+ 内置面板类型 + 插件动态注册（`pluginRegistry.listViewContributions('activityBar')`）
- 遗留双轨：`showGitPanel`（已废弃，注释承认"由 panelStates 替代，保留兼容"）与 `panelStates` Record 并存
- `viewStore` 里至今保留着 `tracePanelChange` 诊断代码（`[PanelTrace]` console.warn）——**"切回应用后面板消失"复杂到需要插桩追踪**，这是导航状态机失控的直接证据

### 2.3 保活/退场动画三套实现

| 面板 | 保活机制 | 时长 |
|---|---|---|
| 设置页 | App.tsx `settingsKept` + setTimeout | 200ms |
| 左面板 | App.tsx `leftPanelKept` + LeftPanel 内部 `panelVisible` | 150ms |
| 会话历史/消息中心 | `sessionHistoryKept` / `notificationCenterKept` | 260ms |
| 右面板 | RightPanel 内部 phase 状态机（expanded/collapsing/hidden） | 300ms |

同一个"面板开合"语义，4 处各自实现、时长互不一致。**缺一个统一的 Panel 容器原语**（声明式：open + keepAlive + transition，内部统一时序）。

---

## 3. 巨型组件：命令中心长成了工具条

### 3.1 ChatInput 2116 行解剖

它实际承载的职责：文本输入、附件（粘贴/拖放/选择）、@ 文件引用、@ workspace 引用、斜杠命令（3 套解析器：CLI assault / dispatch / agent-nexus）、prompt 优化（引擎选择+模式+方向）、语音输入、代码片段参数面板、上下文块（ContextChips）、待发简报卡（PendingBriefingCard）、待处理队列卡（PendingQueueCard）、MCP server 提及、模型档案选择、会话配置……

**它是整个产品的事实上的"命令中心"**，但视觉形态只是一个带工具条的 textarea。后果：
- 25 个 useState/useStore 调用在一个组件里，任何小改动都要理解 2000 行上下文
- 能力堆积但**无空间层级**：全部能力平铺在一行工具条 + 弹出浮层里，高频能力（发送/中断）与低频能力（参数面板）视觉权重相同
- 输入区上方的"卡片带"（简报卡/队列卡/上下文块/优化横幅）已经出现 4+ 种卡片形态，各自实现

### 3.2 ChatStatusBar 654 行

引擎健康、语音输入、TTS、token 用量、上下文水位（ContextMeter）、多窗口菜单、新会话、交接、派发中心——一行状态栏塞下 9 类信息，靠 13px 图标 + title 提示。**状态栏成了"功能仓库"而不是"状态摘要"**。

### 3.3 对比：现代 agent 产品的命令中心形态

Cursor/Windsurf/Devin 的共同做法：
- **输入框 = 计划面**：模式切换（agent/ask/edit）、上下文预算、审批策略，都是输入框的一等属性，显性可见
- **过程 = 时间线**：工具调用不是"折叠的日志"而是可回放的时间线，失败步骤红色锚点、等待审批的步骤有显式 Approve/Deny
- **状态 = 舞台**：运行中的 agent 占据主视觉（不是侧栏小圆点）

---

## 4. 交互范式缺口（L3）

### 4.1 命令面板缺位

- 快捷键体系已有 8 类 40+ 条（`shortcutsStore.ts`），但**没有统一命令面板**（Command Palette / Ctrl+Shift+P）来暴露它们
- 现有搜索是分裂的：FileSearchModal（文件）、SymbolPalette（符号）、ChatNavigator（会话内跳转）、QuickSwitchPanel（会话）——4 个搜索器 4 套交互
- 快捷键提示只在设置页 ShortcutsTab 静态列出；按钮上几乎无 `kbd` 标注

**一个统一的命令面板能同时解决：入口碎片化（2.1）、功能可发现性、键盘优先三件事**——这是性价比最高的 L3 改造。

### 4.2 审批/干预流未成形

Agent 长任务必然产生"等用户决策"时刻（危险命令确认、文件写入确认、方向选择）。现状：QuestionFloatingPanel 存在但形态轻；没有统一的**审批收件箱**（pending decisions 跨会话聚合、一键处理、超时策略）。用户"等得焦虑"的主要根源之一。

### 4.3 时间线与可回放性

工具调用有 ToolCallBlockRenderer / AgentRunBlockRenderer，补充卡片有"运行过程/变更文件/产物"三 tab（近期 commit `74f2dbed`）——素材齐全，但缺**跨消息的会话级时间线**："这次会话 agent 干了什么"需要滚聊天记录拼出来。

### 4.4 悬停依赖与键盘不可达

（视觉层报告已列，此处归因到范式层）：`opacity-0 group-hover:opacity-100` 模式遍布操作按钮——把"快捷操作"设计成了"彩蛋"。正确范式：聚焦可达（`:focus-visible` 显示）+ 右键/菜单兜底 + 高频操作常显。

### 4.5 渐进披露缺失

面板默认全展开（文件树、Git 全量变更、设置页 17 tab 平铺、ModelProviderTab 228 个 className 的表单）。高密度本身是开发者向的资产，但**没有"默认收敛 + 智能置顶"机制**：
- Git 面板不区分"你应该看的 3 个文件"和"锁文件等 200 个噪音"
- 设置页无分组卡片、无搜索命中高亮跳转（有 searchQuery 但只是过滤）
- 会话历史平铺，无"今天/进行中/等待你"的时间分组

---

## 5. 实验资产盘点（探索很多，整合为零）

项目里散落着大量先锋交互实验，说明团队一直在探索，但**彼此不通约、没有形成语言**：

| 实验 | 位置 | 状态 |
|---|---|---|
| FocusMode 双层聚焦（语义高亮+聚光灯） | `FocusMode/FocusOverlay.tsx` | 已实现，深 |
| RadialMenu 扇形菜单 | `Layout/RadialMenu.tsx` | 小屏专用 |
| QuickSwitchPanel 钉住式会话切换 | `QuickSwitchPanel/` | 已实现 |
| VoiceCompanion 语音伙伴（aurora/呼吸/涟漪动效） | `VoiceCompanion/` + 动效 token | 已实现，动效最精致 |
| 灵动岛 dynamic-island | `Chat/dynamic-island/` | **v4 实施后被回退**（`428d0594`） |
| CompactHandoff 压缩交接简报 | `compact-handoff/` | 已实现 |
| Marquee 圈选 | `marqueeStore` | 已实现 |
| 派发中心/后台任务 | DispatchCenterButton / BackgroundTasks | 已实现 |

**启示**：回退灵动岛的原因（`revert(chat)`）值得读——"活力化"方向试过一次，败在形态不稳/抢占主内容，而非方向错误。新方案必须：可关闭、状态导向、不与主内容争空间。

---

## 6. 深层模式参照（交互范式，非视觉）

| 模式 | 来源 | 对 Polaris 的意义 |
|---|---|---|
| Command Palette 即导航 | Linear/Raycast/VSCode | 收敛 4 套搜索 + 4 套入口；快捷键天然有提示位 |
| 状态即界面 | Devin/UI-TARS/Cursor background agents | Agent 运行态上主舞台；完成/待审批/失败是三种"推入"事件 |
| 审批收件箱 | Devin plan 接受 / Claude Code permission | 跨会话 pending decisions 聚合 + 一键处理 |
| 时间线回放 | Devin session timeline / Claude Code `/rewind` | 会话级工具调用时间线，支持跳回 |
| 计划面输入框 | Cursor composer / Windsurf cascade | 模式、上下文、审批策略在输入框显性化 |
| 渐进披露 | Raycast 设置 / Linear 分组 | 高密度默认 + 智能置顶 + 按需展开 |

---

## 7. 体验架构演进方向（供决策的三个方案）

### 方案 Ⅰ：命令面板优先（最低风险，3-5 天）
不动物理布局，先建**统一 Command Palette**（聚合：命令/文件/符号/会话/设置项/工具面板切换/快捷键），再把 4 套入口降级为它的快捷方式。入口碎片化、可发现性、键盘优先一次解决。之后所有新功能只需注册一条命令。

### 方案 Ⅱ：Agent Board 上位（结构重构，2-4 周，= v2-A 落地）
多会话网格从右侧面板提升为主舞台（无编辑器 tab 时的默认形态，编辑器 tab 打开时对分），顶部建 Agent Control Bar（上下文/引擎/模型/权限/运行状态聚合），右栏保留为当前会话聚焦视图。**这是既有 v2 文档的实施**，直接回应心智模型错位。

### 方案 Ⅲ：范式补全（跟随 Ⅱ 或独立，1-2 周/项）
- 审批收件箱（聚合 QuestionFloatingPanel / 后台任务确认 / 危险命令）
- 会话时间线（消息流之上加一层可折叠的 run 时间线）
- 输入框计划面化（ChatInput 拆解：能力注册制 + 卡片带统一原语 + 高频/低频分层）
- Panel 容器原语（统一保活/退场时序，删掉 4 套各写一遍的 kept 逻辑）

### 推荐组合
**Ⅰ → Ⅱ → Ⅲ 串行**：命令面板先建立"任何东西皆可命令可达"的底座（同时是后续重构的导航兜底——布局改乱时用户永远有 Ctrl+K 逃生门），再做 Board 上位，最后补范式。

---

## 8. 风险与约束

1. **多窗口/保活语义**：Board 上位会触碰 App.tsx 的保活网（4 套 kept 状态），重构前需先把 Panel 容器原语抽出来，否则每一步都在恶化 2.3。
2. **插件生态兼容**：`pluginRegistry.listViewContributions('activityBar')` 是插件 UI 的挂载契约，导航收敛必须保留 activityBar 贡献点的语义（映射而非删除）。
3. **小屏模式**：RadialMenu/compact 布局是独立分支，任何导航改动都要过窄窗场景（useWindowManager isCompact）。
4. **用户肌肉记忆**：已有快捷键 40+ 条不可破坏，命令面板必须全量继承 shortcutsStore。
5. **回退教训**：灵动岛 v4 的 revert 说明形态类改动要灰度（设置开关 → 默认关闭 → 数据说话）。

---

## 9. 与视觉层报告的合并视图

```
阶段 0  选型原型（视觉 Graphite × 结构 Board 双变量原型，1 天）
阶段 1  L1 视觉底座（token 换肤+清债，1-2 天）——独立可交付
阶段 2  Ⅰ 命令面板（3-5 天）——独立可交付
阶段 3  L1 活力层（动效/状态色，2-4 天）——可并行
阶段 4  Ⅱ Agent Board 上位（2-4 周，含 Panel 原语先行）
阶段 5  Ⅲ 范式补全（审批收件箱/时间线/输入框计划面，逐项 1-2 周）
```

每阶段独立可回滚；阶段 2 之前不动任何物理布局。
