# 工作区选择器下拉框 UX 优化设计文档

## 1. 问题分析

### 1.1 当前痛点

| 问题 | 描述 | 影响 |
|------|------|------|
| 下拉框高度无限制 | 工作区列表过多时会超出面板边界 | 用户无法看到完整列表，操作困难 |
| 新增按钮位置不佳 | 新增工作区按钮在最底部，需要滚动才能看到 | 新增操作效率低，用户体验差 |
| 工作区管理按钮无用 | "工作区管理"按钮功能未实现，点击无反应 | 功能冗余，造成困惑 |
| 关联工作区选择繁琐 | 需要滚动很长列表才能找到关联选项 | 关联管理操作效率低 |
| 点击外部不关闭 | 点击下拉框外部不会自动关闭，需要再次点击 | 操作繁琐，交互体验差 |
| 弹窗居中问题 | CreateWorkspaceModal 未正确居中显示 | 视觉效果不佳 |

### 1.2 现有组件分析

**WorkspaceMenu.tsx** (会话工作区选择器)
- 位置：Session 左侧面板
- 功能：主工作区选择 + 关联工作区管理
- 问题：高度 `max-h-[400px]` 但实际超出面板、操作按钮在底部

**FileExplorer.tsx** (文件浏览器工作区切换)
- 位置：文件浏览器顶部
- 功能：切换正在查看的工作区
- 问题：下拉菜单无高度限制、无搜索功能

**CreateWorkspaceModal.tsx** (新增工作区弹窗)
- 问题：`fixed inset-0 flex items-center justify-center` 应该居中但实际可能被父容器影响

---

## 2. 设计方案

### 2.1 方案概述

采用 **搜索+快速操作模式**，将下拉框重构为以下结构：

```
┌─────────────────────────────────────┐
│  [🔍 搜索框...................] [+] │  ← 搜索 + 快速新增
├─────────────────────────────────────┤
│  ○ 主工作区 (当前)                   │
│  ○ 工作区 A                          │  ← 可滚动列表
│  ○ 工作区 B                          │    (支持搜索筛选)
│  ...                                 │
├─────────────────────────────────────┤
│  [🔗 关联工作区管理]                 │  ← 独立入口按钮
└─────────────────────────────────────┘
```

### 2.2 核心改动

#### 2.2.1 下拉框结构重构

**WorkspaceDropdown 新组件**

```
顶部区域 (固定):
  - 搜索输入框 (实时筛选)
  - 快速新增按钮 (右侧图标按钮)

中间区域 (可滚动):
  - 工作区列表
  - 最大高度: 240px (约 6 个项目)
  - 滚动条: 自定义样式，仅在溢出时显示

底部区域 (固定):
  - 关联工作区管理按钮 (打开独立弹窗)
```

#### 2.2.2 点击外部自动关闭

使用 `useEffect` 监听 `mousedown` 事件，点击下拉框外部时自动关闭：

```typescript
useEffect(() => {
  const handleClickOutside = (event: MouseEvent) => {
    if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
      onClose()
    }
  }
  if (isOpen) {
    document.addEventListener('mousedown', handleClickOutside)
  }
  return () => {
    document.removeEventListener('mousedown', handleClickOutside)
  }
}, [isOpen, onClose])
```

#### 2.2.3 关联工作区管理弹窗

独立弹窗组件 `ContextWorkspaceModal`，从底部按钮触发：

```
┌─────────────────────────────────────────────┐
│  关联工作区管理                         [×] │
├─────────────────────────────────────────────┤
│  当前关联:                                   │
│  ├─ ✓ 工作区 A                        [移除]│
│  ├─ ✓ 工作区 B                        [移除]│
│                                             │
│  可添加:                                     │
│  ├─ ○ 工作区 C                        [添加]│
│  ├─ ○ 工作区 D                        [添加]│
└─────────────────────────────────────────────┘
```

#### 2.2.4 新增工作区弹窗居中修复

确保弹窗容器使用正确的定位：

```css
.modal-overlay {
  position: fixed;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
  background-color: rgba(0, 0, 0, 0.5);
}

.modal-content {
  position: relative;  /* 确保 relative 定位 */
  max-width: 28rem;
  width: 100%;
}
```

---

## 3. 组件设计

### 3.1 WorkspaceDropdown 组件

**Props:**
```typescript
interface WorkspaceDropdownProps {
  isOpen: boolean
  onClose: () => void
  sessionId?: string  // 会话 ID，用于会话级工作区选择
  mode: 'session' | 'fileExplorer'  // 使用场景
  onSelect?: (workspaceId: string) => void  // 选择回调
}
```

**状态:**
```typescript
const [searchQuery, setSearchQuery] = useState('')
const [showCreateModal, setShowCreateModal] = useState(false)
const [showContextModal, setShowContextModal] = useState(false)
```

