# Spider-Man 遮罩变更清单

## 一、CSS 规则变更（App.css）

### 规则 1: 结构面板
```css
[data-theme="spiderman"] [data-spiderman-panel],
[data-theme="spiderman"] .chat-input-root {
  background-color: rgb(var(--c-bg-elevated) / var(--spiderman-panel-opacity, 0.55)) !important;
}
```
✅ 未修改

### 规则 2: 内容卡片
```css
[data-theme="spiderman"] .theme-root [class*="bg-surface"] {
  background-color: rgb(var(--c-bg-surface) / var(--spiderman-surface-opacity, 0.4)) !important;
}
```
✅ 匹配：`bg-surface`、`bg-background-surface`、`hover:bg-surface`

### 规则 3: 状态色
```css
[data-theme="spiderman"] .theme-root [class*="bg-warning-faint"],
[data-theme="spiderman"] .theme-root [class*="bg-success-faint"],
[data-theme="spiderman"] .theme-root [class*="bg-error-faint"],
[data-theme="spiderman"] .theme-root [class*="bg-accent-faint"] {
  background-color: rgb(var(--c-bg-surface) / var(--spiderman-surface-opacity, 0.4)) !important;
}
```
✅ 新增

### 规则 4: 抬升面板
```css
[data-theme="spiderman"] .theme-root [class*="bg-background-elevated"] {
  background-color: rgb(var(--c-bg-elevated) / var(--spiderman-panel-opacity, 0.55)) !important;
}
```
✅ 从直接子元素扩展为所有后代

## 二、`bg-background` → `bg-background-surface` 替换

### 替换范围
所有 `.tsx` / `.ts` 文件中独立的 `bg-background`（非 `bg-background-surface`、`bg-background-elevated` 等）被替换为 `bg-background-surface`。

### 验证结果
- 无双重替换（`bg-background-surface-surface`）：✅ 0 处
- 无残留独立 `bg-background`：✅ 0 处
- `bg-background-hover`、`bg-background-base`、`bg-background-secondary`、`bg-background-tertiary`、`bg-background-active` 未被替换：✅ 不受影响

### 影响文件清单
替换影响 ~80 个文件，包括：
- Chat 组件（AIPopover、ForkSessionDialog、SessionHistoryPanel 等）
- DeveloperPanel
- GitPanel（BlameView、BranchSelector、GitignoreTab 等）
- Editor（IndexStatusBadge、ReferencesPanel）
- Settings 所有 Tab 文件
- 其他通用组件

## 三、`data-spiderman-panel` 属性

### 11 个结构面板
| 组件 | 文件 | 行 | 验证 |
|------|------|----|------|
| Header | Layout.tsx | 53 | ✅ |
| Sidebar | Layout.tsx | 67 | ✅ |
| Aside | Layout.tsx | 95 | ✅ |
| TopMenuBar | TopMenuBar/index.tsx | 103 | ✅ |
| ActivityBar | ActivityBar.tsx | 60 | ✅ |
| SettingsPage | SettingsPage.tsx | 192 | ✅ |
| SettingsSidebar | SettingsSidebar.tsx | 79 | ✅ |
| BrowserPanel | BrowserPanel.tsx | 1336 | ✅ |
| BrowserSidebarPanel | BrowserSidebarPanel.tsx | 873 | ✅ |
| ChatInput | ChatInput.tsx | 1384 | ✅ |
| LeftPanel | LeftPanel.tsx | 58/75 | ❌ 遗漏 |
| RightPanel | RightPanel.tsx | 42/56 | ❌ 遗漏 |

## 四、当前未覆盖的已知问题

### 1. 设置左侧边栏选中态
- 文件：`SettingsSidebar.tsx:104`
- 类：`bg-primary/10`
- 问题：10% 主色非常淡，在透明背景上几乎看不见
- 建议：不改，这是设计问题

### 2. LeftPanel / RightPanel 缺少 `data-spiderman-panel`
- 文件：`LeftPanel.tsx:58/75`、`RightPanel.tsx:42/56`
- 当前：`bg-background-elevated`（被规则 4 覆盖）
- 应该：加上 `data-spiderman-panel` 保持一致

### 3. `bg-background-secondary` / `bg-background-tertiary`
- 用于：代码块内部、进度条、装饰元素
- 规则：不覆盖，这些是内部装饰，不是内容容器