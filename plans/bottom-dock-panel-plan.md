# 底部 Dock 面板方案

> 目标：解决当前"功能挤占左面板单槽 + AI 对话与编辑/输出类功能横向零和"的布局问题。
> 范围：新增底部 Dock 层，迁移输出类/终端类功能，定义统一面板容器模型。
> 仅分析与设计，不实施。

---

## 0. 设计论证：自由拖动 vs 受控 Dock（关键决策）

用户提出三点诉求：① 加大信息密度 ② 支持自由拖动位置 ③ 样式优化。其中"自由拖动"是架构级决策，必须论证而非直接堆功能。

### 0.1 现状约束（证据）

- **无拖拽基础设施**：`package.json` 无 react-draggable / react-rnd / @dnd-kit / react-grid-layout；全仓仅 `MarkdownImageViewer`、`ImagePreview` 两个图片查看器有自研 drag（与面板拖动语义不同）。
- **插件模型单一**：`PluginViewArea = 'activityBar'`（`plugin-system/types.ts:5`），插件只能注册到 ActivityBar 单一区域；`PluginPanelComponent` props 无容器位置信息（`types.ts:156-159`）。
- **viewStore 单槽互斥**：`leftPanelType: string`，同一时刻一个左面板（`viewStore.ts:31`）。
- **透明度耦合**：`--window-opacity` 复合到 `bg-background-*`，浮动面板脱离主 flex 流后变量仍在 `:root` 可继承，但 z-index / 焦点 / 小屏 `isCompact`（`App.tsx:128`）需单独处理。

### 0.2 三条技术路径

| 路径 | 描述 | 代价 | UX 收益 |
|------|------|------|---------|
| A. 全自由浮动 | 任意面板可拖成浮窗，自由摆放 | 高：引入拖拽库或自研窗口管理（z-index/聚焦/碰撞/吸附/持久化坐标），破坏 flex 主轴，小屏灾难，插件 API 大改 | 灵活但易乱，多数用户摆一次就不再动；窗口重叠遮挡对话 |
| B. 停靠边可切换 | 面板可在 left/bottom/right 间切换停靠边（VSCode 式拖 tab 到边缘） | 中：复用 ResizeHandle，viewStore 增 `dockSide` 字段，渲染层按 side 分流 | 实用，但右面板已被 AI 对话独占，可停靠边实际只有 left/bottom |
| C. 固定底部 Dock + 可拖拽 Tab 顺序 | Dock 位置固定在底部，Tab 可拖拽重排、可拖出到浮动窗 | 低-中：Dock 本身复用现有 flex；Tab 拖拽排序用自研轻量 dnd（同 CenterStage TabBar 量级）；"拖出成窗"作为高级特性可选 | 兼顾稳定与灵活，符合 IDE 用户习惯 |

### 0.3 决策：采用 C，保留 B 的停靠边扩展位

**理由（基于证据，非为实现而实现）：**

1. **信息密度的真正瓶颈是"宽度"而非"位置自由度"**。Terminal 的 FitAddon（`TerminalPanel.tsx:127`）会随容器宽度自动增加列数——只要给它底部全宽，密度问题就解决了 80%，不需要自由拖动。Problems 同理（280px 单列 → 全宽表格）。
2. **自由浮动与"AI 对话为主"的产品定位冲突**。Polaris 主轴是对话，浮动窗口会遮挡对话、打断流式阅读。VSCode 允许自由浮动是因为它没有"持续输出的主区"，Polaris 有。
3. **成本不对等**。路径 A 需引入窗口管理系统（数千行 + 持久化坐标 + 小屏适配崩坏），但带来的边际收益低于路径 C 的"固定 Dock + Tab 拖拽 + 可选拖出"。
4. **渐进可行**。路径 C 的 Dock 骨架与路径 B 的 `dockSide` 字段不冲突——未来若要支持"把终端 Dock 移到右侧"，只需让 `dockSide` 取值从 `'bottom'` 扩展到 `'right'`，渲染层分流即可。先 C 后 B 的演进路径是开通的。

