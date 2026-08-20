# Subagent 自动分屏设计方案

> 日期: 2026-04-24
> 状态: Draft
> 方案: A — 前端虚拟面板

## 1. 背景与目标

### 1.1 现状

当 Claude Code 通过 Agent 工具派发 subagent 时，Polaris 前端收到以下事件流：

```
agent_run_start { taskId, agentType, capabilities }
  → tool_call_start / tool_call_end (嵌套工具调用)
agent_run_end { taskId, success, result }
```

当前处理方式：`eventHandler.ts` 将 `agent_run_start` 映射为 `AgentRunBlock`（折叠摘要块），所有嵌套工具调用压缩为一行统计。用户无法看到 subagent 的实时工作过程。

### 1.2 目标

当 subagent 启动时，自动在右侧面板的 `MultiSessionGrid` 中创建一个**虚拟会话单元格**，实时展示该 subagent 的工具调用链和状态变化，无需任何手动操作。

### 1.3 范围

- 仅前端改动，不修改 Rust 后端
- 不依赖 CLI 新能力
- 复用现有 `MultiSessionGrid` + `sessionStoreManager` 基础设施

## 2. 核心设计

### 2.1 虚拟会话（Virtual Session）

**定义**：为 subagent 创建的轻量会话实例，与普通用户会话共享同一套 `ConversationStore` 工厂和管理机制，但有以下差异：

| 属性 | 普通会话 | 虚拟会话 |
|------|----------|----------|
| ID 格式 | `uuid` | `subagent-{taskId}` |
| 来源 | 用户手动创建 | `agent_run_start` 自动创建 |
| 生命周期 | 手动关闭 | `agent_run_end` 后标记完成，LRU 驱逐 |
| 消息类型 | 完整用户/助手消息 | 仅工具调用事件 |
| contextId | `session-{uuid}` | 不参与后端路由（纯前端） |
| SessionMetadata.isVirtual | `false` | `true` |
| SessionMetadata.parentSessionId | — | 父会话 ID |

### 2.2 事件路由改造

**关键洞察**：当前 `tool_call_start` / `tool_call_end` 事件**不携带** `parentTaskId` 字段。后端 `event_parser.rs` 将 subagent 的嵌套工具调用作为普通的 `ToolCallStart` 事件发出，前端无法区分它们属于父 agent 还是 subagent。

**解决思路**：利用 `activeTaskId` 状态追踪。当 `agent_run_start` 被处理后，`activeTaskId` 被设置为该 taskId。后续的 `tool_call_start/end` 如果发生在 `activeTaskId` 非空的期间，即为 subagent 的嵌套调用。

```
eventHandler.ts 改造逻辑：

agent_run_start:
  1. 原有逻辑：appendAgentRunBlock
  2. 新增逻辑：
     a. 检查 autoSplitOnSubagent 开关
     b. 创建虚拟会话：sessionStoreManager.createVirtualSession(...)
     c. 开启 "subagent 接收模式"

tool_call_start (subagent 接收模式开启时):
  1. 原有逻辑：appendToolCallBlock（主会话）
  2. 新增逻辑：同时转发到虚拟会话 store

tool_call_end (subagent 接收模式开启时):
  1. 原有逻辑：updateToolCallBlock（主会话）
  2. 新增逻辑：同时转发到虚拟会话 store

agent_run_end:
  1. 原有逻辑：updateAgentRunBlock
  2. 新增逻辑：
     a. 关闭 "subagent 接收模式"
     b. 虚拟会话标记完成
```

### 2.3 自动分屏触发

```
触发条件：
  1. autoSplitOnSubagent 设置为 true
  2. 收到 agent_run_start 事件
  3. 尚未存在相同 taskId 的虚拟会话

触发动作：
  1. sessionStoreManager.createVirtualSession(parentSessionId, taskId, agentType)
  2. 如果 multiSessionMode 为 false，自动开启
  3. viewStore.addToMultiView(virtualSessionId)
  4. viewStore.requestScrollToSession(virtualSessionId)
```

