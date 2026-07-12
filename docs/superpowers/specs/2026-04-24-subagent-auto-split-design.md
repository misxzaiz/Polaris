# Subagent 自动分屏设计文档

> 日期: 2026-04-24
> 状态: Draft
> 方案: A — 前端虚拟面板（纯前端扩展）

## 1. 需求背景

当 Claude Code 通过 Agent 工具派发 subagent 时，Polaris 当前将其作为普通 tool_call 处理，subagent 的完整工作流（搜索、阅读、分析）被折叠为一个摘要块。用户无法实时观察 subagent 的工作过程。

本方案通过复用现有 MultiSessionGrid 基础设施，在 subagent 启动时自动创建虚拟面板，实时展示其工具调用链和工作状态。

## 2. 数据验证结论

### 2.1 CLI 事件流实测

通过 `claude --output-format stream-json --verbose` 实测确认：

```
主 Agent:
  [8] TOOL_USE: name=Agent, id=call_15c5c0ac, parent_tool_use_id=null
       input: { agentType: "Explore", description: "..." }

Subagent（全部带 parent_tool_use_id）:
  [12] TOOL_USE: name=Grep, id=call_30419c6b, parent_tool_use_id=call_15c5c0ac
  [13] TOOL_RESULT: id=call_30419c6b, parent_tool_use_id=call_15c5c0ac

主 Agent:
  [15] TOOL_RESULT: id=call_15c5c0ac, parent_tool_use_id=null
  [17] RESULT: subtype=success
```

**关键发现：**
- CLI 通过 `agent_progress` 事件类型输出 subagent 内部事件
- 所有 subagent 事件携带 `parent_tool_use_id` 字段，值为主 Agent 的 tool_use ID
- 主 Agent 事件 `parent_tool_use_id` 为 `null`
- Subagent 的完整 tool_use/tool_result 链可见

### 2.2 当前 Polaris 缺失

| 环节 | 问题 |
|------|------|
| `StreamEvent` (events.rs) | 各变体没有 `parent_tool_use_id` 字段，解析时丢弃 |
| `EventParser` (event_parser.rs) | 平铺处理所有事件，不区分主/subagent |
| `AgentRunStart/End` (ai_event.rs) | 类型已定义但从未构造（死代码） |
| 前端 eventHandler | `agent_run_start/end` case 存在但从未触发 |

## 3. 设计方案

### 3.1 架构总览

```
CLI stdout (stream-json)
  │
  ├─ { type: "assistant", parent_tool_use_id: null, ... }     ← 主 Agent
  ├─ { type: "assistant", parent_tool_use_id: "call_xxx", ... } ← Subagent
  ├─ { type: "user", parent_tool_use_id: "call_xxx", ... }      ← Subagent result
  │
  ▼
StreamEvent (events.rs) — 新增 parent_tool_use_id 字段
  │
  ▼
EventParser (event_parser.rs) — 检测 parent_tool_use_id 分流
  │
  ├─ parent_tool_use_id == null → 正常路由到主会话 store
  │
  └─ parent_tool_use_id != null
       ├─ 首次出现 → emit AgentRunStart + 创建虚拟会话
       ├─ 持续出现 → 路由到虚拟会话 store
       └─ 主 tool_result 到达 → emit AgentRunEnd
  │
  ▼
前端 eventRouter → sessionStoreManager → 虚拟会话 store
  │
  ▼
MultiSessionGrid — 自动添加/移除 subagent cell
```

### 3.2 后端变更

#### 3.2.1 `src-tauri/src/models/events.rs`

各 `StreamEvent` 变体新增可选字段：

```rust
// ToolStart 变体
ToolStart {
    #[serde(rename = "toolUseId")]
    tool_use_id: String,
    #[serde(rename = "toolName")]
    tool_name: String,
    input: serde_json::Value,
    // 新增
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
}

// Assistant 变体
Assistant {
    message: serde_json::Value,
    // 新增
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
}

// User 变体
User {
    message: serde_json::Value,
    // 新增
    #[serde(rename = "parentToolUseId")]
    parent_tool_use_id: Option<String>,
}
```

注意：`serde` 默认 `deny_unknown_fields` 未开启，新字段用 `Option` 且 `skip_serializing_if` 即可向后兼容。

#### 3.2.2 `src-tauri/src/ai/event_parser.rs`

新增 subagent 事件跟踪状态和分流逻辑：

