# 模块：UI 框架与通用组件

> ID: ui-framework | 复杂度: 中 | 变更频率: 中
> 依赖: React, lucide-react, i18next, zustand | 被依赖: 所有页面级组件

## 概述

应用 UI 骨架和通用组件库。Layout 模块实现 VSCode 风格三栏式主布局（ActivityBar + LeftPanel + CenterStage + RightPanel），支持面板折叠、尺寸拖拽、紧凑模式、多会话网格。Common 模块提供 15+ 个可复用基础组件（ErrorBoundary、ResizeHandle、Button、Dialog 系列等）。viewStore 作为布局状态唯一真相源，通过 zustand/persist 持久化面板宽度和折叠状态。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| App | `src/App.tsx` | 根组合：ErrorBoundary > Layout > TopMenuBar > 三栏 > 模态 |
| TopMenuBar | `src/components/TopMenuBar/index.tsx` | 标题栏：拖拽区 + 工作区切换 + 面板切换 + 窗口控制 |
| ActivityBar | `src/components/Layout/ActivityBar.tsx` | 左侧图标栏，展开/折叠双模式 |
| ActivityBarIcon | `src/components/Layout/ActivityBarIcon.tsx` | 单个图标按钮，带活跃指示条 |
| LeftPanel | `src/components/Layout/LeftPanel.tsx` | 可调整宽度的左侧边栏 + 内容切换器 |
| CenterStage | `src/components/Layout/CenterStage.tsx` | 中央编辑区：TabBar + TabContent + BreadcrumbBar |
| RightPanel | `src/components/Layout/RightPanel.tsx` | 右侧 AI 聊天面板，支持 fill-remaining 模式 |
| RadialMenu | `src/components/Layout/RadialMenu.tsx` | 扇形菜单（折叠模式）+ RadialMenuTrigger 悬浮球 |
| TabContextMenu | `src/components/Layout/TabContextMenu.tsx` | 标签页右键菜单 |
| QuickSwitchPanel | `src/components/QuickSwitchPanel/QuickSwitchPanel.tsx` | 边缘触发的会话快速切换面板 |
| ErrorBoundary | `src/components/Common/ErrorBoundary.tsx` | 全局错误边界：自动恢复(3s) + 心跳监控 + 白屏检测 |
| ResizeHandle | `src/components/Common/ResizeHandle.tsx` | 可拖拽分隔条，支持鼠标+触摸 |
| Button | `src/components/Common/Button.tsx` | 主题按钮：primary/secondary/danger/ghost x sm/md/lg |
| ConfirmDialog | `src/components/Common/ConfirmDialog.tsx` | 确认对话框（danger/warning/info） |
| InputDialog | `src/components/Common/InputDialog.tsx` | 文本输入对话框（含验证） |
| UnsavedDialog | `src/components/Common/UnsavedDialog.tsx` | 未保存文件对话框：保存/不保存/取消 |
| ConnectingOverlay | `src/components/Common/ConnectingOverlay.tsx` | 全屏连接遮罩：重试 + 诊断 + CLI 路径选择 |
| Toast | `src/components/Common/Toast.tsx` | ToastContainer 通知组件 |
| Icons | `src/components/Common/Icons.tsx` | 30+ 自定义 SVG 图标组件 |
| viewStore | `src/stores/viewStore.ts` | 布局状态：面板类型/宽度/折叠/紧凑模式/多会话网格 |
| tabStore | `src/stores/tabStore.ts` | 标签管理：打开/关闭/切换/脏标记 |
| useWindowManager | `src/hooks/useWindowManager.ts` | 编排紧凑模式同步、窗口透明度、快捷键 |
| useWindowSize | `src/hooks/useWindowSize.ts` | 跟踪窗口尺寸，计算 isCompact（阈值 500px） |

## 架构模式

### 1. 三栏可折叠布局（VSCode 模式）

```
+--------------------------------------------------------------------+
|  TopMenuBar (h-10, shrink-0)              [drag] [controls]        |
+------+------------------+---------------------+---------------------+
| Act  |   LeftPanel      |    CenterStage      |    RightPanel       |
| Bar  |   (resizable)    |   (flex-1)          |   (resizable)       |
| w-12 |   200-600px      |   TabBar+Editor     |   200-1200px        |
+------+------------------+---------------------+---------------------+
```