**因此：不实现"任意位置自由拖动"，而是实现"固定底部 Dock + Tab 可拖拽排序 + 单 Tab 可拖出为浮窗（高级特性，Phase 3）"。** 这是信息密度、稳定性、实现成本三者的最佳平衡。

---

## 1. 背景与问题

当前布局为单主轴横向 flex（`App.tsx:218`）：

```
ActivityBar | LeftPanel(单槽互斥) | CenterStage(编辑器) | RightPanel(AI 对话)
```

核心矛盾：

1. **左面板单槽互斥**（`LeftPanelContent` 同一时刻只渲染 1 个，`LeftPanel.tsx:197-227`）：Terminal / Problems / Scheduler 日志 / aiConsole 这类"横向窄、纵向长"的功能与 FileExplorer / Git 抢同一个 280px 槽位，用 A 必须丢 B。
2. **横向零和**：AI 对话 + 编辑器 + 左面板三者平分一条横向空间，无垂直维度利用。
3. **终端只能靠全屏**（`terminalFullscreen`）解决问题，从"挤"跳到"全覆盖"，无中间态。
4. **输出类功能无处安身**：终端、Problems、构建日志、Scheduler 运行日志本质是"窄高"面板，强行塞进左面板或浮层都是错配。

## 2. 设计目标

- 引入**底部 Dock 层**，承载"横向窄、纵向长、可与对话/编辑器并行查看"的功能。
- 释放左面板，让其回归"纵向窄"功能（文件树、Git 导航）。
- 保持 AI 对话与编辑器在主区的并行能力，底部 Dock 与它们**纵向共存而非横向抢占**。
- 复用现有 `ResizeHandle`（已支持 `direction='vertical'`）、`viewStore` 持久化、插件面板注册机制。
- 不破坏现有持久化与插件 API，增量迁移。

## 3. 目标布局层次

```
Layout (h-screen, flex-col)
├─ TopMenuBar
├─ 主区行 (flex flex-1, 横向)
│  ├─ ActivityBar
│  ├─ LeftPanel          ← 回归纵向窄功能(files/git/...)
│  ├─ CenterStage        ← 编辑器/Diff/Browser
│  └─ RightPanel(AI 对话)
└─ BottomDock (新增)     ← 跨主区全宽，纵向可调高
    ├─ DockTabBar        ← 多 Tab 并存，非互斥
    ├─ DockContent       ← 当前激活 Tab 内容
    └─ DockResizeHandle  ← 顶部拖拽调高
```

关键变化：BottomDock 位于主区行**之下**、与 TopMenuBar 同级的 flex 子项，横向占满，**不进入主区横向 flex**，从而避免与 AI 对话/编辑器争横向空间。

## 4. 状态模型（viewStore 扩展）

新增字段，全部持久化（复用 `persist` 中间件）：

```ts
interface ViewState {
  // ...现有字段...
  bottomDockOpen: boolean;          // 是否展开
  bottomDockHeight: number;         // 像素高度，默认 240
  bottomDockActiveTab: BottomDockTabId; // 当前激活 Tab
  bottomDockTabs: BottomDockTabId[];    // 已开启的 Tab 列表（可多开，非互斥）
}

type BottomDockTabId =
  | 'terminal'      // 终端（从左面板迁移）
  | 'problems'      // 问题面板（从左面板迁移）
  | 'schedulerLog'  // 调度器运行日志
  | 'aiConsole'     // AI 执行控制台（从左面板迁移）
  | 'output'        // 通用输出（构建/命令）
  | string;         // 插件动态注册的 dock 面板
```

新增操作：

```ts
interface ViewActions {
  toggleBottomDock: () => void;
  setBottomDockOpen: (open: boolean) => void;
  setBottomDockHeight: (h: number) => void;
  openBottomDockTab: (tab: BottomDockTabId) => void;   // 加入 tabs 并激活
  closeBottomDockTab: (tab: BottomDockTabId) => void;
  switchBottomDockTab: (tab: BottomDockTabId) => void;
}
```