## 3. 变更文件清单

### 3.1 类型定义

**`src/stores/conversationStore/types.ts`**

```typescript
// SessionMetadata 新增字段
interface SessionMetadata {
  // ... 现有字段
  /** 是否为虚拟会话（subagent 自动创建） */
  isVirtual?: boolean
  /** 父会话 ID（虚拟会话关联的父会话） */
  parentSessionId?: string
  /** 关联的 AgentRun taskId */
  linkedTaskId?: string
}

// SessionManagerActions 新增方法
interface SessionManagerActions {
  // ... 现有方法
  /** 创建虚拟会话（subagent 分屏用） */
  createVirtualSession: (parentSessionId: string, taskId: string, agentType: string) => string
  /** 根据 taskId 查找虚拟会话 ID */
  findVirtualSessionByTaskId: (taskId: string) => string | null
}

// ConversationState 新增字段
interface ConversationState {
  // ... 现有字段
  /** 是否处于 subagent 接收模式（activeTaskId 非空且自动分屏开启时） */
  isSubagentReceiving: boolean
}
```

**`src/ai-runtime/event.ts`** — 无需修改（事件类型已完备）

### 3.2 会话管理器

**`src/stores/conversationStore/sessionStoreManager.ts`**

新增 `createVirtualSession` 方法：

```typescript
createVirtualSession: (parentSessionId: string, taskId: string, agentType: string) => {
  const virtualSessionId = `subagent-${taskId}`

  // 如果已存在，返回已有 ID
  if (get().stores.has(virtualSessionId)) {
    return virtualSessionId
  }

  // 复用 createSession，但设置虚拟会话标记
  const sessionId = get().createSession({
    id: virtualSessionId,
    type: 'free',
    title: `Subagent: ${agentType}`,
    silentMode: true, // 不自动激活
  })

  // 追加虚拟会话元数据
  const meta = get().sessionMetadata.get(sessionId)
  if (meta) {
    set((state) => {
      const newMetadata = new Map(state.sessionMetadata)
      newMetadata.set(sessionId, {
        ...meta,
        isVirtual: true,
        parentSessionId,
        linkedTaskId: taskId,
      })
      return { sessionMetadata: newMetadata }
    })
  }

  // 自动加入多窗口视图
  const viewState = useViewStore.getState()
  if (!viewState.multiSessionMode) {
    viewState.toggleMultiSessionMode()
    // 确保父会话也在网格中
    viewState.addToMultiView(parentSessionId)
  }
  viewState.addToMultiView(sessionId)
  viewState.requestScrollToSession(sessionId)

  return sessionId
}

findVirtualSessionByTaskId: (taskId: string) => {
  const virtualId = `subagent-${taskId}`
  return get().stores.has(virtualId) ? virtualId : null
}
```

### 3.3 事件处理器

**`src/stores/conversationStore/eventHandler.ts`**

改造 `agent_run_start`、`tool_call_start/end`、`agent_run_end` 四个分支：

