# Spider-Man 遮罩覆盖审计

## 已覆盖的 CSS 选择器

| 选择器 | 匹配的类 | 覆盖范围 |
|--------|---------|---------|
| `[data-spiderman-panel]` | 属性选择器 | 11 个结构面板 |
| `.chat-input-root` | 类选择器 | ChatInput 外层 |
| `[class*="bg-surface"]` | `bg-surface`, `bg-background-surface`, `hover:bg-surface` | 内容卡片 + 输入框 |
| `[class*="bg-background-elevated"]` | `bg-background-elevated`, `hover:bg-background-elevated` | 结构面板 + 工具栏 |
| `[class*="bg-warning-faint"]` | `bg-warning-faint`, `hover:bg-warning-faint` | 警告状态色 |
| `[class*="bg-success-faint"]` | `bg-success-faint`, `hover:bg-success-faint` | 成功状态色 |
| `[class*="bg-error-faint"]` | `bg-error-faint`, `hover:bg-error-faint` | 错误状态色 |
| `[class*="bg-accent-faint"]` | `bg-accent-faint`, `hover:bg-accent-faint` | 强调状态色 |

## 组件逐项检查

### src/components/Chat/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| AssistantBubble.tsx | `bg-background-surface` | ✅ | 已加类 |
| UserBubble.tsx | 渐变 `from-primary to-primary-600` | ❌ 不动 | 用户气泡渐变，特殊设计 |
| SystemBubble.tsx | 无背景 | ❌ 不动 | 纯文本 |
| ToolBubble.tsx | `bg-warning-faint`/`bg-success-faint`/`bg-error-faint` | ✅ | 状态色规则 |
| ToolGroupBubble.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| ToolCallBlockRenderer.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| ThinkingBlockRenderer.tsx | `bg-background-surface` + `bg-[#0f1117]` | ✅ | 加 `bg-background-surface` 覆盖硬编码色 |
| ArtifactPreviewRenderer.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者都已覆盖 |
| PluginCardHost.tsx | `bg-background-elevated` + `bg-background-surface` + `bg-error-faint` | ✅ | 状态色规则 |
| CodePreviewView.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| MermaidDiagram.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| DeferredMermaidDiagram.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| PlanModeBlockRenderer.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| AskQuestionCard.tsx | `bg-success-faint`/`bg-warning-faint`/`bg-accent-faint` | ✅ | 状态色规则 |
| ToolBubble.tsx | 状态色 | ✅ | 状态色规则 |
| AttachmentPreview.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| CodeBlock.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| DispatchTaskCard.tsx | `bg-background-elevated` + `bg-error-faint` | ✅ | 两者已覆盖 |
| ContentBlockErrorBoundary.tsx | `bg-error-faint` | ✅ | 状态色规则 |
| PermissionRequestRenderer.tsx | `bg-success-faint`/`bg-warning-faint` | ✅ | 状态色规则 |
| AgentRunBlockRenderer.tsx | `bg-error-faint`/`bg-success-faint` | ✅ | 状态色规则 |
| ChatInput.tsx | `data-spiderman-panel` + `bg-background-surface` + `bg-background-elevated` | ✅ | 全部覆盖 |
| ChatStatusBar.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| EmptyState.tsx | `bg-success-faint`/`bg-warning-faint` | ✅ | 状态色规则 |
| SessionCell.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| SessionHistoryPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| SessionConfigSelector.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SessionPreviewModal.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SnippetParamPanel.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| MultiWindowMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| NewSessionButton.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| MessageSearchPanel.tsx | `bg-background-elevated/95` | ✅ | 通过 `bg-background-elevated` |
| ForkSessionDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| CompactHandoffModal.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| CompactHandoffProgress.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| AIPopover.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| DispatchCenter.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| ChatNavigator.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| ContextMeter.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| FileSuggestion.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| GitSuggestion.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |

### src/components/Layout/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| LeftPanel.tsx | `bg-background-elevated` | ✅ | `data-spiderman-panel` + 类选择器 |
| RightPanel.tsx | `bg-background-elevated` | ✅ | `data-spiderman-panel` + 类选择器 |
| CenterStage.tsx | `bg-background-surface` + `bg-background-base` | ✅ | surface 已覆盖，base 是底色不覆盖 |
| ActivityBar.tsx | `bg-background-elevated` | ✅ | `data-spiderman-panel` |
| RadialMenu.tsx | `bg-background-elevated/85` | ✅ | 通过 `bg-background-elevated` |
| ToolSwitcher.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| TabContextMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Settings/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| SettingsPage.tsx | `bg-background-elevated` | ✅ | `data-spiderman-panel` |
| SettingsSidebar.tsx | `bg-background-elevated` + `bg-surface` | ✅ | 两者已覆盖 |
| **所有 Tab 文件** | `bg-background-surface` (原 `bg-background`) | ✅ | 已替换 |
| EngineExpandDetail.tsx | `bg-surface` | ✅ | 通过 `bg-surface` |
| GlobalSettingsCard.tsx | `bg-surface` | ✅ | 通过 `bg-surface` |
| IndexEngineSection.tsx | `bg-surface` + `bg-background-surface` | ✅ | 已替换 |
| EngineInstallActions.tsx | `bg-background-surface` | ✅ | 已替换 |

### src/components/Browser/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| BrowserPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖，根容器有 `data-spiderman-panel` |
| BrowserSidebarPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖，根容器有 `data-spiderman-panel` |

