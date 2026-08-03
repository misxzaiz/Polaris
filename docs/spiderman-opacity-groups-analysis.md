# Spider-Man 主题透明度分组分析

> 分析日期：2026-08-03
> 状态：分析阶段，待实施

## 问题背景

Spider-Man 沉浸主题通过 `--spiderman-*-opacity` CSS 变量控制各区域的半透明程度，让背景壁纸透出。当前存在两个问题：

1. 所有区域共享同一透明度变量，无法按模块独立调节
2. 面板半透明（0.55）与内部卡片半透明（0.5）叠加后，文字可读性下降

## 设计原则

- **同级共享**：同一层级的元素共享同一透明度变量
- **上下级分开**：父容器与子元素使用不同透明度变量
- **按层级深度分组**，而非按功能模块分组

## 层级分组方案

| 层级 | 含义 | CSS 变量 | 默认值 | 覆盖范围 |
|------|------|---------|--------|---------|
| **L0 - 面板** | 最外层布局容器 | `--spiderman-panel-opacity` | 0.55 | 侧栏、设置页容器、活动栏、聊天输入框等 |
| **L1 - 内容** | 面板内第一层内容 | `--spiderman-surface-opacity` | 0.50 | 设置卡片、聊天气泡、表单输入框、下拉菜单、对话框内容等 |
| **L2 - 子内容** | 内容内的更深层 | `--spiderman-chat-tool-opacity` | 0.55 | 气泡内的工具面板、代码块、输入输出详情、Artifact 预览等 |
| **L3 - 悬停** | 静态背景装饰 | `--spiderman-hover-opacity` | 0.50 | 设置页变量说明区、列表头等静态背景区域 |

### 层级关系示例

```
面板 (L0, panel-opacity: 0.55)
├── 设置侧边栏 (data-spiderman-panel)
├── 设置内容区 (data-spiderman-panel)
│   └── 卡片 (L1, surface-opacity: 0.50)
│       └── 输入框 (L1, bg-background-surface)
└── 聊天输入框 (data-spiderman-panel)
    └── 输入框容器 (L1, bg-background-surface)
        └── 优化建议浮层 (L1, bg-background-elevated, 但 fixed 保护)

聊天消息区域 (chat-display-root)
├── 聊天气泡 (L1, bg-background-surface)
│   └── 工具调用块 (L2, bg-background-elevated)
│       ├── 工具头部 (L2, bg-background-elevated)
│       ├── 输入参数 (L2, bg-background-secondary)
│       └── 输出结果 (L2, bg-background-tertiary)
├── 代码块 (L2, bg-background-elevated)
├── Artifact 预览 (L2, bg-background-elevated)
└── 派发卡片 (L2, bg-background-elevated)
```

## 各层级覆盖范围详情

### L0 - 面板 (Panel)

| 子模块 | 文件 | CSS 选择器 |
|--------|------|-----------|
| ActivityBar | `Layout/ActivityBar.tsx` | `data-spiderman-panel` |
| LeftPanel | `Layout/LeftPanel.tsx` | `data-spiderman-panel` |
| RightPanel | `Layout/RightPanel.tsx` | `data-spiderman-panel` |
| TopMenuBar | `TopMenuBar/index.tsx` | `data-spiderman-panel` |
| SettingsPage | `Settings/SettingsPage.tsx` | `data-spiderman-panel` |
| SettingsSidebar | `Settings/SettingsSidebar.tsx` | `data-spiderman-panel` |
| ChatInput | `Chat/ChatInput.tsx` | `data-spiderman-panel` |
| Browser panels | `Browser/BrowserPanel.tsx` | `data-spiderman-panel` |
| Layout.Header | `Common/Layout.tsx` | `data-spiderman-panel` |
| Layout.Sidebar | `Common/Layout.tsx` | `data-spiderman-panel` |
| Layout.Aside | `Common/Layout.tsx` | `data-spiderman-panel` |

**CSS 规则：**
```css
[data-theme="spiderman"] [data-spiderman-panel],
[data-theme="spiderman"] .chat-input-root {
  background-color: rgb(var(--c-bg-elevated) / var(--spiderman-panel-opacity, 0.55)) !important;
}
```