```rust
pub struct EventParser {
    session_id: String,
    tool_call_manager: ToolCallManager,
    // 新增：跟踪活跃的 subagent
    active_subagents: HashMap<String, SubagentInfo>,  // key = parent_tool_use_id
}

struct SubagentInfo {
    agent_type: String,
    tool_calls: Vec<AgentNestedToolCall>,
}

impl EventParser {
    pub fn parse(&mut self, event: StreamEvent) -> Vec<AIEvent> {
        // 提取 parent_tool_use_id
        let parent_id = self.extract_parent_id(&event);

        match event {
            StreamEvent::Assistant { message, .. } => {
                // 如果有 parent_id，这是 subagent 事件
                if let Some(pid) = &parent_id {
                    self.parse_subagent_assistant(&pid, message)
                } else {
                    // 原有逻辑
                    self.parse_assistant_event(message)
                }
            }
            StreamEvent::ToolStart { tool_use_id, tool_name, input, parent_tool_use_id, .. } => {
                if parent_tool_use_id.is_some() {
                    // Subagent 内部的工具调用
                    self.parse_subagent_tool_start(parent_tool_use_id.unwrap(), tool_use_id, tool_name, input)
                } else if tool_name == "Agent" || tool_name == "Task" {
                    // 主 Agent 调用 Agent/Task 工具 → emit AgentRunStart
                    self.parse_agent_tool_start(tool_use_id, tool_name, input)
                } else {
                    // 原有逻辑
                    self.parse_tool_start(tool_use_id, tool_name, input)
                }
            }
            StreamEvent::User { message, parent_tool_use_id, .. } => {
                if parent_tool_use_id.is_some() {
                    // Subagent 的 tool_result
                    self.parse_subagent_user(parent_tool_use_id.unwrap(), message)
                } else {
                    // 原有逻辑
                    self.parse_user_event(message)
                }
            }
            // ... 其他事件不变
        }
    }

    /// 主 Agent 调用 Agent 工具时
    fn parse_agent_tool_start(&mut self, tool_use_id: String, tool_name: String, input: Value) -> Vec<AIEvent> {
        let agent_type = input.get("agentType")
            .or_else(|| input.get("subagent_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let capabilities = input.get("capabilities")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());

        // 注册 subagent
        self.active_subagents.insert(tool_use_id.clone(), SubagentInfo {
            agent_type: agent_type.clone(),
            tool_calls: Vec::new(),
        });

        let mut events = vec![
            AIEvent::AgentRunStart(
                AgentRunStartEvent::new(&self.session_id, &tool_use_id, &agent_type)
                    .with_capabilities(capabilities.unwrap_or_default())
            ),
        ];

        // 同时作为普通 tool_call 记录（兼容现有 UI）
        // ... appendToolCallBlock 等逻辑保持不变

        events
    }
}
```

#### 3.2.3 `src-tauri/src/ai/event_parser.rs` — Subagent 事件处理

```rust
/// Subagent 内部的 tool_start
fn parse_subagent_tool_start(
    &mut self,
    parent_id: String,
    tool_use_id: String,
    tool_name: String,
    input: Value,
) -> Vec<AIEvent> {
    // 记录到 subagent 的 tool_calls 列表
    if let Some(info) = self.active_subagents.get_mut(&parent_id) {
        info.tool_calls.push(AgentNestedToolCall {
            id: tool_use_id.clone(),
            name: tool_name.clone(),
            status: ToolCallStatus::Running,
        });
    }

    // 发出 AgentToolCall 事件（新增事件类型，见前端变更）
    vec![AIEvent::ToolCallStart(
        ToolCallStartEvent::new(&self.session_id, tool_name, /* args */)
            .with_call_id(tool_use_id)
            .with_parent_task_id(parent_id)  // 新增字段
    )]
}
```

### 3.3 前端变更

#### 3.3.1 新增事件类型

`src/ai-runtime/event.ts`:

```typescript
// ToolCallStartEvent 新增字段
export interface ToolCallStartEvent {
    type: 'tool_call_start'
    sessionId: string
    callId?: string
    tool: string
    args: Record<string, unknown>
    parentTaskId?: string  // 新增：subagent 归属标记
}

// ToolCallEndEvent 新增字段
export interface ToolCallEndEvent {
    type: 'tool_call_end'
    sessionId: string
    callId?: string
    tool: string
    result?: unknown
    success: boolean
    parentTaskId?: string  // 新增
}
```

