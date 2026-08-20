# Polaris 样式布局改造规划

本文基于当前代码结构与页面职责分析，重点观察了 `src/App.tsx`、`src/components/Layout/*`、`src/components/TopMenuBar/index.tsx`、`src/components/Chat/*`、`src/components/FileExplorer/FileExplorer.tsx`、`src/components/GitPanel/index.tsx`、`src/index.css` 与 `tailwind.config.js`。

配套原型：`docs/design/prototypes/polaris-layout-redesign.html`。

## 现状判断

Polaris 当前已经具备清晰的 IDE 型骨架：顶部窗口栏、左侧 ActivityBar、左侧工具面板、中间编辑区、右侧 AI 对话区。这个基础适合继续演进，不建议推倒重做。

当前优势：

- 核心工作区分区稳定：左侧工具、中心编辑、右侧 AI 的职责边界明确。
- 面板状态已集中在 `viewStore`，具备做布局模式切换的状态基础。
- 颜色 token 已进入 `tailwind.config.js`，后续可以收敛为设计系统。
- Chat、Editor、Git、Terminal、Scheduler 等模块拆分较完整，适合分阶段改造。

主要问题：

- 顶部菜单、ActivityBar、QuickSwitch、ChatStatusBar 等入口分散，用户对“当前工作上下文”缺少统一感知。
- 左侧 ActivityBar 图标数量偏多，且没有按工作流分组，长期使用时扫描成本高。
- 右侧 AI 面板既承担主对话，又承担会话切换、状态栏、输入区，信息密度高但层级不够清楚。
- `src/index.css` 中存在较多组件级样式，Git 相关样式与 Tailwind 原子类混用，后续主题切换和统一边距会变重。
- 圆角、阴影、卡片边界在不同组件中尺度不一致，部分区域偏“卡片化”，不够像专业工作台。
- 小屏模式目前更像“隐藏左侧工具”，而不是重新组织成可操作的移动/窄屏布局。

## 改造目标

1. 让 Polaris 看起来像一个可长时间工作的 AI 编程工作台，而不是聊天工具加若干侧边栏。
2. 建立统一的 Shell 层：窗口栏、工作区、会话、引擎状态、全局动作都归入同一信息带。
3. 降低视觉噪音：减少厚重阴影和重复边框，用层级、留白、状态色表达重点。
4. 保留高密度：文件树、Git、终端、诊断等面板应偏工具型，而不是营销型卡片。
5. 让 AI 操作过程更可见：会话状态、工具调用、待回答问题、多会话模式要有稳定位置。

## 方案 A：稳健增强 Workbench 2.0

定位：保留当前三栏结构，做最小风险的视觉和信息架构升级。

布局：

- 顶部改为统一 Command Bar：左侧是品牌与工作区，中间显示当前会话/引擎/分支，右侧放窗口控制和全局动作。
- ActivityBar 保持左侧，但按“代码 / 自动化 / 集成 / 诊断”分组，用分隔区减少连续图标压力。
- 左侧面板统一使用 `PanelHeader + Toolbar + Content` 模式。
- 中间编辑区保持 TabBar + Breadcrumb + Editor。
- 右侧 AI 面板改为 `Agent Dock`，顶部固定显示会话状态、上下文工作区、运行状态。

适合场景：

- 想尽快提升专业感和一致性。
- 不希望大规模改动 Zustand 状态和主布局逻辑。
- 目标是一个版本内可落地。

实施重点：

- 抽象 `AppShell`、`CommandBar`、`PanelHeader`、`AgentDockHeader`。
- 将面板标题栏和工具栏统一尺寸：标题区 44px，工具区 36px，TabBar 36-40px。
- 将按钮圆角收敛到 6-8px，减少 `rounded-xl` 在工具区的使用。
- 将 `src/index.css` 中 Git 组件样式逐步迁移到组件内 Tailwind 或独立模块样式。

风险：

- 视觉提升明显，但布局模式变化有限。
- 多会话和自动化能力仍然只是右侧面板里的功能点，品牌差异化不强。

## 方案 B：Agent Command Center

定位：把 AI 会话作为主工作区，代码、Git、终端成为可拉出的上下文工具。

布局：

- 中心区域默认是 Agent Timeline，展示消息、工具调用、计划、问题、运行状态。
- 左侧保留 Context Rail：文件、Git、需求、Todo 等作为上下文来源。
- 右侧改为 Inspector：当前工具调用详情、Diff、任务日志、引用文件预览。
- 编辑器不默认常驻，打开文件时以中间分屏或右侧 Inspector 形式出现。

适合场景：