### L1 - 内容卡片 (Surface)

| 子模块 | 文件 | 数量 |
|--------|------|------|
| 设置页各 Tab 卡片 | `Settings/tabs/*.tsx` | ~80 处 |
| 设置页 section 容器 | `Settings/EngineExpandDetail.tsx` 等 | ~30 处 |
| 聊天气泡 | `Chat/chatBubbles/AssistantBubble.tsx` | 1 处 |
| 输入框容器 | `Chat/ChatInput.tsx` | 2 处 |
| 对话框内容面板 | `Common/ConfirmDialog.tsx` 等 | ~10 处 |
| 选择器面板 | `FileExplorer/BranchSelector.tsx` 等 | ~20 处 |
| 表单输入框 | 各 `bg-background-surface` 输入控件 | ~100 处 |
| 下拉菜单 | `Common/DropdownMenu.tsx` 等 | ~10 处 |
| 消息上下文菜单 | `Chat/chatBubbles/MessageContextMenu.tsx` | 1 处 |
| 聊天历史面板 | `Chat/SessionHistoryPanel.tsx` | ~6 处 |
| 新会话按钮 | `Chat/NewSessionButton.tsx` | 1 处 |
| 各种渲染块 | chatBlocks 系列 | ~15 处 |
| 仪表盘/统计 | `TokenStatsTab.tsx` 等 | ~10 处 |
| 所有面板内部卡片 | 设置 / 排程 / Git / 待办等 | ~50 处 |

**CSS 规则：**
```css
[data-theme="spiderman"] .theme-root [class*="-surface"] {
  background-color: rgb(var(--c-bg-surface) / var(--spiderman-surface-opacity, 0.5)) !important;
}
```

### L2 - 聊天工具面板 (Chat Tool)

| 子模块 | 文件 | 背景类 |
|--------|------|--------|
| 工具调用块 | `Chat/chatBlocks/ToolCallBlockRenderer.tsx` | `bg-background-elevated` |
| 工具详情区 | `Chat/chatBlocks/ToolCallBlockRenderer.tsx` | `bg-background-secondary` / `-tertiary` |
| 单工具气泡 | `Chat/ToolBubble.tsx` | `bg-background-secondary` / `-tertiary` |
| 工具组气泡 | `Chat/ToolGroupBubble.tsx` | `bg-background-surface`（L1） |
| 派发任务卡片 | `Chat/DispatchTaskCard.tsx` | `bg-background-elevated` |
| 代码块头部 | `Chat/CodeBlock.tsx` | `bg-background-elevated` |
| 代码预览 | `Chat/chatBlocks/CodePreviewView.tsx` | `bg-background-secondary` |
| Artifact 预览 | `Chat/chatBlocks/ArtifactPreviewRenderer.tsx` | `bg-background-elevated` |
| 插件卡片 | `Chat/chatBlocks/PluginCardHost.tsx` | `bg-background-elevated` |
| 思考块 | `Chat/chatBlocks/ThinkingBlockRenderer.tsx` | `bg-background-elevated` |
| Mermaid 头部 | `Chat/MermaidDiagram.tsx` | `bg-background-elevated` |
| 权限请求 | `Chat/PermissionRequestRenderer.tsx` | `bg-background-secondary` / `-tertiary` |
| 计划模式块 | `Chat/PlanModeBlockRenderer.tsx` | `bg-background-elevated` |
| 上下文计费 | `Chat/ContextMeter.tsx` | `bg-background-tertiary` |
| 文件建议 | `Chat/FileSuggestion.tsx` | `bg-background-elevated/50` |
| 加载更多按钮 | `Chat/EnhancedChatMessages.tsx` | `bg-background-elevated/70` |

