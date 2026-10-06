# sky 前端重写规划：对齐 Polaris 布局范式

## 现状诊断

当前 `shell.ts`（1210 行单文件模板字符串包 HTML+CSS+JS）是架构验证 demo，不是产品：

- 4 栏 grid（sessions|caps|chat|settings），手机端 Tab 切换
- 切 page 用 `display:none/block`，**children 真卸载**（聊天输入框/滚动位置切走再切回会丢）
- 设置页只有 AI 配置 + Session ID
- 主题 5 个 hardcoded preset + CSS 变量
- 自写 80 行正则做 Markdown，无语法高亮
- 无 ActivityBar 注册机制，插件无法贡献视图入口

## 原 Polaris 布局范式（已调研）

### 顶层结构

```
Layout (flex-col, h-100dvh)
├─ TopMenuBar (顶部全局栏: 窗口控制/工作区切换/状态)
└─ div.flex.flex-1 (主布局横向)
   ├─ ActivityBar (36px, 图标列, 可折叠 36px⇄8px)
   ├─ LeftPanel (可切换面板, 桌面停靠↔抽屉覆盖, 保活)
   │  └─ LeftPanelContent (按 currentType 切: files/git/todo/terminal/...)
   ├─ CenterStage (TabBar + Editor/DiffViewer/Browser/ImagePreview)
   ├─ RightPanel (AI 对话常驻, MultiSessionGrid + ChatInput)
   └─ [absolute 覆盖] SettingsPage (z-50, 主布局 inert)
```

### 关键设计原则（agent 调研修正版）

1. **保活（KeepAlive）**：App 主布局永不卸载。**LeftPanel 切 type 时子组件会卸载**（`LeftPanelContent` 用 if/else 返回单个组件，靠 React reconciliation 保留同位置状态，不是真保活）；真正常驻保活的是：MultiSessionGrid、RightPanel、LeftPanel **外壳本身**（切 type 时外壳不卸载，只换 children）。设置页 absolute 覆盖，主布局 `inert` 不卸载
2. **响应式双形态**：`isCompact`（小屏，**断点 500px**，不是 768px）翻转 LeftPanel 形态：桌面停靠（relative flex）↔ 抽屉覆盖（fixed overlay + 遮罩 `bg-black/50`）。**切形态不卸载 children**。compact 下 CenterStage 不渲染，由 `NarrowTabOverlay` 承接 tab
3. **ActivityBar 注册制**：图标从 `pluginRegistry.listViewContributions('activityBar')` 拉取，不硬编码。每图标 33px，`ResizeObserver` 算 `visibleCount`，溢出的进 ToolSwitcher 弹层（按 group 分：context/changes/run/automation/integrations/developer/system + rightPanel/settings 系统项）。插件 manifest 的 `contributes.views[].area='activityBar'` 贡献图标，`panelType` 决定点击切到哪个面板
4. **主题系统**：`.polaris-theme` JSON + **RGB 三元组字符串**（`--c-primary: 59 130 246`，配合 `rgb(var(--c-primary) / <alpha>)`）+ L0-L6 七层模型（colors/typography/shape/motion/immersive/layout/customCss）+ `flattenAndInject` 扁平化注入 `<html>` style + `data-theme` 属性。Tailwind config 把 `--c-*` 映射成 `bg-primary` 等 class
5. **Tab 系统**：CenterStage 是 Tab 驱动（`tabStore`），Tab 类型：editor/diff/git/browser/preview/插件。可拖拽排序/钉住/右键菜单。compact 下 CenterStage 不渲染，tab 由 `NarrowTabOverlay` 承接
6. **i18n**：react-i18next，18 个 namespace 按模块拆分（common/settings/chat/git/...），语言偏好存 localStorage
7. **插件面板注册**：`pluginPanelRegistry` 全局单例 Map，`register(panelType, pluginId, loader)`。插件 manifest `contributes.panel.entry` + `contributes.views[].panelType` 两段式声明。`LeftPanelContent` fallback 分支 `pluginPanelRegistry.has(type)` → `<PluginPanelHost panelType={type} />` 懒加载
8. **viewStore 持久化**：zustand `persist` middleware，`name: 'view-store'`（localStorage）。持久化面板宽度/折叠状态/compactMode/panelStates。`LeftPanelType` 是 `string` 别名，值来自内置 + 插件注册

### sky 与原 Polaris 的范式差异

