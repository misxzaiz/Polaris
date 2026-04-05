# 实现计划 - 会话标签页增强功能

## 概述

本实现计划将会话标签页增强功能分解为可执行的编码任务。该功能解决四个核心问题：工作区管理、消息实时显示、发送按钮状态同步、输入框会话隔离。

实现将分为 5 个阶段，每个阶段包含具体的编码任务和测试任务。

## 任务列表

- [x] 1. Phase 1: 数据模型扩展
  - [x] 1.1 扩展 ConversationState 添加 inputDraft 和 workspaceId 字段
    - 在 `src/stores/conversationStore/types.ts` 中添加 `inputDraft` 字段（包含 text 和 attachments）
    - 在 `src/stores/conversationStore/types.ts` 中添加 `workspaceId` 字段
    - 定义 `InputDraft` 接口类型
    - _需求: 5.2, 5.3, 6.1_

  - [x] 1.2 扩展 SessionMetadata 添加 workspaceName 字段
    - 在 `src/stores/conversationStore/types.ts` 中的 `SessionMetadata` 接口添加 `workspaceName` 可选字段
    - _需求: 1.9_

  - [x] 1.3 更新 createConversationStore 初始化逻辑
    - 在 `src/stores/conversationStore/createConversationStore.ts` 的 `createInitialState` 函数中初始化 `inputDraft` 为空对象
    - 在 `createInitialState` 函数中初始化 `workspaceId` 为 null
    - _需求: 5.2, 6.1_

  - [ ]* 1.4 编写数据模型单元测试
    - 测试 ConversationState 初始化包含 inputDraft 和 workspaceId
    - 测试 SessionMetadata 包含 workspaceName 字段
    - _需求: 1.1-1.10, 5.1-5.10_

- [x] 2. Phase 2: 输入草稿功能
  - [x] 2.1 实现 updateInputDraft 和 clearInputDraft 方法
    - 在 `src/stores/conversationStore/types.ts` 中的 `ConversationActions` 接口添加 `updateInputDraft` 和 `clearInputDraft` 方法签名
    - 在 `src/stores/conversationStore/createConversationStore.ts` 中实现 `updateInputDraft` 方法（更新 inputDraft 状态）
    - 在 `createConversationStore.ts` 中实现 `clearInputDraft` 方法（重置 inputDraft 为空）
    - 在 `sendMessage` 方法中调用 `clearInputDraft()` 清空草稿
    - _需求: 5.3, 5.4, 5.6_

  - [x] 2.2 创建 useActiveSessionInputDraft hook
    - 在 `src/stores/conversationStore/useActiveSession.ts` 中创建 `useActiveSessionInputDraft` 函数
    - 使用 `useActiveSessionSelector` 订阅 `inputDraft` 状态
    - 返回默认值 `{ text: '', attachments: [] }`
    - _需求: 5.9_

  - [x] 2.3 修改 ChatInput 组件使用 Store 中的输入草稿
    - 在 `src/components/Chat/ChatInput.tsx` 中移除内部 `useState` 管理的 `value` 和 `attachments`
    - 使用 `useActiveSessionInputDraft()` 获取输入草稿
    - 使用 `useActiveSessionActions()` 获取 `updateInputDraft` 和 `clearInputDraft` 方法
    - 更新 `handleInputChange` 调用 `updateInputDraft`
    - 更新 `handleSend` 调用 `clearInputDraft`
    - _需求: 5.5, 5.9_

  - [x] 2.4 实现防抖更新机制
    - 在 `ChatInput.tsx` 中使用 `useDebouncedCallback` 包装 `updateInputDraft` 调用
    - 设置防抖延迟为 300ms
    - _需求: 5.10_

  - [ ]* 2.5 编写输入草稿功能单元测试
    - 测试 `updateInputDraft` 更新 inputDraft 状态
    - 测试 `clearInputDraft` 清空 inputDraft
    - 测试 `sendMessage` 自动清空 inputDraft
    - 测试会话切换时保留输入草稿
    - _需求: 5.1-5.10_

- [ ] 3. Checkpoint - 验证输入草稿功能
  - 确保所有测试通过，询问用户是否有问题

