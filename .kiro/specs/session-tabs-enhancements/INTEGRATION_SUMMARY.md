# 会话标签页与工作区集成方案总结

## 概述

本文档总结了会话标签页与工作区管理的集成方案，采用**二八分布原则**：标签标题占 70%，工作区徽章占 20%，关闭按钮占 10%。

## 核心设计理念

### 1. 会话级工作区绑定

- 每个会话独立维护自己的工作区绑定
- 不是全局工作区切换，而是会话级别的关联
- 支持一个主工作区 + 多个关联工作区

### 2. 二八分布布局

```
┌─────────────────────────────────────────────────────┐
│ [●] 用户认证功能 (70%)  [📁 前端 +2] (20%)  [×] (10%) │
└─────────────────────────────────────────────────────┘
     ↑                      ↑                    ↑
  状态点                 工作区徽章            关闭按钮
```

### 3. 完整功能支持

- ✅ 查看当前会话的工作区
- ✅ 切换会话的主工作区
- ✅ 添加/移除关联工作区
- ✅ 新增工作区（集成 CreateWorkspaceModal）
- ✅ 工作区锁定机制（对话开始后锁定主工作区）

## 组件架构

### 核心组件

```
SessionTab (标签组件)
├── StatusDot (状态指示器)
├── Title (标题 - 70%)
├── WorkspaceBadge (工作区徽章 - 20%) ← 新增
│   └── onClick → 打开 WorkspaceMenu
├── Loader2 (运行中指示器)
└── CloseButton (关闭按钮 - 10%)

WorkspaceMenu (工作区菜单) ← 已存在
├── 顶部: "会话工作区" + "新增" 按钮
├── 工作区列表
│   ├── 点击切换主工作区
│   └── 右侧按钮添加/移除关联
├── 关联工作区汇总
└── CreateWorkspaceModal ← 已存在

WorkspaceBadge (工作区徽章) ← 新增
├── 无工作区: [+] 灰色图标
├── 有工作区: [📁 名称]
└── 有关联: [📁 名称 +2]
```

### 已存在的组件

1. **WorkspaceMenu** (`src/components/Session/WorkspaceMenu.tsx`)
   - 完整的工作区管理界面
   - 支持切换主工作区
   - 支持添加/移除关联工作区
   - 集成了 CreateWorkspaceModal

2. **CreateWorkspaceModal** (`src/components/Workspace/CreateWorkspaceModal.tsx`)
   - 创建新工作区的弹窗
   - 支持输入名称和路径
   - 支持浏览选择文件夹
   - 可选择是否创建后切换

### 需要新增的组件

1. **WorkspaceBadge** (`src/components/Session/WorkspaceBadge.tsx`)
   - 显示工作区名称或"+"图标
   - 显示关联工作区数量
   - 点击打开 WorkspaceMenu

## 交互流程

### 1. 查看和切换工作区

```
用户点击徽章
    ↓
打开 WorkspaceMenu
    ↓
显示所有可用工作区
    ↓
用户选择工作区
    ↓
调用 updateSessionWorkspace
    ↓
更新 SessionMetadata 和 ConversationStore
    ↓
徽章显示更新
```

### 2. 新增工作区

```
用户点击徽章
    ↓
打开 WorkspaceMenu
    ↓
点击顶部"+ 新增"按钮
    ↓
打开 CreateWorkspaceModal
    ↓
输入名称和路径
    ↓
选择是否切换到新工作区
    ↓
创建成功
    ↓
如果勾选切换，自动关联到当前会话
```

### 3. 管理关联工作区

```
用户点击徽章
    ↓
打开 WorkspaceMenu
    ↓
点击工作区右侧的 + 按钮
    ↓
调用 addContextWorkspace
    ↓
更新 SessionMetadata.contextWorkspaceIds
    ↓
徽章显示数量 +1
```

## 数据模型

### SessionMetadata 扩展

