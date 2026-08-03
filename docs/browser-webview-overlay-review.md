# 内置浏览器 WebView 覆盖问题 — 方案评审

> 评审日期：2026-08-03
> 评审范围：历史会话分析中提出的"三层防御"方案，结合项目现有架构、Spider-Man 主题系统、已存在文档进行全面评审
> 状态：已评审，待实施

---

## 1. 评审结论

**方案可行，但需调整分层策略和实施顺序。** 原方案中"P0 状态驱动 → P1 声明式守卫 → P2 增强检测"的三层递进架构合理，但存在以下待修正项：

| 问题 | 严重性 | 修正 |
|------|--------|------|
| App.tsx 状态迁移范围估计不足 | 🔴 阻塞 | 4 个 `useState` 关联 `useWindowManager` 等 3 个 hooks，需连锁调整 |
| OFFSCREEN_BROWSER_BOUNDS 修正与状态驱动解耦 | 🔴 阻塞 | 两件事独立，应先修 OFFSCREEN 再建 overlayStore |
| `<BrowserOverlayGuard>` 命名冲突 | 🟡 中 | 与 `BrowserPanel` 同目录，易混淆，建议改名 |
| 瞬态浮层漏检评估不足 | 🟡 中 | 右键菜单/下拉菜单存活 < 300ms，IntersectionObserver 来不及触发 |
| Spider-Man 半透明叠加冲突 | 🟢 低 | 正交，但需验证 WebView 隐藏后背景无异常 |

---

## 2. 项目现有架构约束

### 2.1 App.tsx 状态管理现状

`App.tsx` 中现有的 overlay 相关状态分布：

```
App.tsx (useState)
├── showSettings          ← useWindowManager({ onOpenSettings })
├── showCreateWorkspace   ← 独立 setState
├── showCreateSession     ← useWindowManager({ onOpenCreateSessionModal })
├── showFileSearch        ← useWindowManager({ onToggleFileSearch })

viewStore (zustand persist)
├── showSessionHistory
├── showNotificationCenter
├── leftPanelType
├── terminalFullscreen
├── showSidebar
├── showDeveloperPanel
├── showGitPanel
└── ...
```

**关键发现**：`showSettings`/`showCreateSession`/`showFileSearch` 三个状态由 `useWindowManager` hook 间接管理，该 hook 在 `App.tsx` 中初始化，持有 `setShowSettings`/`setShowCreateSession`/`setShowFileSearch` 的引用。迁移到 overlayStore 时，需要：

1. 在 overlayStore 中暴露 `setSettingsOpen`/`setCreateSessionOpen`/`setFileSearchOpen` 方法
2. 修改 `useWindowManager` 的调用点，将回调改为调用 overlayStore 的方法
3. 移除 App.tsx 中对应的 4 个 `useState`

**风险**：`useWindowManager` 还持有 `onOpenCreateSessionModal` 等回调，这些回调被 `useWindowManager` 内部的事件监听器调用。如果 overlayStore 的 setter 不是引用稳定的，可能导致事件监听器持有过期引用。

**建议**：`overlayStore` 的 setter 使用 zustand 的 `set` 函数（引用稳定），在 `useWindowManager` 中直接调用 `useOverlayStore.getState().setSettingsOpen(true)` 而非传递回调。

### 2.2 Spider-Man 主题系统约束

当前 Spider-Man 主题的 CSS 规则（`src/App.css`）：

```css
/* 模态框保护：所有 fixed 定位的内容面板保持完全不透明 */
[data-theme="spiderman"] .fixed [class*="-surface"] {
  background-color: rgb(var(--c-bg-surface)) !important;
}
[data-theme="spiderman"] .fixed [class*="bg-background-elevated"] {
  background-color: rgb(var(--c-bg-elevated)) !important;
}
```

但**当前 CSS 规则不覆盖所有面板**——`LeftPanel` 和 `RightPanel` 缺少 `data-spiderman-panel` 属性（`docs/spiderman-mask-audit.md` 已记录）。这意味着：