#### 3.3.2 SessionManager 扩展

`src/stores/conversationStore/types.ts`:

```typescript
// SessionMetadata 新增字段
export interface SessionMetadata {
    // ... 现有字段
    isVirtual?: boolean             // 新增：标记虚拟会话
    parentSessionId?: string        // 新增：父会话 ID
    linkedTaskId?: string           // 新增：关联的 Agent 工具调用 ID
    agentType?: string              // 新增：subagent 类型
}
```

`src/stores/conversationStore/sessionStoreManager.ts` 新增方法：

```typescript
// 创建虚拟会话
createVirtualSession(parentSessionId: string, taskId: string, agentType: string): string {
    const virtualId = `virtual-${taskId}`;
    // 复用 createSession，标记为虚拟会话
    this.createSession({
        id: virtualId,
        type: 'free',
        title: `${agentType} Agent`,
        silentMode: true,  // 不自动激活
    });

    // 更新元数据
    set((state) => {
        const meta = state.sessionMetadata.get(virtualId);
        if (meta) {
            const newMetadata = new Map(state.sessionMetadata);
            newMetadata.set(virtualId, {
                ...meta,
                isVirtual: true,
                parentSessionId,
                linkedTaskId: taskId,
                agentType,
                status: 'running',
            });
            return { sessionMetadata: newMetadata };
        }
        return state;
    });

    // 自动添加到多会话网格
    const viewState = useViewStore.getState();
    if (viewState.autoSplitOnSubagent !== false) {  // 默认开启
        viewState.addToMultiView(virtualId);
    }

    return virtualId;
}
```

#### 3.3.3 事件路由改造

`src/stores/conversationStore/eventHandler.ts`:

```typescript
// agent_run_start: 创建虚拟会话
case 'agent_run_start': {
    state.appendAgentRunBlock(event.taskId, event.agentType, event.capabilities);

    // 新增：创建虚拟会话并自动分屏
    const autoSplit = useViewStore.getState().autoSplitOnSubagent !== false;
    if (autoSplit) {
        const manager = getSessionManager();
        const virtualId = manager.createVirtualSession(
            get().sessionId,
            event.taskId,
            event.agentType
        );
        // 记录映射关系
        activeVirtualSessions.set(event.taskId, virtualId);
    }
    break;
}

// tool_call_start: 如果有 parentTaskId，路由到虚拟会话
case 'tool_call_start': {
    const parentTaskId = event.parentTaskId;
    if (parentTaskId) {
        const virtualId = activeVirtualSessions.get(parentTaskId);
        if (virtualId) {
            const virtualStore = getSessionManager().getStore(virtualId);
            if (virtualStore) {
                virtualStore.handleAIEvent(event);
                return;  // 不路由到主会话
            }
        }
    }
    // 原有逻辑
    state.appendToolCallBlock(callId, toolName, event.args);
    break;
}

// agent_run_end: 标记虚拟会话完成
case 'agent_run_end': {
    state.updateAgentRunBlock(event.taskId, {
        status: event.success ? 'success' : 'error',
        output: event.result,
        completedAt: new Date().toISOString(),
    });

    // 标记虚拟会话为完成
    const virtualId = activeVirtualSessions.get(event.taskId);
    if (virtualId) {
        const manager = getSessionManager();
        // 更新虚拟会话状态为 idle
        // 30s 后自动从网格移除（或用户手动关闭）
    }
    break;
}
```

#### 3.3.4 MultiSessionGrid 集成

`src/components/Chat/SessionCell.tsx`:

- 虚拟会话 cell 特殊样式：subagent 类型图标（Explore → 🔍, general-purpose → 🤖）
- 运行状态指示器（脉冲动画）
- 完成后显示绿色勾 + 工具调用统计
- 头部显示 `agentType` 标签

`src/components/Chat/AgentRunBlockRenderer.tsx`:

- 新增「在分屏中查看」按钮，点击后跳转到对应虚拟会话 cell
- 如果虚拟会话已存在，显示「查看中」状态

#### 3.3.5 用户控制

`src/stores/viewStore.ts`:

```typescript
// 新增配置项
autoSplitOnSubagent: boolean  // 默认 true
```

`src/components/Chat/MultiWindowMenu.tsx`:

- 新增「自动分屏」开关 toggle

### 3.4 数据流闭环