约束：
- `bottomDockHeight` 范围 `120 ~ window.innerHeight * 0.7`，超出钳制。
- 小屏模式（`isCompact`）下 BottomDock 强制以全屏覆盖式渲染（类似 LeftPanelDrawer），不挤压主区。
- `terminalFullscreen` 语义保留，但改为"BottomDock 最大化到主区高度"，复用同一容器。

## 5. 组件设计

> 样式约定见下方第 12 节「样式规范」。所有类名一律使用 Tailwind 语义 token（`bg-background-*` / `text-text-*` / `border-border-*`），禁止写死 hex。

### 5.1 BottomDock.tsx（新建，`src/components/Layout/BottomDock.tsx`）

```tsx
interface BottomDockProps {
  children: ReactNode;
}
```

行为：
- `bottomDockOpen === false` → 渲染一条窄触发条（`h-7 bg-background-elevated border-t border-border-subtle`），点击展开。
- 展开：根容器 `h-[var(--bottom-dock-height)]`，顶部挂 `<ResizeHandle direction="vertical" position="left" onDrag={...} />`（vertical 模式下 position='left' 等价顶部，见 `ResizeHandle.tsx:49`）。
- 拖拽：`delta` 取反后 `setBottomDockHeight(clamp(height - delta))`（向上拖增大）。
- 内部结构：`DockTabBar` + `DockContent`，沿用 `border-b border-border-subtle` 分隔惯例。

根容器基础类名：

```tsx
<aside className="flex flex-col bg-background-elevated border-t border-border-subtle shrink-0" />
```

> 注意用 `border-subtle` 而非 `border`，与 CenterStage 内分隔条（`CenterStage.tsx:258/467`）保持一致的"次级分隔"语义。

### 5.2 DockTabBar（内联于 BottomDock）

- 横向 Tab 列表，可多开（区别于 LeftPanel 单槽）。
- 视觉复用 CenterStage TabBar 规范（`CenterStage.tsx:264-309`）：
  - 容器：`h-9 flex items-center gap-1 px-2 bg-background-surface border-b border-border-subtle overflow-x-auto`
  - Tab 项：`flex items-center gap-2 px-3 py-1.5 rounded-t-md min-w-[120px] max-w-[200px] cursor-pointer select-none`
  - 激活态：`bg-background-base text-text-primary border-t-2 border-primary`
  - 非激活：`text-text-secondary hover:text-text-primary hover:bg-background-hover`
  - 关闭按钮：`opacity-0 group-hover:opacity-100`（dirty/有 badge 时常驻）
- 右侧工具区：最大化按钮、收起按钮，沿用 `ActivityBarIcon` 的 `w-7 h-7 rounded-md text-text-secondary hover:text-text-primary hover:bg-background-hover` 规范。

### 5.3 DockContent

容器：`flex-1 min-h-0 overflow-hidden bg-background-base`。根据 `bottomDockActiveTab` 渲染：

```tsx
function DockContent() {
  const tab = useViewStore(s => s.bottomDockActiveTab);
  switch (tab) {
    case 'terminal': return <TerminalPanel dockMode />;
    case 'problems': return <ProblemsPanel dockMode />;
    case 'schedulerLog': return <SchedulerLogView />;
    case 'aiConsole': return <ExecutionConsolePanel />;
    case 'output': return <OutputPanel />;
    default:
      if (pluginDockRegistry.has(tab)) return <PluginPanelHost panelType={tab} dock />;
      return null;
  }
}
```

`dockMode` prop：面板内部感知自己是"窄高"渲染，可隐藏二级侧栏、调整字号、启用横向滚动而非换行。

### 5.4 主区高度让位

`App.tsx` 主区行需改为：

```tsx
<div className="flex flex-1 overflow-hidden flex-col relative">
  <div className="flex flex-1 overflow-hidden">{/* 原横向主区 */}</div>
  {!isCompact && <BottomDock />}
  {isCompact && bottomDockOpen && <BottomDockDrawer />}
</div>
```

即主区行从横向 flex 变为纵向 flex（主区横排 + 底部 Dock），BottomDock 以 `flex-col` 第二项存在。

## 6. 插件面板容器扩展

当前 `panelRegistry.ts` 注册的面板统一进左面板槽。扩展为支持声明容器类型：