- 如果 overlayStore 隐藏 WebView 后，LeftPanel/RightPanel 的背景透明度不受 Spider-Man 控制
- 需要先补上 `data-spiderman-panel` 属性，再实施 overlayStore

**建议**：将 LeftPanel/RightPanel 补 `data-spiderman-panel` 作为 P0 前置条件。

### 2.3 相关文档参考

| 文档 | 关键内容 | 与本方案关系 |
|------|---------|-------------|
| `docs/browser-upgrade-overall-plan.md` | 浏览器 Phase 0-3 升级计划，含 ADR 0004 架构硬化 | 本方案应作为 Phase 1（UI 体验重构）的子任务 |
| `docs/browser-ui-refactor-plan.md` | BrowserPanel UI 重构，含工具栏、地址栏改造 | 与本方案正交，但需要注意 WebView 隐藏/显示时 UI 状态同步 |
| `docs/spiderman-mask-audit.md` | LeftPanel/RightPanel 缺少 `data-spiderman-panel` | 前置条件 |
| `docs/spiderman-opacity-groups-analysis.md` | L0-L3 透明度层级定义，含保护区域 | 模态框保护 CSS 规则需与 overlayStore 协作 |
| `docs/spiderman-opacity-layers-prd.md` | 透明度层级交互 PRD，含滑块设计 | 未来 Spider-Man 设置面板可能需要新增"浏览器覆盖"相关选项 |
| `docs/tool-execution-streaming-todo.md` | 工具执行流式输出 TODO | 无直接关系，但都是近期高频改动模块，需注意 merge 冲突 |

---

## 3. 方案细节评审

### 3.1 第一层：状态驱动（P0）

**原方案**：创建 `overlayStore`，BrowserPanel 订阅 `count > 0` 时隐藏 WebView。

**评审意见**：

| 维度 | 评价 |
|------|------|
| 架构合理性 | ✅ 正确。状态驱动是确定性最高的方案，零延迟 |
| 改动量估计 | ⚠️ 低估。原估计 2 个文件，实际需修改约 5 个文件（overlayStore 新建 + App.tsx + useWindowManager + BrowserPanel + 各触发点） |
| 引用稳定性 | ⚠️ 需要确保 zustand setter 引用稳定，避免 `useWindowManager` 持有过期回调 |
| 去抖需求 | ✅ 需要，建议 100ms 去抖，避免快速切换面板时高频 bounds 调用 |

**修正后的实施路径**：

1. 修正 `OFFSCREEN_BROWSER_BOUNDS` 为 `{x:0, y:0, width:0, height:0}`（独立，不与 overlayStore 耦合）
2. 在 `reuse_browser_webview` 中先 `hide()` 再 `show()` 强制重绘
3. 创建 `src/stores/overlayStore.ts`（zustand，非 persist）
4. 修改 `useWindowManager` 回调指向 overlayStore
5. 移除 App.tsx 中 4 个 `useState`
6. BrowserPanel 订阅 overlayStore
7. 补上 LeftPanel/RightPanel 的 `data-spiderman-panel`

### 3.2 第二层：声明式守卫（P1）

**原方案**：`<BrowserOverlayGuard>` 组件包裹关键模态/面板，自动 ±1 count。

**评审意见**：

| 维度 | 评价 |
|------|------|
| 命名 | ⚠️ 建议改为 `<OverlayGuard>` 或 `<WebViewOverlayGuard>`，避免与 `BrowserPanel` 混淆 |
| 实现方式 | ✅ 简单可靠，`useEffect` + `count++`/`count--` |
| 嵌套处理 | ⚠️ 原方案 `count++` 而非 `count=1`，正确。但需注意 `CreateSessionModal` 内打开 `CreateWorkspaceModal` 的嵌套场景 |
| 覆盖范围 | ⚠️ 约 10 个组件，但需注意若干组件使用 `createPortal` 渲染到 body，挂载点可能不在正常 React 树中 |