```typescript
// agent_run_start 分支改造
case 'agent_run_start': {
  state.appendAgentRunBlock(event.taskId, event.agentType, event.capabilities)

  // 新增：自动分屏逻辑
  const { autoSplitOnSubagent } = useViewStore.getState()
  if (autoSplitOnSubagent) {
    const manager = sessionStoreManager.getState()
    const virtualId = manager.createVirtualSession(
      state.sessionId, event.taskId, event.agentType
    )
    // 虚拟会话添加启动消息
    const virtualStore = manager.getStore(virtualId)
    if (virtualStore) {
      virtualStore.setStreaming(true)
    }
  }
  break
}

// tool_call_start 分支改造
case 'tool_call_start': {
  const toolName = event.tool
  const callId = event.callId || crypto.randomUUID()
  state.appendToolCallBlock(callId, toolName, event.args)

  // 新增：转发到虚拟会话（如果正在 subagent 接收模式）
  const { activeTaskId } = get()
  if (activeTaskId) {
    const manager = sessionStoreManager.getState()
    const virtualId = manager.findVirtualSessionByTaskId(activeTaskId)
    if (virtualId) {
      const virtualStore = manager.getStore(virtualId)
      if (virtualStore) {
        virtualStore.appendToolCallBlock(callId, toolName, event.args)
      }
    }
  }
  break
}

// tool_call_end 分支改造 — 同理转发
case 'tool_call_end': {
  // ... 原有逻辑不变

  // 新增：转发到虚拟会话
  const { activeTaskId: tid } = get()
  if (tid) {
    const manager = sessionStoreManager.getState()
    const virtualId = manager.findVirtualSessionByTaskId(tid)
    if (virtualId) {
      const virtualStore = manager.getStore(virtualId)
      if (virtualStore) {
        const output = typeof event.result === 'string'
          ? event.result
          : (event.result ? JSON.stringify(event.result, null, 2) : undefined)
        virtualStore.updateToolCallBlock(
          event.callId || '',
          event.success ? 'completed' : 'failed',
          output
        )
      }
    }
  }
  break
}

// agent_run_end 分支改造
case 'agent_run_end': {
  state.updateAgentRunBlock(event.taskId, {
    status: event.success ? 'success' : 'error',
    output: event.result,
    completedAt: new Date().toISOString(),
  })
  state.setActiveTask(null)

  // 新增：虚拟会话标记完成
  const manager = sessionStoreManager.getState()
  const virtualId = manager.findVirtualSessionByTaskId(event.taskId)
  if (virtualId) {
    const virtualStore = manager.getStore(virtualId)
    if (virtualStore) {
      virtualStore.setStreaming(false)
      // 添加完成消息
      virtualStore.appendTextBlock(
        event.success
          ? `\n---\nSubagent completed. ${event.result || ''}`
          : `\n---\nSubagent failed. ${event.result || ''}`
      )
      virtualStore.finishMessage()
    }
    // 更新元数据状态
    const meta = manager.sessionMetadata.get(virtualId)
    if (meta) {
      sessionStoreManager.setState((state) => {
        const newMetadata = new Map(state.sessionMetadata)
        newMetadata.set(virtualId, { ...meta, status: 'idle' })
        return { sessionMetadata: newMetadata }
      })
    }
  }
  break
}
```

### 3.4 视图配置

**`src/stores/viewStore.ts`**

新增 `autoSplitOnSubagent` 配置项：

```typescript
// ViewState 新增
autoSplitOnSubagent: boolean  // 默认 true

// ViewActions 新增
setAutoSplitOnSubagent: (enabled: boolean) => void
```

### 3.5 UI 组件

**`src/components/Chat/SessionCell.tsx`**

虚拟会话 cell 的差异化渲染：

- Header 显示 agentType 图标 + "Subagent" 标签
- 父会话关联按钮（点击跳转回父会话）
- 完成后显示折叠按钮（收起网格单元）

**`src/components/Chat/AgentRunBlockRenderer.tsx`**

新增「在分屏中查看」按钮：

- 当 `autoSplitOnSubagent` 为 false 时，提供手动分屏入口
- 当虚拟会话已存在时，显示「跳转到分屏」按钮

**`src/components/Chat/MultiWindowMenu.tsx`**

新增自动分屏开关 checkbox。

### 3.6 LRU 驱逐保护

**`src/stores/conversationStore/sessionStoreManager.ts`** 中 `evictIdleSessions` 函数：

现有保护规则已覆盖 `status === 'running'` 的会话。虚拟会话运行时 `status` 为 `running`，因此**无需额外修改**。虚拟会话完成后变为 `idle`，会被正常 LRU 驱逐。

## 4. 数据流图