```ts
type DockContainer = 'left' | 'bottom' | 'floating';

interface PluginPanelRegistration {
  pluginId: string;
  container: DockContainer;   // 新增，默认 'left'
  loader: PluginPanelLoader;
}
```

`LeftPanelContent` 只渲染 `container === 'left'` 的面板；`DockContent` 渲染 `container === 'bottom'` 的面板。向后兼容：未声明 container 的旧插件默认 `'left'`，行为不变。

`ActivityBar` 的 `toolSwitcherData` 需区分：底部 Dock 类功能图标点击时调 `openBottomDockTab` 而非 `toggleLeftPanel`。

## 7. 功能迁移清单

| 功能 | 现位置 | 目标位置 | 容器 | 备注 |
|------|--------|----------|------|------|
| Terminal | LeftPanel + terminalFullscreen | BottomDock 'terminal' | bottom | 移除左面板 terminal 分支；fullscreen 改为 dock 最大化 |
| Problems | LeftPanel | BottomDock 'problems' | bottom | 释放左面板槽 |
| aiConsole (ExecutionConsole) | LeftPanel | BottomDock 'aiConsole' | bottom | 输出类，适合底部 |
| Scheduler 日志 | SchedulerPanel 内抽屉 | BottomDock 'schedulerLog' | bottom | 现有 `schedulerLogDrawerHeight` 可并入 dock 高度 |
| Git | LeftPanel + CenterStage Tab | 维持左面板 | left | 导航类，纵向窄，保留 |
| FileExplorer | LeftPanel | 维持 | left | 纵向窄 |
| Browser | LeftPanel + CenterStage Tab | 维持 CenterStage Tab | center | 需要大画面 |
| Translate/Todo/Requirement/Developer/Integration | 维持左面板 | left | 视后续评估，暂不动 |

迁移原则：**先迁输出/终端类（收益最高、冲突最甚），其余维持现状**，降低风险。

## 8. 约束与边界

- 高度钳制：`max(bottomDockHeight) = innerHeight * 0.7`，`min = 120`。拖拽时实时读 `window.innerHeight`。
- 持久化：`bottomDockTabs` 持久化可能导致已卸载插件 Tab 残留 → 渲染前过滤无效 Tab（`pluginDockRegistry.has` 校验）。
- 小屏：`isCompact` 时 BottomDock 转为 `BottomDockDrawer`（全屏覆盖），避免主区被压没。
- 性能：Dock 内终端/日志组件保持懒加载（沿用现有 lazy 策略）。
- 焦点：Dock 展开时不抢占 AI 输入框焦点；终端 Tab 激活时聚焦终端。
- 快捷键：新增 `Mod+J` 切换 BottomDock（对标 VSCode 终端面板），`Mod+Ctrl+J` 最大化。

## 9. 兼容性

- viewStore `persist` 增量字段，旧持久化无新字段时取默认值，无破坏。
- `terminalFullscreen` 语义改为 dock 最大化，调用方（`toggleTerminalFullscreen`）内部转调 `setBottomDockHeight(max)` + `openBottomDockTab('terminal')`，保持快捷键行为。
- 插件 `panelRegistry` 新增 `container` 可选字段，缺省 `'left'`，旧插件零改动。
- `LeftPanelContent` 移除 terminal/problems/aiConsole 分支后，旧 `leftPanelType === 'terminal'` 持久化值需在 `onRehydrateStorage` 回退到 `'files'`（已有 comicStudio 回退先例，`viewStore.ts:289`）。

## 10. 分阶段实施

### Phase 1：骨架与状态（低风险，可独立交付）
- viewStore 新增 bottomDock 字段与操作。
- 新建 BottomDock.tsx + DockTabBar + DockContent 骨架，仅接入 'terminal'。
- App.tsx 主区改纵向 flex，挂载 BottomDock。
- 快捷键 Mod+J。

### Phase 2：迁移输出类功能
- Problems / aiConsole / SchedulerLog 迁入 Dock，移除左面板对应分支。
- onRehydrateStorage 回退旧 leftPanelType。
- terminalFullscreen 改为 dock 最大化。