- [x] 4. Phase 3: 工作区管理 UI
  - [x] 4.1 创建 WorkspaceBadge 组件
    - 在 `src/components/Session/` 目录下创建 `WorkspaceBadge.tsx` 文件
    - 实现组件接口：接收 `sessionId`, `workspaceId`, `workspaceName`, `contextWorkspaceCount`, `onClick` props
    - 无工作区时显示灰色 + 图标（Plus 图标）
    - 有工作区时显示工作区名称 + Folder 图标
    - 如果有关联工作区，显示数量徽章（如 +2）
    - 使用渐变色背景区分不同状态
    - 添加 hover 效果和过渡动画
    - _需求: 1.9, 参考原型: .polaris/requirements/prototypes/session-workspace-integration.html_

  - [x] 4.2 修改 SessionTab 组件集成 WorkspaceBadge
    - 在 `src/components/Session/SessionTab.tsx` 中导入 `WorkspaceBadge` 组件
    - 添加 `showWorkspaceMenu` 状态管理工作区菜单显示
    - 使用 `useWorkspaceStore` 获取工作区信息
    - 在标题和关闭按钮之间插入 `WorkspaceBadge` 组件
    - 调整布局：标题占 70%，徽章占 20%，关闭按钮占 10%
    - 点击徽章时阻止事件冒泡，打开工作区菜单
    - _需求: 1.9, 参考原型_

  - [x] 4.3 集成 WorkspaceMenu 到 SessionTab
    - 在 `SessionTab.tsx` 中导入 `WorkspaceMenu` 组件
    - 当 `showWorkspaceMenu` 为 true 时渲染 WorkspaceMenu
    - 传递 `sessionId` 和 `onClose` 回调
    - 使用 Portal 或绝对定位将菜单定位在徽章下方
    - 实现点击外部关闭菜单的逻辑
    - 注意：WorkspaceMenu 已包含新增工作区功能（顶部"+ 新增"按钮 → CreateWorkspaceModal）
    - _需求: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.8_

  - [x] 4.4 适配 WorkspaceMenu 使用 SessionStoreManager
    - 修改 `src/components/Session/WorkspaceMenu.tsx`
    - 将 `useSessionStore` 替换为从 SessionStoreManager 获取会话元数据
    - 使用 SessionStoreManager 的方法而不是旧的 sessionStore
    - 确保工作区切换逻辑正确调用 SessionStoreManager
    - 保留 CreateWorkspaceModal 集成（已存在）
    - _需求: 1.5, 1.6, 1.10_

  - [x] 4.5 实现 updateSessionWorkspace 方法
    - 在 `src/stores/conversationStore/sessionStoreManager.ts` 中添加 `updateSessionWorkspace` 方法
    - 方法签名: `updateSessionWorkspace(sessionId: string, workspaceId: string | null): void`
    - 更新 `SessionMetadata` 的 `workspaceId` 字段
    - 从 `useWorkspaceStore` 获取工作区名称并更新 `workspaceName` 字段
    - 更新对应 `ConversationStore` 的 `workspaceId` 字段
    - 当 `workspaceId` 为 null 时，将 `type` 设置为 'free'
    - 当 `workspaceId` 不为 null 时，将 `type` 设置为 'project'
    - _需求: 1.5, 1.6, 1.10_

  - [x] 4.6 添加 contextWorkspaceIds 到 SessionMetadata
    - 在 `src/stores/conversationStore/types.ts` 的 `SessionMetadata` 接口添加 `contextWorkspaceIds` 字段
    - 类型为 `string[]`，默认值为空数组
    - 在 `sessionStoreManager.ts` 的 `createSession` 中初始化为空数组
    - _需求: 1.4, 1.5_

  - [x] 4.7 实现关联工作区管理方法
    - 在 `sessionStoreManager.ts` 中添加 `addContextWorkspace(sessionId: string, workspaceId: string): void`
    - 在 `sessionStoreManager.ts` 中添加 `removeContextWorkspace(sessionId: string, workspaceId: string): void`
    - 更新 `SessionMetadata` 的 `contextWorkspaceIds` 数组
    - 防止重复添加同一个工作区
    - _需求: 1.4, 1.5_

  - [ ]* 4.8 编写工作区管理功能单元测试
    - 测试 `updateSessionWorkspace` 更新工作区关联
    - 测试工作区删除时自动转换为自由会话
    - 测试 WorkspaceBadge 组件渲染
    - 测试关联工作区添加/移除
    - _需求: 1.1-1.10_

