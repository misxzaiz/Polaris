# Polaris Agent 优先样式布局改造 V2

本文重新基于当前项目真实功能做分析。重点阅读范围包括：

- 主入口与布局：`src/App.tsx`、`src/components/Layout/*`、`src/stores/viewStore.ts`
- Agent 主流程：`EnhancedChatMessages`、`ChatInput`、`ChatStatusBar`、`MultiSessionGrid`、`SessionCell`
- 会话与工作区：`QuickSwitchPanel`、`QuickSwitchContent`、`WorkspaceMenu`、`WorkspaceBadge`、`NewSessionButton`
- Agent 执行可视化：`ToolCallBlockRenderer`、`AgentRunBlockRenderer`、`QuestionFloatingPanel`、`ChatNavigator`
- 侧栏高密度面板：`FileExplorer`、`GitPanel`、`TerminalPanel`、`SessionHistoryPanel`
- 样式基础：`tailwind.config.js`、`src/index.css`

配套原型：`docs/design/prototypes/polaris-agent-first-prototypes-v2.html`

## 一、现有优势必须保留

Polaris 的强项不是“有一个 AI 聊天侧栏”，而是已经具备了一个多 Agent 执行工作台的核心骨架。

### 1. Agent 优先的基础已经存在

当前 `App.tsx` 中，当没有打开编辑器 Tab 时，`RightPanel` 会 `fillRemaining`，AI 面板自动填满空间。这个行为很重要：它说明产品天然可以从“Agent 主区”开始，而不是从“代码编辑器主区”开始。

### 2. 多会话窗口是差异化能力

`MultiSessionGrid` 支持：

- 多会话横向滚动；
- 1 行 / 2 行布局；
- 统一格子宽度；
- 单会话展开；
- 指定会话滚动定位；
- 每个 `SessionCell` 内直接复用消息视图。

这不是普通聊天产品的能力，应该成为主体验的一部分，而不是藏在底部状态栏按钮里。

### 3. SessionCell 信息架构已经很好

每个会话格子包含：

- 会话标题；
- 主工作区与上下文工作区徽章；
- 流式状态；
- 待回答问题提示；
- 状态图标；
- 中断按钮；
- 展开按钮；
- 关闭按钮。

这些信息非常适合做 Agent Board，只需要更清晰地组织视觉层级。

### 4. QuickSwitch 是高价值功能

`QuickSwitchPanel` 已经有：

- 右侧贴边触发；
- 悬停展开；
- 钉住；
- 快速切换会话；
- 新建会话；
- 工作区切换；
- 上下文工作区管理；
- 导出；
- 历史入口。

这套能力不应该被改没。更好的方向是让它从“悬浮工具”升级为“Agent Session Dock”：可悬浮，也可钉住成为正式侧栏。

### 5. 会话工作区绑定很关键

`WorkspaceBadge`、`WorkspaceMenu`、`QuickSwitchContent` 都体现了一个重要产品判断：每个 Agent session 可以绑定主工作区，并附带上下文工作区。这是 Agent 做真实开发任务的核心，不应该简化成全局工作区切换。

### 6. Agent 状态条承载了专业控制

`ChatStatusBar` 中已经汇总：

- Agent；
- Model；
- Effort；
- Permission；
- 引擎版本；
- 语音；
- TTS；
- pending question；
- plan approval；
- input length；
- streaming 状态；
- MultiWindowMenu 与 NewSessionButton。

问题不是功能弱，而是这些功能都挤在底部，用户需要自己记忆每个按钮的意义。

## 二、当前样式与布局问题

### 1. 暗黑风过重

当前 token 以近黑色为主：

- `background.base`: `rgba(15, 15, 17, ...)`
- `background.elevated`: `rgba(26, 26, 31, ...)`
- `background.surface`: `rgba(37, 37, 43, ...)`

这组颜色层次够用，但整体太接近纯黑，面板边框又比较亮，导致界面读起来“硬”和“割裂”。Terminal 还使用大量 `#1e1e1e`、`#252526`、`#3c3c3c`，和全局 token 不完全一致。

建议改成“柔和石墨色系”：

- base 不要低于 `#15171c`；
- panel 使用略带蓝灰或中性灰，不要纯黑；
- surface 与 hover 差距降低，避免块面跳得太明显；
- Terminal 保留专业深色，但跟全局背景统一色温。

### 2. 边角和边界太显眼

代码统计显示，项目中 `rounded` 相关使用很多：`rounded-lg` 约 431 次、`rounded-md` 约 168 次、`rounded-xl` 约 51 次、`rounded-full` 约 134 次；`border-border` 约 718 次。

单看每个组件都合理，但组合后会出现：

- 每个控件都像独立卡片；
- 面板边缘、弹窗边缘、按钮边缘同时可见；
- 深色背景下浅边框把“菱角”放大；
- 悬浮面板 `rounded-2xl`、`rounded-xl` 和主工作区直角并存，节奏不统一。

建议：

- App Shell 和主面板不要大圆角，保持平整工作台；
- 面板内控件统一 6px 或 8px；
- 弹层使用 10px，少用 16px+；
- 降低边框不透明度，把层级更多交给背景色、间距和状态条；
- 减少 `shadow-glow`，只给运行中 Agent 或关键状态使用。