- TopMenuBar 固定 40px 高度
- 中间行 `flex flex-1 overflow-hidden relative`
- LeftPanel 条件渲染：`!isCompact && leftPanelType !== 'none'`
- CenterStage 条件渲染：`!isCompact && hasOpenTabs`
- RightPanel fill-remaining 模式：无 CenterStage 时 flex-1 填充

### 2. viewStore 单一真相源 + persist

```
viewStore (zustand + persist middleware, localStorage key: 'view-store')
  ├─ leftPanelType: 14 种值 ('files'|'git'|'todo'|...|'none')
  ├─ leftPanelWidth: 280px (范围 200-600)
  ├─ rightPanelWidth: 400px (范围 200-1200)
  ├─ rightPanelCollapsed: boolean
  ├─ activityBarCollapsed: boolean
  ├─ compactMode: { isCompactMode, windowWidth, windowHeight }
  ├─ multiSessionMode, multiSessionIds, multiSessionRows, ...
  └─ 14 个组件直接消费
```

`partialize` 排除 `pendingScrollToId`（一次性信号）等瞬态状态，避免持久化后产生脏值。

### 3. 面板切换 toggle 策略

```typescript
toggleLeftPanel(type):
  if (current === type) → 'none'   // 再次点击关闭
  else → type                       // 点击不同面板切换

switchToLeftPanel(type):
  始终打开，不做同类型关闭  // VSCode 风格
```

ActivityBar 图标使用 `toggleLeftPanel`（点击切换/关闭），其他入口使用 `switchToLeftPanel`（仅打开）。

### 4. 紧凑模式自适应

```
window resize → useWindowSize (threshold 500px)
  → useWindowManager → viewStore.updateCompactMode
    → App.tsx reads isCompact
      → 隐藏 LeftPanel, CenterStage
      → ActivityBar 强制 collapsed (半圆触发器)
      → TopMenuBar 简化（隐藏应用名/切换器/面板按钮）
      → RightPanel 独占全宽
```

### 5. RadialMenu 扇形菜单数学定位

```
items 沿 180° 弧形分布（CSS 坐标 -90° 到 +90°）
  → 每项位置 = 极坐标转直角坐标
  → fixed z-50 定位
  → 支持 hover-open (200ms 隐藏延迟) + click-open
  → ESC 关闭 + 100ms click-outside 延迟
```

ActivityBar 折叠时显示半圆触发器（RadialMenuTrigger），hover/click 展开扇形菜单。

### 6. 标签生命周期跨 Store 协调

```
tabStore (tabs 管理) ←→ fileEditorStore (文件缓冲区)
  closeTab → removeBuffer (清理编辑器缓冲区)
  syncEditorDirtyToTab (CenterStage 中同步脏标记)
```

tabStore 使用 persist 但 `tabs` 数组每次启动为空（不持久化标签列表）。脏标记从 fileEditorStore 实时同步。

## 数据流

### 面板切换流

```
用户点击 ActivityBar 图标
  → viewStore.toggleLeftPanel(type)
    → set({ leftPanelType: type | 'none' })
      → LeftPanel 重渲染（订阅 leftPanelType）
      → LeftPanelContent 切换内容面板
      → App.tsx 计算 hasLeftPanel，重渲染布局
```

### 窗口尺寸变化流

```
window resize event
  → useWindowSize (debounce 计算 isCompact)
    → useWindowManager.syncCompactMode
      → viewStore.updateCompactMode({ isCompactMode, windowWidth, windowHeight })
        → App.tsx 读取 isCompact → 条件渲染各面板
        → TopMenuBar 读取 isCompact → 简化/完整模式切换
```

### 标签页操作流

```
用户打开文件 (FileExplorer 双击)
  → tabStore.addTab({ type:'editor', filePath, name })
    → useFileEditorStore.openFile(filePath)
  → CenterStage 渲染 TabBar + TabContent
    → EditorPanel / DiffViewer / ImagePreview (按文件类型)

用户关闭标签
  → tabStore.closeTab(tabId)
    → checkTabDirty (读取 fileEditorStore.currentFile.isModified)
    → 如有未保存 → UnsavedDialog
    → fileEditorStore.removeBuffer(filePath)
    → activeTabId 切换到相邻标签
```

## 设计决策