| 维度 | 原 Polaris | sky 现状 | 重写方向 |
|---|---|---|---|
| 渲染框架 | React + Tailwind + zustand | 原生 JS + 模板字符串 | **保留原生 JS**（零构建优势），但拆成模块化组件函数 + 状态机 |
| 布局 | ActivityBar + Left + Center + Right | 4 栏 grid + Tab | ActivityBar(左 36px) + LeftPanel(可切换) + CenterStage(聊天/编辑) + RightPanel(会话列表/工具) |
| 保活 | React reconciliation | display:none（真卸载） | 用 `hidden` 属性 + 显式 state 守护，切 page 时保留 children DOM |
| 主题 | .polaris-theme JSON + Tailwind | 5 preset + hex 变量 | 引入 .polaris-theme 兼容格式 + RGB 三元组变量 |
| ActivityBar | 注册制 + 插件贡献 | 固定 4 Tab | 注册制：内置（会话/文件/能力/设置）+ AI/插件可动态加图标 |
| 设置 | 23 tab | 1 个 AI 配置 | 至少 8 tab：通用/AI/模型/主题/快捷键/插件/数据/关于 |
| 编辑器 | Editor + LSP + DiffViewer | 无 | 暂不做编辑器，CenterStage 用 Tab 承载聊天 + 未来的编辑器 |

## 重写策略

### 核心决策：保留单文件零构建，但内部模块化

**理由**：sky 的核心优势是"零编译，tsx 直跑"。引入 React + Vite 会破坏这个优势，且原 Polaris 的 React 组件依赖大量基础设施（zustand/i18n/Tailwind 配置），移植成本极高。

**做法**：`shell.ts` 仍是一个模板字符串，但内部代码组织成清晰的模块：
- `state` 对象（替代 zustand）：`{ activeLeftPanel, rightPanelCollapsed, theme, ... }`
- `render` 函数族：`renderActivityBar() / renderLeftPanel() / renderCenterStage() / renderRightPanel() / renderTopBar()`
- 每个面板有 `mountXxx()` 初始化 + `unmountXxx()` 清理
- 保活：面板用 `hidden` 属性切换显隐，不 `display:none`，children DOM 保留

### 阶段划分

#### Phase 1：布局骨架重构（不动功能）
- 拆 `shell.ts` 为 `Layout` 概念：TopBar + ActivityBar + LeftPanel + CenterStage + RightPanel
- 实现 ActivityBar 注册制（图标数组，溢出进 ToolSwitcher）
- 实现 LeftPanel 保活切换（hidden 而非 display:none）
- 实现 RightPanel 常驻
- 响应式：小屏 ActivityBar 折叠 + LeftPanel 抽屉模式
- 设置页 absolute 覆盖（不卸载主布局）

#### Phase 2：主题系统对齐
- 引入 `.polaris-theme` JSON 格式（RGB 三元组）
- CSS 变量从 `--sky-*` hex 改为 `--c-*` RGB（配合 `rgb(var(--c-primary))`）
- 主题编辑器（基础版：色板编辑 + 预览 + 导入导出）
- 主题持久化到 `cap.ui.theme`

#### Phase 3：设置页扩展
- Tab 系统：通用 / AI 配置 / 模型供应商 / 主题 / 快捷键 / 插件 / 数据存储 / 关于
- 每个 tab 一个 render 函数
- 接 `cap.config` 真实读写

#### Phase 4：会话/聊天体验深化
- 会话列表：搜索/置顶/重命名/批量删除/预览
- 聊天：Markdown 真渲染（marked 或自写增强）+ 代码高亮 + 消息分组 + 输入区增强
- 工具块：展开全文/复制/折叠持久化

#### Phase 5：编辑器（可选，工作量大）
- CenterStage 承载 Tab：聊天 Tab + 文件编辑 Tab
- 接 `cap.fs.read/write` + `cap.edit`（待实现）
- 简单 Monaco/CodeMirror 集成或纯 textarea + 语法高亮

### 不做完整 React 迁移的理由

原 Polaris 的 React 组件树深度依赖：
- zustand stores（viewStore/tabStore/workspaceStore/...）
- react-i18next
- Tailwind + 主题 class 系统
- 懒加载/lazy + Suspense
- 插件面板注册（pluginPanelRegistry）
- LSP/tree-sitter/DiffViewer

迁移这些到 sky 等于重建 Polaris，违背"sky 是简化复刻"的定位。保留原生 JS 模块化，能在保持零构建优势下拿到 80% 的体验提升。

## Phase 1 详细设计