**需要包裹的组件清单（P1 优先级）**：

| 组件 | 文件 | 定位方式 | 特殊说明 |
|------|------|---------|---------|
| CreateSessionModal | `src/components/Session/CreateSessionModal.tsx` | Portal to body | 内部可开 CreateWorkspaceModal |
| CreateWorkspaceModal | `src/components/Workspace/CreateWorkspaceModal.tsx` | Portal to body | 嵌套在 CreateSessionModal 内 |
| FileSearchModal | `src/components/FileSearch/FileSearchModal.tsx` | fixed inset-0 | 全局搜索 |
| SessionHistoryPanel | `src/components/Chat/SessionHistoryPanel.tsx` | fixed z-50 | 右侧滑出 |
| NotificationCenterPanel | `src/components/Notification/NotificationCenterPanel.tsx` | fixed z-50 | 右侧滑出 |
| ForkSessionDialog | `src/components/Chat/ForkSessionDialog.tsx` | fixed | 分叉会话 |
| CompactHandoffModal | `src/components/Chat/CompactHandoffModal.tsx` | fixed | 交接 |
| ConfirmDialog | `src/components/Common/ConfirmDialog.tsx` | fixed | 通用确认框 |
| InputDialog | `src/components/Common/InputDialog.tsx` | fixed | 通用输入框 |
| AiExtractDialog | `src/components/Chat/AiExtractDialog.tsx` | fixed | AI 提取 |
| RequirementDetailDialog | `src/components/Requirement/RequirementDetailDialog.tsx` | fixed | 需求详情 |
| RequirementGenerateDialog | `src/components/Requirement/RequirementGenerateDialog.tsx` | fixed | 需求生成 |
| TodoDetailDialog | `src/components/Todo/TodoDetailDialog.tsx` | fixed | 待办详情 |
| TerminalRunCommandModal | `src/components/Terminal/TerminalRunCommandModal.tsx` | fixed | 终端命令 |
| BranchDialogs/PushDialog | `src/components/GitPanel/*.tsx` | fixed | Git 操作 |

### 3.3 第三层：增强检测（P2）

**原方案**：扩大 `OCCLUDING_ELEMENT_SELECTOR` + 降低阈值 + IntersectionObserver。

**评审意见**：

| 维度 | 评价 |
|------|------|
| 选择器扩展 | ✅ 正确，但需注意 `[class*="z-["]` 在 Tailwind v4 中的兼容性 |
| 阈值降低 | ✅ 40 → 10，合理。但需确认项目中没有 z-index 在 10-40 之间的非遮挡元素 |
| IntersectionObserver | ⚠️ 不能替代 MutationObserver，两者应共存。MutationObserver 负责检测 DOM 变化，IntersectionObserver 负责检测元素进入浏览器区域 |
| 瞬态浮层 | ⚠️ 右键菜单/下拉菜单存活极短，IntersectionObserver 可能来不及触发。建议对 `<menu>`/`<ContextMenu>` 等组件加 `data-native-webview-overlay` 属性 |

**风险评估**：`OCCLUDING_ELEMENT_SELECTOR` 中的 `.fixed` 选择器可能误伤 `BrowserPanel` 自身的 `.fixed` 子元素（如地址栏下拉提示）。建议在 `isBrowserOccludedByAppOverlay` 中排除浏览器容器内部的元素。

---

## 4. 实施路径（修正版）

### Phase 0 — 修复黑屏（独立，2 文件）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 0.1 | `src/components/Browser/BrowserPanel.tsx` | `OFFSCREEN_BROWSER_BOUNDS` 改为 `{x:0, y:0, width:0, height:0}` |
| 0.2 | `src-tauri/src/commands/browser.rs` | `reuse_browser_webview` 中先 `hide()` 再 `show()` |