**CSS 规则：**
```css
[data-theme="spiderman"] .chat-display-root [class*="bg-background-elevated"] {
  background-color: rgb(var(--c-bg-elevated) / var(--spiderman-chat-tool-opacity, 0.55)) !important;
}
[data-theme="spiderman"] .chat-display-root [class*="bg-background-secondary"] {
  background-color: rgb(var(--c-bg-secondary) / var(--spiderman-chat-tool-opacity, 0.55)) !important;
}
[data-theme="spiderman"] .chat-display-root [class*="bg-background-tertiary"] {
  background-color: rgb(var(--c-bg-tertiary) / var(--spiderman-chat-tool-opacity, 0.55)) !important;
}
```

### L3 - 悬停/静态背景 (Hover)

| 子模块 | 文件 | 数量 |
|--------|------|------|
| 设置页变量说明区 | `Settings/tabs/PromptSnippetTab.tsx` | 1 处 |
| 设置页 section header | `Settings/tabs/ThemeTab.tsx` 等 | ~10 处 |
| 设置页列表项头 | `Settings/tabs/SpeechTab.tsx` 等 | ~10 处 |
| 个人 Hub 卡片区 | `PersonalHub/LinksView.tsx` 等 | ~10 处 |
| 文件树节点 | `FileExplorer/FileTreeNode.tsx` | 1 处 |
| 集成面板 | `Integration/IntegrationPanel.tsx` | 6 处 |
| 通知中心 | `Notification/NotificationCenterPanel.tsx` | 3 处 |
| Git 面板 | `GitPanel/*.tsx` | ~20 处 |
| 对话历史 | `Chat/SessionHistoryPanel.tsx` | ~12 处 |
| 快速切换 | `QuickSwitchPanel/QuickSwitchContent.tsx` | 9 处 |
| Todo 面板 | `TodoPanel/*.tsx` | ~10 处 |
| 开发者面板 | `Developer/DeveloperPanel.tsx` | 3 处 |
| 排程面板 | `Scheduler/*.tsx` | ~10 处 |
| 附件的预览 | `Chat/AttachmentPreview.tsx` | 1 处 |
| 下拉菜单项 | `Chat/chatBubbles/MessageContextMenu.tsx` | 5 处 |

**注意：** `bg-background-hover` 大部分用于 `hover:` 交互态（鼠标悬停时切换），仅有少数场景用作**静态背景色**。用 `!important` 覆盖会破坏 hover 交互效果，需谨慎处理。

**CSS 规则：**
```css
[data-theme="spiderman"] .theme-root [class*="bg-background-hover"] {
  background-color: rgb(var(--c-bg-hover) / var(--spiderman-hover-opacity, 0.5)) !important;
}
```

## 特殊保护区域

### 模态框/对话框

所有 `fixed` 定位的模态框/对话框内容面板保持完全不透明，不受壁纸半透明影响。

```css
[data-theme="spiderman"] .fixed [class*="-surface"] {
  background-color: rgb(var(--c-bg-surface)) !important;
}
[data-theme="spiderman"] .fixed [class*="bg-background-elevated"] {
  background-color: rgb(var(--c-bg-elevated)) !important;
}
```

涉及约 30 个对话框，涵盖：AIPopover、CompactHandoffModal、ConfirmDialog、CreateSessionModal、BranchDialogs、PushDialog、TagsTab、FileSearchModal、SymbolPalette 等。

## 当前实施状态

已实施的变量（4 个）：

| 变量 | 默认值 | 设置面板滑块 |
|------|--------|-------------|
| `--spiderman-panel-opacity` | 0.55 | ✅ 面板透明度 |
| `--spiderman-surface-opacity` | 0.50 | ✅ 内容卡片透明度 |
| `--spiderman-chat-tool-opacity` | 0.55 | ✅ 工具面板透明度 |
| `--spiderman-hover-opacity` | 0.50 | ✅ 悬停背景透明度 |

## 待讨论问题

1. L3（hover）是否需要独立分组？`bg-background-hover` 多数用于 hover 交互态，仅少数用作静态背景
2. 语义状态色（`bg-warning-faint` / `bg-success-faint` / `bg-error-faint` / `bg-accent-faint`）是否跟随 L1（surface）还是独立？
3. 编辑区域（Editor）和 Diff 视图是否跟随 L0（panel）还是独立？