- [x] 5. Phase 4: 架构统一和状态同步
  - [x] 5.1 修改 App.tsx 使用 useActiveSessionStreaming
    - 在 `src/App.tsx` 中移除 `useEventChatStore` 的 `isStreaming` 订阅
    - 导入 `useActiveSessionStreaming` hook
    - 使用 `const isStreaming = useActiveSessionStreaming()` 替代
    - _需求: 3.1, 3.2, 4.1, 4.2_

  - [x] 5.2 验证发送按钮状态同步
    - 确认 `ChatInput` 组件正确接收 `isStreaming` prop
    - 确认发送按钮在 `isStreaming` 为 true 时显示中断按钮
    - 确认中断按钮使用红色背景
    - _需求: 3.3, 3.4, 4.3, 4.4_

  - [x] 5.3 实现会话状态同步到 SessionTab
    - 在 `sessionStoreManager.ts` 的 `dispatchEvent` 方法中更新 `SessionMetadata.status`
    - 根据事件类型设置状态：session_start → running, session_end → idle, error → error
    - 在会话切换到后台时设置状态为 background-running
    - _需求: 4.1, 4.2, 4.3, 4.4, 4.6_

  - [x] 5.4 实现后台会话完成通知
    - 在 `sessionStoreManager.ts` 的 `dispatchEvent` 方法中检测后台会话完成
    - 当后台会话收到 session_end 事件时，调用 `addToNotifications`
    - 在 `SessionTabs` 组件中显示未查看的完成通知数量
    - _需求: 4.7, 4.8_

  - [ ]* 5.5 编写架构统一功能集成测试
    - 测试 App.tsx 使用新架构的 isStreaming 状态
    - 测试发送按钮状态正确同步
    - 测试会话状态正确更新到 SessionTab
    - 测试后台会话完成通知
    - _需求: 3.1-3.10, 4.1-4.8_

- [ ] 6. Checkpoint - 验证架构统一
  - 确保所有测试通过，询问用户是否有问题

- [x] 7. Phase 5: 工作区上下文传递
  - [x] 7.1 创建 useActiveSessionWorkspace hook
    - 在 `src/stores/conversationStore/useActiveSession.ts` 中创建 `useActiveSessionWorkspace` 函数
    - 使用 `useActiveSessionSelector` 获取 `workspaceId`
    - 使用 `useWorkspaceStore` 根据 `workspaceId` 查找工作区对象
    - 返回工作区对象或 null
    - _需求: 6.1, 6.2_

  - [x] 7.2 修改 ChatInput 传递工作区上下文
    - 在 `ChatInput.tsx` 中使用 `useActiveSessionWorkspace()` 获取当前工作区
    - 在调用 `onSend` 时传递工作区路径：`onSend(value, workspace?.path, attachments)`
    - _需求: 6.1, 6.2, 6.3_

  - [x] 7.3 验证 sendMessage 使用工作区上下文
    - 确认 `createConversationStore.ts` 中的 `sendMessage` 方法接收 `workspaceDir` 参数
    - 确认 `workspaceDir` 参数传递给后端 API 的 `workDir` 选项
    - 确认当 `workspaceDir` 为 undefined 时使用 `deps.getWorkspace()?.path`
    - _需求: 6.4, 6.5_

  - [x] 7.4 实现工作区路径验证
    - 在 `sendMessage` 方法中已有错误处理逻辑
    - 错误上下文包含 workspaceDir 信息
    - 错误状态正确显示
    - _需求: 6.5_

  - [ ]* 7.5 编写工作区上下文传递集成测试
    - 测试 ChatInput 传递工作区路径到 sendMessage
    - 测试 sendMessage 使用工作区路径调用后端 API
    - 测试工作区路径无效时显示错误
    - _需求: 6.1-6.7_

- [x] 8. Phase 6: 消息实时显示验证
  - [x] 8.1 验证消息实时显示功能
    - 确认 `sendMessage` 方法在调用后端 API 之前添加用户消息到消息列表
    - 确认用户消息包含唯一标识符、内容、时间戳和发送者角色
    - 确认消息列表更新触发 UI 重新渲染
    - 确认聊天界面自动滚动到最新消息
    - _需求: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [x] 8.2 验证附件支持
    - 确认用户消息包含附件引用
    - 确认附件在消息对象中正确序列化
    - _需求: 2.7_

  - [x] 8.3 验证错误处理
    - 确认后端 API 返回错误时保留用户消息
    - 确认错误状态正确显示
    - _需求: 2.8_

  - [ ]* 8.4 编写消息实时显示集成测试
    - 测试发送消息后立即显示用户消息
    - 测试消息包含正确的字段
    - 测试附件正确包含在消息中
    - 测试错误时保留用户消息
    - _需求: 2.1-2.8_

- [ ] 9. Final Checkpoint - 完整功能验证
  - 确保所有测试通过，询问用户是否有问题

## 注意事项

- 标记 `*` 的任务为可选测试任务，可以跳过以加快 MVP 开发
- 每个任务都引用了具体的需求编号，确保可追溯性
- Checkpoint 任务用于在关键阶段验证功能和收集用户反馈
- 所有代码修改必须保持与现有架构的兼容性
- 使用 TypeScript 类型系统确保类型安全
