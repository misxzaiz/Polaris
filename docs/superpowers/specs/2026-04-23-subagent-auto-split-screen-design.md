# Subagent 自动分屏设计文档

> 日期: 2026-04-23
> 状态: Draft
> 方案: A — 纯前端虚拟面板

## 1. 背景与目标

### 1.1 问题

当 Claude Code 通过 Agent 工具派发 subagent 时，Polaris 当前只展示一个折叠的 `AgentRunBlock` 摘要块。Subagent 的工具调用链、思考过程、代码变更等关键信息被压缩为一段 summary，用户无法实时观察子代理的工作状态。

### 1.2 目标

- **自动分屏**: Agent 工具启动时，自动在 MultiSessionGrid 中创建独立面板，实时展示子代理工作流
- **零后端改动**: 纯前端实现，不修改 Rust 层
- **渐进增强**: 复用现有 MultiSessionGrid + sessionStoreManager 基础设施

### 1.3 关键发现

| 发现 | 影响 |
|------|------|
| 后端 `event_parser.rs` 不 emit `agent_run_start/end`，Agent 被当作普通 tool_call 处理 | 需在前端 `eventHandler.ts` 中检测 Agent 工具 |
| 前端 `eventHandler.ts` 有 `agent_run_start/end` 处理代码，但从未触发（死代码） | 可以复用/激活这些 handler |
| Agent 工具的 tool name 为 `"Agent"` 或 `"agent"`，args 含 `agentType`/`subagent_type` | 可精确检测 subagent 启动 |
| Agent tool_call_start 后，父 Agent 阻塞等待结果，期间所有 stream 事件均属于子代理 | 可用 callId 追踪界定事件边界 |

## 2. 架构设计

### 2.1 核心思路

在 `eventHandler.ts` 中拦截 `tool_call_start`，当检测到 tool 为 Agent 时：

1. 生成虚拟 sessionId（`virtual-{callId}`）
2. 调用 `sessionStoreManager.createSession()` 创建虚拟会话
3. 记录 `activeAgentCallId` 状态，后续事件路由到虚拟会话
4. 当匹配的 `tool_call_end` 到达时，标记虚拟会话完成

```
时间线:
  tool_call_start(tool="Agent", callId="abc", args={agentType:"Explore"})
    │
    ├─ [虚拟会话创建] sessionId="virtual-abc"
    ├─ activeAgentCallId = "abc"
    │
    ├─ tool_call_start(tool="Grep")     → 路由到虚拟会话
    ├─ tool_call_end(tool="Grep")       → 路由到虚拟会话
    ├─ tool_call_start(tool="Read")     → 路由到虚拟会话
    ├─ tool_call_end(tool="Read")       → 路由到虚拟会话
    ├─ token("...")                     → 路由到虚拟会话
    │
  tool_call_end(callId="abc")
    │
    ├─ [虚拟会话标记完成]
    ├─ activeAgentCallId = null
    └─ 主会话 AgentRunBlock 更新 [查看详情→] 按钮
```

### 2.2 事件路由逻辑

在 `eventHandler.ts` 的 `handleAIEvent` 函数中增加前置拦截：

```typescript
// 伪代码
function handleAIEvent(event, set, get) {
  const state = get();

  // === 新增: Subagent 事件路由 ===
  if (state.activeAgentCallId) {
    // 正在执行 subagent，所有事件路由到虚拟会话
    if (isTerminalEvent(event, state.activeAgentCallId)) {
      // Agent tool_call_end → 结束 subagent 模式
      deactivateVirtualSession(state.activeAgentCallId, set, get);
      // 继续正常处理此事件（更新主会话 AgentRunBlock）
    } else {
      // 路由到虚拟会话
      routeToVirtualSession(state.activeAgentCallId, event);
      return; // 不进入主会话 handler
    }
  }

  // 检测 Agent 工具启动
  if (event.type === 'tool_call_start' && isAgentTool(event.tool)) {
    activateVirtualSession(event, set, get);
    // 同时在主会话创建 AgentRunBlock（保持现有行为）
  }

  // ... 原有 switch 逻辑
}
```