| 决策 | 选择 | 原因 |
|------|------|------|
| 布局模型 | 三栏 Flexbox | VSCode 建立的心智模型，开发者用户熟悉 |
| 面板折叠 | DOM 条件移除 | 折叠时不渲染（非 display:none），减少 DOM 节点和内存占用 |
| 布局状态 | zustand/persist | 单一真相源，localStorage 自动持久化宽度和折叠状态 |
| 紧凑模式 | 500px 阈值 | 经验值，低于此宽度三栏无法正常显示 |
| ActivityBar 折叠 | 半圆触发器 + 扇形菜单 | 保留面板导航可达性，同时最小化占用空间 |
| 面板切换 | toggle 模式 | 再次点击同一图标关闭面板，符合 VSCode 交互习惯 |
| 右面板双模式 | fillRemaining / fixed-width | 无编辑器时 flex-1 填满，有编辑器时固定宽度可拖拽 |
| Tab 不持久化 | 每次启动 tabs=[] | 避免重启后引用已删除/重命名的文件，脏缓冲区无法恢复 |
| z-index | 无集中管理 | 多个组件共享 z-50 层，当前无冲突；大规模扩展时需引入 z-index token |
| Tailwind 内联 | 无独立 CSS 文件 | 布局样式全部 Tailwind utility，减少文件数量 |

## 已知陷阱

1. **ActivityBar/RadialMenu 面板列表重复定义**：相同的 12 个面板按钮列表在 `ActivityBar.tsx:76-137` 和 `RadialMenu.tsx:49-157` 独立定义。新增面板类型必须同步更新两处

2. **RadialMenu 额外面板项**：RadialMenu 的 menuItems 包含 `rightPanel` 和 `settings` 两个 ActivityBar 没有的项。三个列表（ActivityBar.panelButtons、RadialMenu.menuItems、LeftPanelContent）必须保持同步

3. **ResizeHandle delta 反转**：`position === 'left'` 时 delta 取反（向左拖动使面板变宽），`position` 还承担垂直方向语义（`left` = `top`）。新增 ResizeHandle 时容易搞错方向

4. **ResizeHandle 全局副作用无清理**：拖拽期间设置 `document.body.style.userSelect = 'none'` 和 `document.body.style.cursor`。如果组件在拖拽中卸载（如面板折叠），样式不会被清理，导致光标卡住

5. **Sidebar className 重复**：`Layout.tsx:53-66` 中 Sidebar 组件的 `className` 和 `widthClass` 通过 spread 和 JSX 同时传入，导致类名重复

6. **TabContextMenu 无视口边界检测**：使用 `fixed` + `e.clientX/clientY` 定位，菜单可能超出视口边界渲染到屏幕外

7. **dirty tab 检测依赖 currentFile**：`checkTabDirty` 依赖 `fileEditorStore.currentFile` 匹配 tab 的 filePath。如果快速切换标签导致 `currentFile` 为 null，脏检测可能遗漏

8. **z-50 层共享冲突**：RadialMenu、TabContextMenu、ConfirmDialog、InputDialog、UnsavedDialog、ErrorBoundary、ConnectingOverlay、SessionHistoryPanel 共 7+ 个组件使用 `z-50`。多个同时打开时可能遮挡

9. **QuickSwitchPanel z-20 被 z-50 遮挡**：QuickSwitchPanel 用 `z-20`，任何 z-50 组件打开时都会覆盖它

10. **RadialMenu click-outside 100ms 延迟**：`setTimeout(100ms)` 后才注册 `mousedown` 监听器，存在 100ms 窗口期内点击外部无效

11. **viewStore partialize 必须手动维护**：新增的瞬态状态必须加入 `partialize` 排除列表，否则持久化后产生脏值。目前排除了 `pendingScrollToId`，未来新字段容易遗漏

12. **closeOtherTabs 不处理脏标签**：`closeOtherTabs` 直接关闭所有其他标签，不检查脏状态。注释标注 "batch handling of dirty tabs" 但未实现

13. **Legacy 字段残留**：viewStore 仍包含 `showSidebar`/`showEditor`/`showDeveloperPanel`/`showGitPanel`/`sidebarWidth`/`editorWidth` 等旧字段，增加存储体积和理解成本

14. **Common/index.ts 聚合导出过重**：同时 re-export 了 Workspace、Settings、FileExplorer、TopMenuBar 等模块组件，形成不合理的跨模块聚合导出点

15. **ErrorBoundary 心跳检测**：使用定时器检测白屏，如果 ErrorBoundary 自身渲染失败，定时器也会丢失，导致无法自愈

## 最近变更

- 初始创建于 2026-04-20
- 文档升级至 A 级（2026-04-22）：补充 6 架构模式、3 数据流、10 设计决策、15 陷阱