```
Claude Code CLI
    │
    ▼ SSE Events
Tauri Backend (event_parser.rs)
    │
    │ ToolCallStart / ToolCallEnd / AgentRunStart / AgentRunEnd
    │ (所有事件共享同一 sessionId，无 parentTaskId)
    ▼
EventRouter
    │
    ▼ dispatchEvent (by sessionId)
ConversationStore.handleAIEvent (父会话)
    │
    ├── agent_run_start → appendAgentRunBlock
    │               └── [新增] createVirtualSession → 虚拟会话加入 MultiSessionGrid
    │
    ├── tool_call_start → appendToolCallBlock (父会话)
    │               └── [新增] appendToolCallBlock (虚拟会话)
    │
    ├── tool_call_end → updateToolCallBlock (父会话)
    │             └── [新增] updateToolCallBlock (虚拟会话)
    │
    └── agent_run_end → updateAgentRunBlock (父会话)
                  └── [新增] 虚拟会话标记完成
```

## 5. 边界情况

| 场景 | 处理方式 |
|------|----------|
| 并行 subagent（同一父会话派发多个） | 每个 taskId 创建独立虚拟会话，但受 `activeTaskId` 同一时间只跟踪一个。需要改为栈式追踪。 |
| 嵌套 subagent（subagent 再派 subagent） | 最多支持 1 层嵌套，更深层级折叠为摘要 |
| 用户在 subagent 运行中关闭虚拟 cell | 虚拟会话仍存在于 store，但不在网格中显示。可通过 AgentRunBlock 的「查看详情」重新打开 |
| Subagent 快速完成（<100ms） | 虚拟会话创建后立即标记完成。仍然有价值：用户能看到完整的工具调用链 |
| autoSplitOnSubagent 为 false | 不创建虚拟会话，AgentRunBlock 提供手动「在分屏中查看」按钮 |

## 6. 并行 Subagent 栈式追踪

当前 `activeTaskId` 是单一值，无法追踪并行 subagent。需要改为栈：

```typescript
// ConversationState 改造
agentTaskStack: string[]  // 替代 activeTaskId（单一值）

// eventHandler 改造
case 'agent_run_start':
  // push 到栈
  state.pushAgentTask(event.taskId)

case 'agent_run_end':
  // 从栈中移除
  state.removeAgentTask(event.taskId)

// tool_call_start/end 中
const currentTaskId = get().agentTaskStack[get().agentTaskStack.length - 1]
```

**向后兼容**：保留 `activeTaskId` getter 指向栈顶，现有 `appendAgentRunBlock` 等逻辑不变。

## 7. 实现步骤

```
Step 1: 类型定义扩展 (types.ts)
  - SessionMetadata 新增 isVirtual, parentSessionId, linkedTaskId
  - ConversationState 新增 agentTaskStack
  - SessionManagerActions 新增 createVirtualSession, findVirtualSessionByTaskId

Step 2: viewStore 配置扩展
  - 新增 autoSplitOnSubagent 状态和 setter
  - 持久化到 localStorage

Step 3: sessionStoreManager 虚拟会话管理
  - 实现 createVirtualSession
  - 实现 findVirtualSessionByTaskId
  - 确保 silentMode=true 的虚拟会话被正确保护

Step 4: eventHandler 路由改造
  - agent_run_start: 创建虚拟会话
  - tool_call_start/end: 转发到虚拟会话
  - agent_run_end: 标记虚拟会话完成
  - agentTaskStack 栈管理

Step 5: SessionCell 虚拟会话渲染
  - 虚拟会话差异化 UI
  - 父会话跳转按钮
  - 完成后折叠

Step 6: AgentRunBlockRenderer 手动分屏按钮
  - autoSplitOnSubagent=false 时显示
  - 跳转到已有虚拟会话

Step 7: MultiWindowMenu 开关
  - 自动分屏 checkbox

Step 8: 端到端测试
  - 手动测试：触发 subagent → 验证自动分屏
  - 边界测试：并行 subagent、快速完成、关闭 cell
```

## 8. 不做的事

- 不修改 Rust 后端（event_parser.rs 不动）
- 不尝试获取 subagent 的完整 token 流（CLI 不暴露）
- 不做 Tauri 多窗口/多 webview（过度工程化）
- 不做 subagent 的消息输入能力（只读展示）