### 2.3 判定函数

```typescript
const AGENT_TOOL_NAMES = new Set(['Agent', 'agent']);

function isAgentTool(toolName: string): boolean {
  return AGENT_TOOL_NAMES.has(toolName);
}

function isTerminalEvent(event: AIEvent, activeCallId: string): boolean {
  return event.type === 'tool_call_end'
    && event.callId === activeCallId;
}
```

## 3. 数据模型变更

### 3.1 ConversationState 扩展

在 `src/stores/conversationStore/types.ts` 的 `ConversationState` 中新增：

```typescript
// ===== Subagent 自动分屏 =====
/** 当前活跃的 Agent 工具调用 ID（null 表示无活跃 subagent） */
activeAgentCallId: string | null
/** 虚拟会话 ID 映射: agentCallId → virtualSessionId */
agentVirtualSessionMap: Map<string, string>
```

### 3.2 SessionMetadata 扩展

在 `SessionMetadata` 接口中新增：

```typescript
/** 是否为虚拟会话（subagent 自动创建） */
isVirtual?: boolean
/** 父会话 ID（虚拟会话关联的主会话） */
parentSessionId?: string
/** 关联的 Agent 工具调用 ID */
linkedCallId?: string
```

### 3.3 createConversationStore 初始值

```typescript
activeAgentCallId: null,
agentVirtualSessionMap: new Map(),
```

## 4. 组件变更

### 4.1 eventHandler.ts（核心变更）

**文件**: `src/stores/conversationStore/eventHandler.ts`

变更点：

1. 新增 `activeAgentCallId` 前置拦截逻辑（在 switch 之前）
2. `tool_call_start` case 中检测 Agent 工具 → 创建虚拟会话
3. `tool_call_end` case 中检测 Agent callId 结束 → 标记虚拟会话完成
4. 恢复已存在的 `agent_run_start` / `agent_run_end` case（当前为死代码，保持兼容）

### 4.2 sessionStoreManager.ts

**文件**: `src/stores/conversationStore/sessionStoreManager.ts`

新增方法 `createVirtualSession`:

```typescript
createVirtualSession: (parentSessionId: string, callId: string, agentType: string) => {
  const virtualId = `virtual-${callId}`;
  // 检查是否已存在
  if (get().stores.has(virtualId)) return virtualId;

  get().createSession({
    id: virtualId,
    type: 'free',
    title: `Subagent: ${agentType}`,
    silentMode: true, // 初始静默，由分屏逻辑决定是否显示
  });

  // 更新虚拟会话元数据
  set((state) => {
    const newMetadata = new Map(state.sessionMetadata);
    const meta = newMetadata.get(virtualId);
    if (meta) {
      newMetadata.set(virtualId, {
        ...meta,
        isVirtual: true,
        parentSessionId,
        linkedCallId: callId,
      });
    }
    return { sessionMetadata: newMetadata };
  });

  // 自动加入多窗口视图
  const viewState = useViewStore.getState();
  if (viewState.multiSessionMode) {
    viewState.addToMultiView(virtualId);
  } else {
    // 开启多窗口模式
    useViewStore.getState().setMultiSessionMode(true);
    viewState.addToMultiView(virtualId);
  }

  return virtualId;
}
```

### 4.3 MultiSessionGrid.tsx

**文件**: `src/components/Chat/MultiSessionGrid.tsx`

变更点：
- 虚拟会话 cell 使用不同的视觉标识（subagent 图标、父会话标题关联）
- 虚拟会话完成后 30 秒自动折叠（可选）

### 4.4 SessionCell.tsx

**文件**: `src/components/Chat/SessionCell.tsx`

变更点：
- 虚拟会话 header 显示 agentType 图标而非普通会话图标
- 显示父会话标题作为副标题
- 完成状态时显示工具调用统计

### 4.5 AgentRunBlockRenderer.tsx

**文件**: `src/components/Chat/AgentRunBlockRenderer.tsx`

变更点：
- 添加「在分屏中查看」按钮，点击跳转到虚拟会话 cell
- 按钮调用 `viewStore.requestScrollToSession(virtualSessionId)`