```typescript
interface SessionMetadata {
  id: string
  title: string
  type: 'project' | 'free'
  workspaceId: string | null          // 主工作区 ID
  workspaceName?: string               // 主工作区名称（缓存）
  contextWorkspaceIds: string[]        // 关联工作区 ID 列表
  status: 'idle' | 'running' | ...
  createdAt: string
  updatedAt: string
}
```

### ConversationState 扩展

```typescript
interface ConversationState {
  // ... 现有字段 ...
  workspaceId: string | null           // 主工作区 ID
  inputDraft: InputDraft               // 输入草稿
}
```

## 状态管理方法

### SessionStoreManager 新增方法

```typescript
// 更新会话的主工作区
updateSessionWorkspace(sessionId: string, workspaceId: string | null): void

// 添加关联工作区
addContextWorkspace(sessionId: string, workspaceId: string): void

// 移除关联工作区
removeContextWorkspace(sessionId: string, workspaceId: string): void
```

## 实现优先级

### Phase 1: 核心组件 (高优先级)

1. 创建 WorkspaceBadge 组件
2. 修改 SessionTab 集成徽章
3. 实现 updateSessionWorkspace 方法

### Phase 2: 关联工作区 (中优先级)

4. 添加 contextWorkspaceIds 字段
5. 实现 addContextWorkspace 方法
6. 实现 removeContextWorkspace 方法

### Phase 3: 适配和集成 (中优先级)

7. 适配 WorkspaceMenu 使用 SessionStoreManager
8. 集成 WorkspaceMenu 到 SessionTab

### Phase 4: 测试和优化 (低优先级)

9. 编写单元测试
10. 性能优化
11. 用户体验优化

## 关键技术点

### 1. 工作区名称缓存

在 SessionMetadata 中缓存工作区名称，避免每次渲染都查询：

```typescript
const workspace = useWorkspaceStore.getState().workspaces.find(w => w.id === workspaceId)
metadata.workspaceName = workspace?.name
```

### 2. 徽章定位

使用 ref 获取徽章位置，将菜单定位在徽章下方：

```typescript
const badgeRef = useRef<HTMLButtonElement>(null)

<WorkspaceMenu
  anchorEl={badgeRef.current}
  onClose={() => setShowWorkspaceMenu(false)}
/>
```

### 3. 事件冒泡阻止

点击徽章时阻止事件冒泡，避免触发标签切换：

```typescript
onClick={(e) => {
  e.stopPropagation()
  setShowWorkspaceMenu(true)
}
```

### 4. 工作区上下文传递

发送消息时自动传递工作区路径：

```typescript
const workspace = useActiveSessionWorkspace()
onSend(value, workspace?.path, attachments)
```

## 视觉设计

### 徽章样式

- **无工作区**: 灰色背景 + Plus 图标
- **有工作区**: 渐变色背景 + Folder 图标 + 名称
- **有关联**: 渐变色背景 + Folder 图标 + 名称 + 数量徽章

### 颜色方案

```css
/* 无工作区 */
background: rgba(107, 114, 128, 0.2);
color: rgba(107, 114, 128, 1);

/* 有工作区 */
background: linear-gradient(135deg, #7aa2f7 0%, #bb9af7 100%);
color: rgba(122, 162, 247, 1);

/* hover 状态 */
background: linear-gradient(135deg, #7aa2f7 20%, #bb9af7 120%);
```

## 原型参考

完整的交互原型和视觉设计参考：
`.polaris/requirements/prototypes/session-workspace-integration.html`

在浏览器中打开该文件可以查看：
- 三种方案对比
- 推荐方案的详细交互流程
- 实现要点和技术细节

## 总结

这个集成方案的核心优势：

1. **信息密度高**: 在有限空间内展示最重要的信息
2. **交互直观**: 点击徽章即可管理工作区
3. **会话级绑定**: 每个会话独立管理工作区，不影响其他会话
4. **功能完整**: 支持查看、切换、新增、关联工作区的完整流程
5. **复用现有组件**: WorkspaceMenu 和 CreateWorkspaceModal 已实现，只需集成

下一步可以开始实现 Phase 1 的核心组件，然后逐步完成其他功能。