### DOM 结构

```html
<div id="sky-root">  <!-- flex-col h-100dvh -->
  <div id="sky-topbar">...</div>
  <div id="sky-main" class="flex flex-1">
    <div id="activity-bar">  <!-- 36px, 图标列 -->
      <div class="ab-icons">  <!-- 动态注册的图标 -->
        <button data-panel="sessions">...</button>
        <button data-panel="files">...</button>
        ...
      </div>
      <div class="ab-bottom">
        <button data-action="settings">⚙</button>
      </div>
    </div>
    <div id="left-panel" data-type="sessions">  <!-- 可切换 -->
      <div class="lp-content" data-key="sessions">...</div>  <!-- 保活: hidden 切换 -->
      <div class="lp-content" data-key="files" hidden>...</div>
    </div>
    <div id="center-stage">  <!-- Tab + 聊天 -->
      <div id="tab-bar">...</div>
      <div id="tab-content">...</div>
    </div>
    <div id="right-panel">  <!-- 常驻 -->
      <div id="session-list">...</div>
      <div id="chat">...</div>
    </div>
  </div>
  <div id="settings-overlay" hidden>  <!-- absolute 覆盖 -->
    ...
  </div>
</div>
```

### 状态机

```js
const state = {
  activeLeftPanel: 'sessions',  // 'sessions' | 'files' | 'caps' | 'terminal' | ...
  leftPanelWidth: 240,
  rightPanelCollapsed: false,
  rightPanelWidth: 340,
  activityBarCollapsed: false,
  isCompact: window.innerWidth < 768,
  tabs: [],  // CenterStage tabs
  activeTabId: null,
  settingsOpen: false,
  settingsTab: 'general',
  theme: 'dark',
};
```

### ActivityBar 注册制

```js
const activityBarItems = [
  { id: 'sessions', icon: 'ic-chat', label: '会话', panel: 'sessions' },
  { id: 'files', icon: 'ic-caps', label: '文件', panel: 'files' },
  { id: 'caps', icon: 'ic-tool', label: '能力', panel: 'caps' },
  // 插件可 push 新项
];
// 渲染时按容器高度计算可见数, 溢出的进 ToolSwitcher 弹层
```

### 保活机制

原 Polaris 的 `LeftPanelContent` 用 if/else 返回**单个**子组件，切 type 时子组件**会卸载**（靠 React reconciliation 保留同位置状态）。sky 用原生 JS 可以做得更好 —— 用 `hidden` 属性切换显隐，children DOM **真保活**：

```js
function switchLeftPanel(type) {
  state.activeLeftPanel = type;
  document.querySelectorAll('.lp-content').forEach(el => {
    el.hidden = el.dataset.key !== type;
  });
  // children DOM 保留, 输入框焦点/滚动位置不丢
}
```

这是 sky 相对原 Polaris 的体验优势（原生 JS 不需要 React reconciliation 来保留状态）。

### 响应式

- `isCompact` 断点 **500px**（对齐原 Polaris，不是 768px）
- 小屏（<500px）：ActivityBar forceCollapsed（8px）+ LeftPanel 抽屉模式（fixed overlay + `bg-black/50` 遮罩）+ CenterStage 不渲染 + RightPanel forceShow 堆叠
- 桌面（≥500px）：ActivityBar 36px + LeftPanel 停靠 + 四栏 flex
- 跨越断点时只切形态，不卸载 children（与原 Polaris 一致）

### 工作量评估

- Phase 1：~1500 行 shell.ts 重写（DOM 结构 + 状态机 + ActivityBar 注册 + 保活 + 响应式）
- 不动后端 cap，纯前端
- 验证：浏览器实测各尺寸 + 切换保活 + 设置覆盖

## 待决策项

1. **CenterStage 初始承载什么**：聊天放 RightPanel（原 Polaris 范式）还是 CenterStage？原 Polaris 聊天在 RightPanel，CenterStage 是编辑器。sky 没编辑器，建议聊天放 CenterStage（主视野），RightPanel 放会话列表 + 工具块状态
2. **是否引入 Tailwind**：原 Polaris 用 Tailwind + RGB 变量。sky 保留原生 CSS 也能做，但 Tailwind 效率高。引入 Tailwind 需要 PostCSS 构建，破坏零编译。**建议保留原生 CSS**
3. **会话列表放哪**：原 Polaris 在 RightPanel 顶部。sky 现在在 LeftPanel。建议跟随原 Polaris 放 RightPanel