### 4.6 viewStore.ts

**文件**: `src/stores/viewStore.ts`

新增配置：
```typescript
/** 自动分屏开关 */
autoSplitOnSubagent: boolean  // 默认 true
```

### 4.7 MultiWindowMenu.tsx / ChatStatusBar

新增「自动分屏」开关控件。

## 5. 不需要变更的文件

以下文件 **不需要修改**：

| 文件 | 原因 |
|------|------|
| `src-tauri/src/ai/event_parser.rs` | 不需要后端改动，Agent 事件通过前端检测 |
| `src/ai-runtime/event.ts` | 不新增事件类型，复用 `tool_call_start/end` |
| `src/types/chat.ts` | 不新增 ContentBlock 类型 |
| `src/stores/conversationStore/createConversationStore.ts` | 仅在初始值中添加新字段 |

## 6. 边界情况处理

### 6.1 嵌套 subagent（agent 派 agent）

- 支持 1 层嵌套（agent 内再派 agent）
- 第 2 层 subagent 创建新的虚拟会话，并标记 `parentSessionId` 为第 1 层的虚拟会话
- 超过 2 层时，最深层的 subagent 事件仍然路由到最近的活跃虚拟会话
- 实际上 Claude Code Agent 工具最多 1 层嵌套（subagent 不能再派 subagent），所以这只是防御性设计

### 6.2 多个并行 subagent

- 每个 Agent callId 对应一个独立虚拟会话
- `activeAgentCallId` 使用栈结构（`string[]`）支持并行
- 但实际上 Claude Code CLI 是串行执行 Agent 工具的（一个 Agent 完成后才执行下一个），所以单值即可

### 6.3 LRU 驱逐保护

- 虚拟会话运行中（`status === 'running'`）不可驱逐（已有保护逻辑）
- 虚拟会话完成后进入 LRU 候选，30 秒后可被清理

### 6.4 用户关闭虚拟会话

- 用户可手动关闭虚拟会话 cell
- 关闭后，主会话 AgentRunBlock 中的「查看详情」按钮变为灰色（已关闭）
- 后续 subagent 事件正常路由到主会话（降级为原有行为）

## 7. 工作量估算

| 步骤 | 文件 | 预估 |
|------|------|------|
| Step 1: 状态字段扩展 | `types.ts`, `createConversationStore.ts` | 0.5h |
| Step 2: 事件路由拦截 | `eventHandler.ts` | 2h |
| Step 3: 虚拟会话管理 | `sessionStoreManager.ts` | 1.5h |
| Step 4: 分屏自动激活 | `MultiSessionGrid.tsx`, `viewStore.ts` | 1h |
| Step 5: 虚拟会话 UI | `SessionCell.tsx` | 1.5h |
| Step 6: 查看详情按钮 | `AgentRunBlockRenderer.tsx` | 0.5h |
| Step 7: 开关控件 | `MultiWindowMenu.tsx`, `ChatStatusBar` | 0.5h |
| Step 8: 端到端测试 | 手动 + Vitest | 2h |
| **合计** | | **~10h (1.5 天)** |

## 8. 验收标准

1. [ ] Agent 工具启动时，自动创建分屏面板，显示 agentType 和实时状态
2. [ ] Subagent 的工具调用在虚拟面板中实时展示（名称、状态、输出）
3. [ ] Subagent 完成时，虚拟面板显示完成状态和工具调用统计
4. [ ] 主会话 AgentRunBlock 有「查看详情」按钮，点击跳转到虚拟面板
5. [ ] 自动分屏可通过设置开关控制
6. [ ] 虚拟会话在完成后可被 LRU 正常驱逐
7. [ ] 无 subagent 场景下，现有行为完全不变
8. [ ] TypeScript 编译零错误

## 9. 未来扩展（不在本期范围）

- **Phase 2**: 后端 emit 独立的 subagent token 流，虚拟面板展示完整文本输出
- **Phase 3**: 虚拟面板内支持交互（向 subagent 发送 input）
- **Phase 4**: 嵌套 subagent 的树状视图