### 3. 边缘触发控件互相竞争

当前有多个贴边/悬浮入口：

- 左侧折叠后 `RadialMenuTrigger`；
- 右侧 `QuickSwitchTrigger`；
- 右侧 `ChatNavigator`；
- 右侧 AI 面板本身折叠按钮；
- SessionHistory 固定右侧抽屉。

这些入口都好用，但角色重叠。尤其右侧同时有 QuickSwitch 和 ChatNavigator，用户会感到“哪里都能摸一下，但不知道哪个是主导航”。

建议把右侧边缘统一成两层：

- `Agent Session Dock`：会话、工作区、钉住、历史；
- `Timeline Navigator`：只在长对话时作为 Dock 内部能力，而不是另一个独立贴边控件。

### 4. Agent 主区和侧栏的关系不够清晰

左侧 ActivityBar 目前是功能列表：文件、Git、Todo、翻译、Scheduler、Requirement、Terminal、Developer、Integration、Problems。功能很全，但和当前 Agent session 的关系没有被表达出来。

建议把左侧改成 `Context Sidebar`：

- 当前 Agent 绑定的 workspace 决定默认文件树和 Git 状态；
- 当前 Agent 使用工具时，侧栏高亮相关文件或面板；
- 有 pending question 的会话，在 Session Dock 和 Agent Board 中同时提示；
- Requirement、Todo 作为 Agent 上下文来源，不只是独立工具面板。

### 5. 多窗口模式入口太弱

`MultiWindowMenu` 很实用，但它位于 `ChatStatusBar` 的 children 中。多窗口是核心能力，却像一个底部小图标设置。

建议：

- Agent 主区顶部固定 `Agent Control Bar`；
- 多窗口开关、行数、格子宽度、新建会话都放在主控条；
- SessionCell 顶部保留必要操作，更多设置收进上下文菜单或 Dock。

### 6. 弹层与面板样式重复

工作区菜单、历史面板、文件搜索、符号面板、配置选择器、QuickSwitch 都各自实现弹层样式。它们的背景、圆角、阴影、边框、动效不完全一致。

建议抽象：

- `FloatingSurface`
- `DockSurface`
- `SegmentedControl`
- `AgentStatusBadge`
- `WorkspaceChip`
- `PanelSectionHeader`

这样能避免继续积累样式分叉。

## 三、总体设计原则

### Agent 优先，不等于聊天优先

Agent 主区应该展示“执行状态、计划、工具、问题、结果”，聊天只是其中一种表达。多会话 Board、工具 Inspector、Context Sidebar 都应该围绕 Agent 任务组织。

### 保留高密度，但降低视觉噪音

Polaris 是开发工具，不适合大面积宣传式卡片。应该继续保持工具密度，但把过亮边框、过重阴影、过多圆角降下来。

### 边缘能力统一

左侧是 Context，右侧是 Sessions，底部是 Run/Terminal/Logs。不要让多个悬浮触发器在同一个边缘争抢。

### 钉住要成为正式布局状态

QuickSwitch 的“钉住”是好功能，但钉住后应该影响布局，让它从 overlay 变成 dock，避免遮挡主内容。

### 多窗口是默认一等公民

多窗口不是临时视图，而是 Agent 并行工作模式。应有明确名称：`Agent Board`。

## 四、推荐方案：Agent Board First

默认布局：

- 顶部：Agent Control Bar
- 左侧：Context Sidebar
- 中间：Agent Timeline 或 Agent Board
- 右侧：Session Dock，可悬浮或钉住
- 底部：Run Dock，可显示终端、任务日志、诊断、工具输出

### 顶部 Agent Control Bar

承载：

- 当前工作区；
- 当前会话标题；
- 引擎/模型/Effort/Permission；
- 单会话 / Agent Board 切换；
- Board 行数；
- 新建 Agent；
- 当前运行状态；
- pending question / plan approval。

把原来 `ChatStatusBar` 的核心控制上移，底部保留输入区和局部状态。

### 左侧 Context Sidebar

保留 ActivityBar 的功能，但改为分组：

- Context：Files、Requirements；
- Changes：Git、Problems；
- Run：Terminal、Scheduler；
- Integrations：Translate、Bots、Plugins；
- Settings。

面板标题统一：

- 当前会话主工作区；
- 上下文工作区数；
- 当前面板工具条。

### 中间 Agent Board

单会话模式：

- Agent timeline 居中；
- 工具调用块更像任务步骤；
- 待回答问题显示为顶部或底部的任务卡，不只浮在输入框上方。

多会话模式：

- 复用 `MultiSessionGrid`；
- 顶部增加 Session Tabs 或 Board Strip，`SessionTabs` 组件可以重新启用；
- 支持 1/2 行、格子宽度、展开；
- 每个格子强化状态：running、waiting、question、background。

### 右侧 Session Dock

基于现有 QuickSwitch 升级：

- 未钉住：保持贴边触发；
- 钉住：占用布局宽度，成为正式右侧窄栏；
- 内部包含会话列表、工作区切换、上下文工作区、历史、导出；
- ChatNavigator 并入当前会话详情，不再单独贴边。