### Phase 3：插件容器扩展
- panelRegistry 增加 `container` 字段。
- ActivityBar/toolSwitcherData 区分 left/bottom 入口。
- 插件 SDK 文档更新。

### Phase 4：体验打磨
- Dock Tab 拖拽重排、最大化/还原动画。
- 小屏 BottomDockDrawer。
- 各面板 `dockMode` 适配（字号、二级侧栏隐藏）。

## 11. 验证项

- [ ] 开关 BottomDock 不影响 AI 对话与编辑器布局。
- [ ] 终端在 Dock 中横向宽度充足（跨主区全宽），无需全屏即可舒适使用。
- [ ] 多 Tab 并存：Terminal + Problems 同时打开可切换，不互斥。
- [ ] 拖拽高度在窗口缩放后仍合法（钳制）。
- [ ] 旧持久化用户首次升级无白屏、无报错。
- [ ] 小屏模式 Dock 不压没主区。
- [ ] 插件旧面板仍出现在左面板，零改动。

## 12. 风险

- **主区改纵向 flex** 可能影响现有 `hasCenterStage`/`rightPanelFillRemaining` 逻辑，需回归测试编辑器开关、右面板填充、终端全屏三条路径。
- **Scheduler 日志迁移** 涉及 `schedulerLogDrawerHeight` 状态合并，需保证不丢失高度设置。
- **terminalFullscreen 语义变更** 有多处调用方，需全量检索替换。

---

## 13. 信息密度优化（诉求①落点）

底部 Dock 全宽后，各面板从"窄高单列"升级为"宽矮多列/多栏"，密度提升有据可依：

### 13.1 Terminal（密度提升最高，零改造）
- 现状：xterm + FitAddon（`TerminalPanel.tsx:114/127`），容器宽度直接决定显示列数。左面板 280px 槽约 80 列，长命令被折行。
- Dock 后：底部全宽（典型 1200px+）→ 自动 200+ 列，长命令/git diff/构建日志不再折行。
- **零改造成本**：FitAddon 已自适应，仅需保证 Dock 容器有有效尺寸（注意 `TerminalPanel.tsx:99` 的零尺寸防御，Dock 展开时需触发 fit）。
- 字号：保持 14px / lineHeight 1.2（`TerminalPanel.tsx:107-108`），Dock 高度足够时无需缩小。

### 13.2 Problems（单列 → 表格多列）
- 现状：单列纵向（`ProblemsPanel.tsx:127-147`），每条 `truncate` 截断路径，280px 下 message 和 path 都丢信息。
- Dock 后：底部全宽可改**表格布局**——`文件 | 行:列 | 严重度 | 消息 | source`，单条密度提升 3-5 倍，无需展开即看清全貌。
- 保留 `dockMode` prop：左面板渲染时用单列紧凑模式，Dock 渲染时用表格模式（复用 DeveloperPanel `fillRemaining` 双模式先例，`DeveloperPanel.tsx:160`）。

### 13.3 Scheduler（消除嵌套抽屉）
- 现状：`schedulerLogDrawerHeight` 内部抽屉（`viewStore.ts:40`）在左面板内嵌套展开，高度受限、与列表争空间。
- Dock 后：日志直接作为 Dock Tab，抽屉层级消除，日志区获得全宽 + 可调高度。
- 迁移时 `schedulerLogDrawerHeight` 可并入 `bottomDockHeight`，或保留为 Dock 内二级折叠。

### 13.4 AI 控制台 / ExecutionConsole
- 现状：输出日志类，左面板窄槽下时间戳 + tool 名 + 参数挤一行。
- Dock 后：全宽下 `时间戳 | tool | 参数 | 结果` 可对齐分列，可读性显著提升。

### 13.5 通用密度规范
- Dock 内容区统一 `text-xs`（12px）/ `font-mono`，行高 `leading-5`（20px），比左面板 `text-sm` 更紧凑。
- 时间戳/行号等次要信息用 `text-text-tertiary`，主信息 `text-text-secondary`，建立层级而非全同色。
- 表格/列表行 `py-1`（4px）而非左面板的 `py-1.5`，垂直密度提升。
- 多列布局用 `grid` 而非 flex，保证列对齐（Problems 表格、日志分列）。