### Phase 1 — 状态驱动（5 文件）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1.1 | `src/stores/overlayStore.ts` | **新建**，含 `count`、`increment`、`decrement`、`settingsOpen`/`createSessionOpen`/`fileSearchOpen` 及其 setter |
| 1.2 | `src/components/Layout/LeftPanel.tsx` | 补 `data-spiderman-panel` 属性 |
| 1.3 | `src/components/Layout/RightPanel.tsx` | 补 `data-spiderman-panel` 属性 |
| 1.4 | `src/App.tsx` | 移除 4 个 `useState`，改为调用 overlayStore |
| 1.5 | `src/hooks/useWindowManager.ts` | 回调改为 `useOverlayStore.getState().setXxx()` |
| 1.6 | `src/components/Browser/BrowserPanel.tsx` | 订阅 `overlayStore.count`，`count > 0` 时隐藏 |

### Phase 2 — 声明式守卫（~12 文件）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 2.1 | `src/components/Browser/OverlayGuard.tsx` | **新建**，`useEffect(() => { increment(); return decrement }, [])` |
| 2.2 | 15 个模态/面板组件 | 外层包裹 `<OverlayGuard>`，注意 `createPortal` 场景 |

### Phase 3 — 增强检测（1 文件）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 3.1 | `src/components/Browser/BrowserPanel.tsx` | 扩展 `OCCLUDING_ELEMENT_SELECTOR`，降阈值，加 IntersectionObserver |

---

## 5. 风险登记表

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| `useWindowManager` 持有过期回调 | 中 | 高 | 使用 `getState()` 直接调用，不依赖闭包 |
| 嵌套模态计数错误 | 中 | 中 | 确认 `count++` 而非 `count=1`，单元测试覆盖 |
| 瞬态浮层漏检 | 高 | 低 | 接受 P2 兜底，对高频组件手动加 `data-native-webview-overlay` |
| Spider-Man 透明背景异常 | 低 | 中 | 验证 WebView 隐藏后 LeftPanel/RightPanel 背景正常 |
| 高频 bounds 调用 | 低 | 低 | 100ms 去抖（已在 `scheduleSyncBounds` 中实现） |
| macOS 行为差异 | 中 | 中 | 优先在 Windows 验证，macOS 后续补充 |
| 与 tool-execution-streaming 并行开发冲突 | 中 | 中 | 两模块修改文件不重叠，但需注意合并顺序 |

---

## 6. 验收标准

| 场景 | 预期行为 | 验证方式 |
|------|---------|---------|
| 打开设置面板 | 浏览器 WebView 隐藏，设置面板正常显示 | 日志 `[BrowserPanel] syncBounds: HIDE` |
| 关闭设置面板 | 浏览器 WebView 恢复，正常显示 | 日志 `[BrowserPanel] syncBounds: applying bounds` |
| 打开 CreateSessionModal | WebView 隐藏 | 日志 `[BrowserPanel] overlay count changed: 1` |
| 在 CreateSessionModal 中打开 CreateWorkspaceModal | WebView 保持隐藏，count=2 | 日志 `count: 2` |
| 关闭嵌套模态 | WebView 保持隐藏，count=1 | 日志 `count: 1` |
| 打开 SessionHistoryPanel | WebView 隐藏 | 日志 |
| 打开右键菜单 | WebView 隐藏（或通过增强检测兜底） | 日志 |
| 切换 AI 会话（多会话网格） | 浏览器不黑屏 | 无 `[BrowserPanel] UNMOUNT` 日志 |
| 切换浏览器 Tab 再切回 | 浏览器正常显示 | 日志 `[Browser] reuse_browser_webview` |
| 打开 LeftPanel 抽屉（小屏模式） | WebView 不覆盖抽屉 | 日志 |
| 快速连续打开/关闭多个面板 | 无频繁 bounds 调用，无闪烁 | 100ms 间隔内只触发一次 |