- Polaris 希望区别于 VS Code 类 IDE，突出“多引擎 AI 编程助手”的产品定位。
- 用户主要从自然语言任务开始，而不是从文件编辑开始。
- 定时任务、需求管理是核心卖点。

实施重点：

- 将 `EnhancedChatMessages` 从右侧面板提升为可作为主区域的组件。
- `CenterStage` 支持 `agent`、`editor`、`matrix` 三种主视图。
- `RightPanel` 重命名为 `InspectorPanel`，可显示工具调用、Diff、日志、问题。
- QuickSwitch 由悬浮面板改为顶部或右侧固定的 Session Switcher。

风险：

- 对现有用户的肌肉记忆影响较大。
- 编辑器和 Git 用户可能觉得“代码空间变小”。
- 需要更多交互状态设计，工程量中等偏高。

## 方案 C：Focus IDE

定位：面向重度代码编辑与审查，最大化中间编辑区，把 AI 作为可折叠的专业协作面板。

布局：

- 中间编辑区始终是主角，支持 Editor、Diff、Image Preview、Problems。
- 左侧工具面板改成双层：窄 ActivityBar + 可固定的 Workspace Panel。
- 右侧 AI 面板变成可切换的 `Chat / Plan / Tools / Review` 四个标签。
- 底部增加 `Bottom Dock`：终端、任务日志、诊断、自动化运行记录。

适合场景：

- 用户把 Polaris 当成轻量 IDE 使用，代码、Diff、Git 是高频动作。
- 希望“AI 不打扰，但随时可用”。
- 适合桌面端宽屏和开发者长时间操作。

实施重点：

- 新增 `BottomDock` 状态，迁移 Terminal、Problems、Scheduler logs。
- `RightPanel` 内加入 Agent 子标签，不再所有 AI 附属功能挤在同一纵向流。
- `ActivityBar` 支持分组与二级入口，例如 Git 下聚合 changes/history/branch。
- EmptyState 改为工作台启动页：最近工作区、最近会话、快速命令。

风险：

- 需要重新梳理 Terminal、Problems、Scheduler 的归属。
- 小屏下需要明确“底部 Dock 折叠”策略。

## 推荐路线

短期推荐采用“方案 A + 方案 C 的底部 Dock 雏形”：

- 第一阶段先统一 Shell、面板头部、色彩层级，风险低且收益立刻可见。
- 第二阶段把 Terminal、Problems、Scheduler logs 向 Bottom Dock 聚拢，释放左侧 ActivityBar。
- 第三阶段再决定是否引入方案 B 的 Agent 主视图，作为可选布局模式而不是强制默认。

## 分阶段实施计划

### 阶段 0：设计系统收敛

- 新增 `src/styles/tokens.css` 或整理 `tailwind.config.js` token。
- 定义三层背景：`base`、`panel`、`control`。
- 定义边框策略：面板边界用 1px subtle，交互控件用 hover/active 背景，不依赖重阴影。
- 定义控件尺度：图标按钮 28/32px，工具栏 36px，标题栏 44px。

### 阶段 1：Shell 改造

- 从 `src/App.tsx` 抽出 `AppShell`，减少入口组件的布局职责。
- 新建 `CommandBar`，合并 TopMenuBar 中的工作区、ActivityBar 切换、AI 面板切换、窗口按钮。
- `ActivityBar` 增加分组渲染，插件贡献可以保留 order，同时补充分组字段或本地映射。

### 阶段 2：面板规范化

- 新增通用 `PanelHeader`、`PanelToolbar`、`PanelTabs`。
- FileExplorer、GitPanel、RequirementPanel 先迁移到统一头部。
- ChatInput 的容器视觉降噪，输入区保持清楚但不抢占消息主体。

### 阶段 3：布局能力增强

- `viewStore` 增加 `layoutMode: 'workbench' | 'agent' | 'focus'`。
- `CenterStage` 支持空编辑区启动页，而不是完全不渲染。
- 新增 Bottom Dock 状态：高度、折叠、当前 tab。

### 阶段 4：验证与回归

- 使用 Playwright 对 1280x800、1440x900、1920x1080、390x844 做截图回归。
- 检查长工作区名称、长文件路径、中文/英文界面、16 个多会话格子的溢出表现。
- 保留现有 Vitest 逻辑测试，新增 Shell 布局状态测试。

## 原型说明

原型文件：`docs/design/prototypes/polaris-layout-redesign.html`

包含三套可切换静态原型：

- `Workbench 2.0`：推荐短期默认方案。
- `Agent Center`：AI 主视图方案。
- `Focus IDE`：代码编辑优先方案。

原型不依赖构建工具，直接用浏览器打开即可查看。文件内已声明 `<meta charset="UTF-8">`，中文不会乱码。