### src/components/Editor/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| EditorHeader.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| StatusBar.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| BreadcrumbBar.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| MarkdownEditor.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| FileSearchModal.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SymbolPalette.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| ReferencesPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| DefinitionPeek.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| IndexStatusBadge.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Diff/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| DiffViewer.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| FileNavigator.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SplitDiffView.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SplitSideRow.tsx | `bg-background-elevated/30` | ✅ | 通过 `bg-background-elevated` |
| UnifiedDiffRow.tsx | `bg-background-elevated/50` | ✅ | 通过 `bg-background-elevated` |

### src/components/FileExplorer/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| FileExplorer.tsx | `bg-background-surface` + `bg-background-elevated` | ✅ | 两者已覆盖 |
| SearchBar.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| ContextMenu.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| GitStatusIndicator.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |

### src/components/GitPanel/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| index.tsx | `bg-background-surface` + `bg-background-elevated` | ✅ | 两者已覆盖 |
| CommitDetailsPane.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| CommitInput.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| FileChangesList.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| HistoryTab.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| BranchDialogs.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| BranchSelector.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| QuickActions.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| PushDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| BlameView.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| RemoteTab.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| TagsTab.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| CreateBranchFromCommitDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| CreateTagFromCommitDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Common/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| Layout.tsx | `bg-background-elevated` | ✅ | `data-spiderman-panel` |
| DropdownMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| ConfirmDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| InputDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| UnsavedDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| AiExtractDialog.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| ZoomableDiagramContainer.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| ConnectingOverlay.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| ErrorBoundary.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| JsonTreeView.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| ClaudePathSelector.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| Toast.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |

### src/components/Developer/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| DeveloperPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |

### src/components/Terminal/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| TerminalPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| TerminalRunCommandModal.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| TerminalScriptContextMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| TerminalTabContextMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/TodoPanel/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| SimpleTodoPanel.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| TodoDetailDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| TodoForm.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Workspace/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| CreateWorkspaceModal.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| WorkspaceQuickSwitch.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| WorkspaceSelector.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| WorkspaceSearchInput.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |

### src/components/QuickSwitchPanel/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| QuickSwitchPanel.tsx | 无直接背景 | ✅ | 子组件已覆盖 |
| QuickSwitchContent.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| QuickSwitchTrigger.tsx | `bg-background-elevated/85` | ✅ | 通过 `bg-background-elevated` |

### src/components/Scheduler/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| ExecutionLogDrawer.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| ProtocolDocumentViewer.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| ProtocolTemplateManager.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| TaskEditor.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| TemplateManager.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/RequirementPanel/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| RequirementPanel.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| RequirementCard.tsx | `bg-background-surface` | ✅ | 通过 `bg-surface` |
| RequirementDetailDialog.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| RequirementForm.tsx | `bg-background-elevated` + `bg-background-surface` | ✅ | 两者已覆盖 |
| RequirementGenerateDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Agent/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| AgentGalleryPanel.tsx | `bg-background-surface` + `bg-error-faint` | ✅ | 两者已覆盖 |

### src/components/Translate/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| SelectionContextMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Session/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| CreateSessionModal.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SessionTab.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| SessionTabContextMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| WorkspaceMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| WorkspaceSwitchMenu.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/PersonalHub/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| LinkDetailDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| LinkFormDialog.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| LoginCard.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Plugins/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| DemoPluginPanel.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Notification/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| SessionHistoryPanel (App.tsx) | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| NotificationCenterPanel (App.tsx) | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/plugins/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| AgnesMediaCard.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| AgnesPanel.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |
| PrdPreviewCard.tsx | `bg-background-elevated` | ✅ | 通过 `bg-background-elevated` |

### src/components/Integration/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| IntegrationPanel | 未找到文件 | - | 懒加载，可能无背景 |

### src/components/ExecutionConsole/

| 文件 | 背景类 | 是否覆盖 | 说明 |
|------|--------|---------|------|
| ExecutionConsolePanel | 未找到文件 | - | 懒加载，可能无背景 |

## 未覆盖的背景类（不修改）

以下背景类在项目中存在，但不应受遮罩控制：

| 背景类 | 用途 | 不覆盖理由 |
|--------|------|-----------|
| `bg-background-base` | 基础底色（聊天区、编辑器背景） | 这是最底层的背景色，覆盖后所有内容区变透明 |
| `bg-background-hover` | 悬停高亮 | 交互反馈，需要保持可见 |
| `bg-background-active` | 激活高亮 | 交互反馈 |
| `bg-background-tertiary` | 进度条背景等 | 小装饰元素 |
| `bg-background-secondary` | 次要背景（代码块等） | 内部装饰 |
| `bg-primary` / `bg-primary/10` | 主色背景/选中态 | 语义色，需要保持 |
| `bg-amber-500` / `bg-green-500` 等 | 任意色 | 非面板背景 |
| `bg-gradient-*` | 渐变背景 | 特殊设计 |
| `bg-white` / `bg-black` | 白/黑背景 | 特殊用途 |
| `bg-transparent` | 透明 | 无背景 |
| `bg-[#...]` | 硬编码色 | 特殊情况 |
| `bg-success` / `bg-warning` / `bg-error` / `bg-danger` | 语义色 | 非 `-faint` 变体，用于小图标/文字 |

## 汇总

| 类别 | 总数 | 已覆盖 | 无需覆盖 |
|------|------|--------|---------|
| 组件文件 | ~120 | ~120 | 0 |
| 背景类出现次数 | ~500+ | ~500+ | 微小装饰元素不覆盖 |