**布局:**
```
宽度: 280px
最大高度: 320px (搜索区 40px + 列表区 240px + 底部区 40px)
圆角: 12px (rounded-xl)
阴影: shadow-lg
背景: bg-background-elevated
边框: border border-border
```

### 3.2 ContextWorkspaceModal 组件

**Props:**
```typescript
interface ContextWorkspaceModalProps {
  sessionId: string
  onClose: () => void
}
```

**布局:**
```
宽度: 400px
最大高度: 480px
居中显示
```

### 3.3 CreateWorkspaceModal 改进

**改动:**
- 确保使用 `fixed` 定位而非继承父容器定位
- 添加 `inset-0` 确保覆盖整个屏幕
- 使用独立的 z-index 层级

---

## 4. 交互流程

### 4.1 选择工作区流程

```
用户点击工作区选择器
    ↓
下拉框展开 (自动聚焦搜索框)
    ↓
用户输入搜索词 (实时筛选列表)
    ↓
用户点击目标工作区
    ↓
下拉框关闭，工作区切换完成
```

### 4.2 新增工作区流程

```
用户点击 "+" 按钮
    ↓
下拉框保持打开，新增弹窗居中显示
    ↓
用户填写名称和路径
    ↓
用户确认创建
    ↓
弹窗关闭，新工作区出现在列表中
```

### 4.3 关联工作区管理流程

```
用户点击 "关联工作区管理" 按钮
    ↓
下拉框关闭，关联管理弹窗打开
    ↓
用户添加/移除关联工作区
    ↓
用户关闭弹窗
```

---

## 5. 视觉规范

### 5.1 搜索框

```
高度: 36px
背景: bg-background-surface
边框: border border-border
圆角: 8px
图标: 搜索图标 (左侧)
placeholder: "搜索工作区..."
```

### 5.2 工作区列表项

```
高度: 40px
选中状态: bg-primary/10 border border-primary/20
悬停状态: bg-background-hover
当前标记: 左侧圆点 + 右侧勾选图标
文本: 名称 (主) + 路径 (次，可选显示)
```

### 5.3 滚动条

```css
/* 自定义滚动条样式 */
.scrollbar-thin::-webkit-scrollbar {
  width: 6px;
}
.scrollbar-thin::-webkit-scrollbar-track {
  background: transparent;
}
.scrollbar-thin::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 3px;
}
.scrollbar-thin::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.25);
}
```

---

## 6. 技术实现要点

### 6.1 搜索筛选逻辑

```typescript
const filteredWorkspaces = workspaces.filter(w =>
  w.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
  w.path.toLowerCase().includes(searchQuery.toLowerCase())
)
```

### 6.2 高度限制

```typescript
// 列表区域最大高度 = 总高度 - 搜索区 - 底部区
const LIST_MAX_HEIGHT = 240 // pixels, 约 6 个项目
```

### 6.3 键盘支持

- `Escape`: 关闭下拉框
- `Enter`: 选择当前高亮项目
- `Up/Down`: 在列表中导航

---

## 7. 实施计划

### Phase 1: 基础组件重构
- 创建 `WorkspaceDropdown` 组件
- 实现搜索筛选功能
- 实现高度限制与滚动条

### Phase 2: 交互优化
- 实现点击外部关闭
- 实现键盘导航支持
- 修复弹窗居中问题

### Phase 3: 关联管理
- 创建 `ContextWorkspaceModal` 组件
- 实现添加/移除关联工作区
- 集成到 WorkspaceDropdown

### Phase 4: 替换与清理
- 替换 WorkspaceMenu 使用新组件
- 替换 FileExplorer 工作区选择器
- 清理旧代码

---

## 8. 验收标准

| 功能 | 验收标准 |
|------|---------|
| 搜索筛选 | 输入搜索词后列表实时更新，无匹配时显示空状态 |
| 高度限制 | 工作区超过 6 个时列表可滚动，不超出面板边界 |
| 点击外部关闭 | 点击下拉框外部任意位置自动关闭 |
| 新增按钮 | 搜索框右侧 "+" 按钮始终可见，点击打开弹窗 |
| 弹窗居中 | 新增弹窗在屏幕正中央显示 |
| 关联管理 | 底部按钮打开独立弹窗，可添加/移除关联 |
| 键盘支持 | Escape 关闭，上下箭头导航 |

---

## 9. 附录

### 9.1 国际化文本

```json
{
  "workspace": {
    "dropdown": {
      "searchPlaceholder": "搜索工作区...",
      "noResults": "未找到匹配的工作区",
      "quickAdd": "新增工作区",
      "contextManagement": "关联工作区管理"
    },
    "contextModal": {
      "title": "关联工作区管理",
      "currentContext": "当前关联",
      "available": "可添加",
      "add": "添加",
      "remove": "移除",
      "noneAvailable": "暂无其他工作区可关联"
    }
  }
}
```