```
1. 主 Agent 调用 Agent 工具
   → 后端: emit AgentRunStart + ToolCallStart("Agent")
   → 前端: 创建虚拟会话 + 添加到网格

2. Subagent 执行工具
   → 后端: emit ToolCallStart("Grep", parentTaskId=xxx)
   → 前端: 路由到虚拟会话 → 实时显示 Grep 调用

3. Subagent 获取结果
   → 后端: emit ToolCallEnd(parentTaskId=xxx)
   → 前端: 路由到虚拟会话 → 显示工具结果

4. Subagent 完成
   → 后端: emit AgentRunEnd + ToolCallEnd("Agent")
   → 前端: 虚拟会话标记完成 + 主会话 AgentRunBlock 更新
```

## 4. 变更文件清单

### 后端 (Rust) — 3 个文件

| 文件 | 变更 | 复杂度 |
|------|------|--------|
| `src-tauri/src/models/events.rs` | StreamEvent 各变体新增 `parent_tool_use_id: Option<String>` | 低 |
| `src-tauri/src/ai/event_parser.rs` | 新增 subagent 跟踪状态、分流逻辑、AgentRunStart/End 构造 | 中 |
| `src-tauri/src/models/ai_event.rs` | ToolCallStartEvent/ToolCallEndEvent 新增 `parent_task_id` 字段 | 低 |

### 前端 (TypeScript) — 7 个文件

| 文件 | 变更 | 复杂度 |
|------|------|--------|
| `src/ai-runtime/event.ts` | ToolCallStartEvent/EndEvent 新增 `parentTaskId` | 低 |
| `src/stores/conversationStore/types.ts` | SessionMetadata 新增 `isVirtual`/`parentSessionId`/`linkedTaskId`/`agentType` | 低 |
| `src/stores/conversationStore/sessionStoreManager.ts` | 新增 `createVirtualSession()` 方法 | 中 |
| `src/stores/conversationStore/eventHandler.ts` | agent_run_start 创建虚拟会话；tool_call_start 按 parentTaskId 分流 | 中 |
| `src/stores/viewStore.ts` | 新增 `autoSplitOnSubagent` 配置 | 低 |
| `src/components/Chat/SessionCell.tsx` | 虚拟会话 cell 特殊渲染 | 中 |
| `src/components/Chat/AgentRunBlockRenderer.tsx` | 「在分屏中查看」按钮 | 低 |

## 5. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 高频 subagent 导致面板爆炸 | 限制最大分屏数（默认 4），超出自动折叠 |
| 虚拟会话被 LRU 驱逐 | 运行中的虚拟会话标记 `status: 'running'`，LRU 保护 |
| 嵌套 subagent（subagent 再派 subagent） | 支持最多 2 层，更深层级折叠为摘要 |
| `parent_tool_use_id` 为 `None`（Python 写 None 而非 null） | Rust serde 用 `Option<String>`，前端用 `??` 兼容 |
| 事件乱序（subagent 事件晚于 AgentRunEnd 到达） | AgentRunEnd 后设 500ms buffer 窗口 |

## 6. 工作量估算

| 阶段 | 任务 | 预估 |
|------|------|------|
| Phase 1 | 后端 events.rs + ai_event.rs 类型扩展 | 2h |
| Phase 1 | 后端 event_parser.rs subagent 分流 | 4h |
| Phase 1 | 前端 event.ts + types.ts 类型扩展 | 1h |
| Phase 1 | 前端 sessionStoreManager 虚拟会话 | 2h |
| Phase 1 | 前端 eventHandler 路由改造 | 3h |
| Phase 1 | 前端 SessionCell + AgentRunBlock UI | 3h |
| Phase 1 | viewStore 开关 + MultiWindowMenu | 1h |
| Phase 1 | 端到端测试 + 调试 | 3h |
| **合计** | | **~19h (2-3 天)** |

## 7. 执行顺序

```
Step 1: events.rs + ai_event.rs — 类型扩展（后端基础）
Step 2: event_parser.rs — subagent 分流逻辑（后端核心）
Step 3: event.ts + types.ts — 前端类型对齐
Step 4: sessionStoreManager — createVirtualSession
Step 5: eventHandler — parentTaskId 路由
Step 6: SessionCell — 虚拟会话渲染
Step 7: AgentRunBlockRenderer — 分屏查看按钮
Step 8: viewStore + MultiWindowMenu — 开关控制
Step 9: 端到端测试
```