---

## 14. 样式规范（对齐项目真实体系）

项目样式体系（`tailwind.config.js` + `src/index.css`）特征：

1. **Tailwind 工具类 + CSS 变量 token**：颜色以 `R G B` 三元组存于 `--c-*` 变量，经 `rgb(var(--c-xxx) / <alpha-value>)` 暴露为语义类。**禁止在组件中写死 hex**（原型展示除外）。
2. **双主题**：Dark 默认 / Light `:root[data-theme="light"]`，切换仅替换变量值。所有颜色必须走 token，否则主题切换失效。
3. **窗口透明度**：`--window-opacity` 复合到 `bg-background-*`（base/elevated/surface/hover/active），`border-border-*` 与 `text-text-*` 不复合（保持可见性）。BottomDock 作为主区子项必须使用 `bg-background-elevated` 以继承透明度。

---

| 用途 | 错误（hex） | 正确（语义 token） |
|------|------------|-------------------|
| 面板背景 | `bg-[#21252b]` | `bg-background-elevated` |
| 内容区背景 | `bg-[#1a1d23]` | `bg-background-base` |
| Tab 栏背景 | `bg-[#262b33]` | `bg-background-surface` |
| 悬停背景 | `bg-[#2d333b]` | `bg-background-hover` |
| 主分隔线 | `border-[#3a4049]` | `border-border` |
| 次级分隔 | `border-[#2c313a]` | `border-border-subtle` |
| 主文字 | `text-[#e6e8eb]` | `text-text-primary` |
| 次文字 | `text-[#aeb4bd]` | `text-text-secondary` |
| 弱文字 | `text-[#717a85]` | `text-text-tertiary` |
| 激活强调 | `text-[#5b8cff]` | `text-primary` |
| 状态-成功 | — | `text-status-success` / `bg-success-faint` |
| 状态-警告 | — | `text-status-warning` / `bg-warning-faint` |
| 状态-错误 | — | `text-status-danger` / `bg-danger-faint` |

### 13.2 复用既有规范

- **面板头高度**：统一 `h-9`（36px，见 `LeftPanelDrawer.tsx:139`）或 `h-10`（40px，见 `CenterStage.tsx:258`）。DockTabBar 取 `h-9`。
- **ActivityBar 图标**：`w-12` 宽，图标按钮 `w-10 h-10 rounded-md`（`ActivityBar.tsx:65`）。Dock 工具按钮缩小为 `w-7 h-7 rounded-md`。
- **过渡**：统一 `transition-colors`（颜色类），布局尺寸用 `transition-all duration-200`。
- **圆角**：`rounded-md`（按钮/Tab）、`rounded-t-md`（Tab 顶部）、`rounded-lg`（卡片）。
- **ResizeHandle**：直接复用 `<ResizeHandle direction="vertical" position="left" />`，已有 `bg-white/20 hover:bg-primary/70` 悬停态（`ResizeHandle.tsx:120-121`）——注意此处 `bg-white/20` 是组件内既定实现，Dock 不需额外覆盖。
- **滚动条**：全局 `::-webkit-scrollbar` 已定义（`index.css:150-194`），Dock 内容区无需自定义。
- **阴影**：抽屉/浮层用 `shadow-soft` / `shadow-medium`（`tailwind.config.js` boxShadow），Dock 作为内嵌面板不加阴影，仅 `border-t` 分隔。

### 13.3 主题适配要点

- Tab 激活态 `border-t-2 border-primary` 在 Light/Dark 下均取 `--c-primary`，无需额外处理。
- 状态色（problems 计数 badge、scheduler 运行状态）使用 `bg-success-faint` / `bg-warning-faint` / `bg-danger-faint`（已定义 `faint` 变体，0.15 alpha），主题切换自动适配。
- **禁止**在 Dock 内复刻 `index.css` 里 Git 面板那种写死 hex 的 `.git-*` 类——那些是历史遗留，新组件一律走 Tailwind token。