### 底部 Run Dock

将 Terminal、Scheduler Logs、Problems、Tool Output 放到底部，作为 Agent 执行反馈区。这样左侧 ActivityBar 会变轻，右侧 Agent 不会被终端和日志抢空间。

## 五、几版方案

### 方案 A：Agent Board First

适合默认主方案。

特点：

- 多会话 Board 是主视图；
- 右侧 Session Dock 可钉住；
- 左侧是 Context Sidebar；
- 顶部 Agent Control Bar 直接控制多窗口、行数、模型、权限。

优点：

- 最大化保留并强化现有多窗口和钉住功能；
- 产品定位清晰：多 Agent 编程工作台；
- 对现有代码改动中等，主要重组布局层。

风险：

- 老用户习惯右侧聊天面板，需要过渡提示；
- 编辑器默认存在感下降，需要打开文件后有清晰的分屏反馈。

### 方案 B：Agent Cockpit

适合单任务深度执行。

特点：

- 中间单 Agent timeline；
- 右侧 Inspector 展示计划、工具调用、Diff、日志；
- 左侧 Context Sidebar 服务当前任务；
- Session Dock 可以收起。

优点：

- 最适合长任务、复杂工具调用、Plan approval；
- 工具细节不会挤在消息流里；
- 待回答问题更醒目。

风险：

- 多会话优势不如方案 A 外显；
- 需要设计工具详情与消息块之间的同步关系。

### 方案 C：Context Console

适合强调“Agent 侧边栏更方便易用”。

特点：

- 左侧上下文侧栏变成操作台；
- 文件、Git、Terminal 都在同一区域用分段切换；
- Agent 主区保持 Timeline/Board；
- 右侧 Session Dock 保持钉住。

优点：

- 侧栏工具更集中；
- 当前 Agent 与当前上下文关系更明确；
- 文件/Git 之间切换成本低。

风险：

- 左侧面板会更重，窄屏要做折叠策略；
- 需要统一各面板头部与列表密度。

### 方案 D：Soft Graphite Theme

适合先解决“暗黑风太重、边角太明显”的视觉问题。

特点：

- 不改主要布局；
- 重做色彩、边框、圆角、阴影；
- 把黑色改成石墨灰；
- 边框不再作为主要层级；
- 状态色降低饱和，减少蓝色泛滥。

优点：

- 风险最低；
- 视觉舒适度提升明显；
- 可作为方案 A/B/C 的共同主题基础。

风险：

- 只改视觉，不解决 Agent 功能分散的问题。

## 六、落地顺序

### 第 1 阶段：视觉 token 与基础组件

- 新增 softer token：`background.canvas`、`background.panel`、`background.raised`、`background.control`。
- 收敛圆角：shell 0、panel 0、control 6、input 8、popover 10。
- 降低 `border` 不透明度，减少 `shadow-glow`。
- 抽 `FloatingSurface`、`PanelHeader`、`SegmentedControl`、`StatusBadge`、`WorkspaceChip`。

### 第 2 阶段：Agent Control Bar

- 从 `ChatStatusBar` 中上移核心运行控制；
- 保留底部输入状态，但不再塞入所有全局控件；
- 将 MultiWindowMenu 变成 Agent Board 控制；
- NewSessionButton 在单会话和多会话下都可见，只是行为不同。

### 第 3 阶段：Session Dock

- 在 `QuickSwitchPanel` 基础上支持 pinned dock 布局状态；
- 钉住后不 overlay，而是占布局宽度；
- 合并 ChatNavigator 入口；
- 展示 running/waiting/question 状态分组。

### 第 4 阶段：Context Sidebar

- ActivityBar 分组；
- 当前会话工作区驱动 FileExplorer/Git 默认上下文；
- 统一 FileExplorer、Git、Terminal 的面板头部；
- Terminal 和 Problems 准备迁移到底部 Run Dock。

### 第 5 阶段：Agent Board

- 在多会话模式中引入顶部 Session Strip；
- SessionCell 增加更清楚的状态层级；
- 待回答问题在格子和 Dock 同时提示；
- 单会话展开时保留旁侧 Inspector。

## 七、原型说明

原型文件：`docs/design/prototypes/polaris-agent-first-prototypes-v2.html`

包含四版：

- `A Board First`：默认推荐，多 Agent Board 主视图。
- `B Cockpit`：单 Agent 深度执行，右侧 Inspector。
- `C Context Console`：强调侧栏工具更顺手。
- `D Soft Theme`：只展示柔和暗色主题与边角策略。

原型支持以下交互：

- 切换四版方案；
- 切换 1 行 / 2 行 Agent Board；
- 钉住 / 取消钉住 Session Dock；
- 切换 Context Sidebar 的 Files / Git / Terminal；
- 切换 Inspector 的 Plan / Tools / Diff / Log；
- 显示 / 隐藏待回答问题；
- 展开某个 Agent 会话；
- 切换 Soft Dark / Graphite / Light 三种视觉基调。

文件使用 `<meta charset="UTF-8">`，中文不会乱码。
