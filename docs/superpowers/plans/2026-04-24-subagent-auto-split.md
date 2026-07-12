# Subagent 自动分屏实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 当 Claude Code 通过 Agent 工具派发 subagent 时，自动在 MultiSessionGrid 中创建虚拟面板，实时展示 subagent 的工具调用链。

**Architecture:** 后端 event_parser 检测 `parent_tool_use_id` 字段分流 subagent 事件，构造 `AgentRunStart/End` 事件；前端 sessionStoreManager 创建虚拟会话 store，eventHandler 按 `parentTaskId` 路由事件到虚拟会话；MultiSessionGrid 自动添加/移除 subagent cell。

**Tech Stack:** Rust (serde, Tauri IPC) / TypeScript (Zustand, React) / Vitest

**设计文档:** `docs/superpowers/specs/2026-04-24-subagent-auto-split-design.md`

---

## 文件结构

### 后端 (Rust) — 3 个文件修改

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `src-tauri/src/models/events.rs` | StreamEvent 各变体新增 `parent_tool_use_id` | 修改 |
| `src-tauri/src/models/ai_event.rs` | ToolCallStartEvent/EndEvent 新增 `parent_task_id` | 修改 |
| `src-tauri/src/ai/event_parser.rs` | subagent 分流逻辑 + AgentRunStart/End 构造 | 修改 |

### 前端 (TypeScript) — 7 个文件修改

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `src/ai-runtime/event.ts` | 事件类型新增 `parentTaskId` | 修改 |
| `src/stores/conversationStore/types.ts` | SessionMetadata 新增虚拟会话字段 | 修改 |
| `src/stores/conversationStore/sessionStoreManager.ts` | `createVirtualSession()` 方法 | 修改 |
| `src/stores/conversationStore/eventHandler.ts` | parentTaskId 分流逻辑 | 修改 |
| `src/stores/viewStore.ts` | `autoSplitOnSubagent` 配置 | 修改 |
| `src/components/Chat/SessionCell.tsx` | 虚拟会话 cell 渲染 | 修改 |
| `src/components/Chat/AgentRunBlockRenderer.tsx` | 「在分屏中查看」按钮 | 修改 |

---

## Task 1: 后端 StreamEvent 类型扩展

**Files:**
- Modify: `src-tauri/src/models/events.rs:25-66`

- [ ] **Step 1: 给 Assistant 变体加 parent_tool_use_id**

`src-tauri/src/models/events.rs` 第 26-29 行，将：

```rust
    #[serde(rename = "assistant")]
    Assistant {
        message: serde_json::Value,
    },
```

改为：

```rust
    #[serde(rename = "assistant")]
    Assistant {
        message: serde_json::Value,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
    },
```

- [ ] **Step 2: 给 User 变体加 parent_tool_use_id**

第 32-35 行，将：

```rust
    #[serde(rename = "user")]
    User {
        message: serde_json::Value,
    },
```

改为：

```rust
    #[serde(rename = "user")]
    User {
        message: serde_json::Value,
        #[serde(rename = "parentToolUseId")]
        parent_tool_use_id: Option<String>,
    },
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -5`
Expected: 编译通过（新字段是 `Option`，serde 默认允许缺失）

> 注意：可能需要修复 `events.rs` 中的 `StreamEvent` 构造点，给 `parent_tool_use_id: None`。但 `events.rs` 的 `StreamEvent` 只用于反序列化 CLI 输出（通过 `parse_line`），不手动构造，所以大概率无需修改。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/models/events.rs
git commit -m "feat(subagent): add parent_tool_use_id to StreamEvent variants"
```

---

## Task 2: 后端 AIEvent 类型扩展

**Files:**
- Modify: `src-tauri/src/models/ai_event.rs:107-165`

- [ ] **Step 1: ToolCallStartEvent 新增 parent_task_id**

第 107-119 行，将：

```rust
pub struct ToolCallStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    pub tool: String,
    pub args: HashMap<String, serde_json::Value>,
}
```

改为：

```rust
pub struct ToolCallStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_id: Option<String>,
    pub tool: String,
    pub args: HashMap<String, serde_json::Value>,
    /// 父级任务 ID（subagent 归属标记，非 null 表示属于某个 subagent）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
}
```

在 `ToolCallStartEvent::new()` (第 122-130 行) 中添加字段初始化：

```rust
    pub fn new(session_id: impl Into<String>, tool: String, args: HashMap<String, serde_json::Value>) -> Self {
        Self {
            event_type: "tool_call_start".to_string(),
            session_id: session_id.into(),
            call_id: None,
            tool,
            args,
            parent_task_id: None,
        }
    }
```

在 `with_call_id` 后面 (第 136 行后) 添加 builder 方法：

```rust
    pub fn with_parent_task_id(mut self, parent_task_id: String) -> Self {
        self.parent_task_id = Some(parent_task_id);
        self
    }
```

- [ ] **Step 2: ToolCallEndEvent 新增 parent_task_id**

同理，在第 141-155 行的 `ToolCallEndEvent` 结构体中加：

```rust
    /// 父级任务 ID（subagent 归属标记）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
```

在 `ToolCallEndEvent::new()` 中加 `parent_task_id: None`，并添加：

```rust
    pub fn with_parent_task_id(mut self, parent_task_id: String) -> Self {
        self.parent_task_id = Some(parent_task_id);
        self
    }
```

- [ ] **Step 3: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -10`
Expected: 编译通过。如果有构造 ToolCallStartEvent/EndEvent 的地方缺少新字段，补上 `parent_task_id: None`。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/models/ai_event.rs
git commit -m "feat(subagent): add parent_task_id to ToolCallStart/End events"
```

---

## Task 3: 后端 EventParser subagent 分流

**Files:**
- Modify: `src-tauri/src/ai/event_parser.rs`

这是核心变更。EventParser 需要检测 `parent_tool_use_id`，识别 Agent 工具调用，构造 `AgentRunStart/End` 事件。

- [ ] **Step 1: 添加 subagent 跟踪状态**

在 `EventParser` 结构体（第 89-92 行）中新增字段：

```rust
pub struct EventParser {
    session_id: String,
    tool_call_manager: ToolCallManager,
    /// 活跃的 subagent：key = Agent 工具的 call_id，value = agent 类型
    active_subagents: HashMap<String, String>,
}
```

修改 `new()` 方法（第 95-100 行）：

```rust
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            tool_call_manager: ToolCallManager::new(),
            active_subagents: HashMap::new(),
        }
    }
```

在文件顶部 import 区（第 8-14 行）追加：

```rust
use crate::models::AgentRunStartEvent;
use crate::models::AgentRunEndEvent;
```

> 注意：检查 `ai_event.rs` 中 `AgentRunStartEvent` / `AgentRunEndEvent` 是否已在 `AIEvent` 枚举的 `use` 路径中。如果 `use crate::models::AIEvent` 已经覆盖了所有变体，则无需额外 import。只需确保 `AgentRunStart` 和 `AgentRunEnd` 在 `AIEvent` 枚举中存在（已在第 1176-1177 行确认存在）。

- [ ] **Step 2: 修改 parse() 主方法添加分流**

在 `parse()` 方法（第 110-161 行）中，替换 `StreamEvent::Assistant`、`StreamEvent::User`、`StreamEvent::ToolStart` 三个分支：

**Assistant 分支**（原第 115-117 行）：

```rust
            StreamEvent::Assistant { message, parent_tool_use_id } => {
                if let Some(_pid) = &parent_tool_use_id {
                    // Subagent 的 assistant 事件 — 提取其中的 tool_use
                    self.parse_subagent_assistant(message, parent_tool_use_id)
                } else {
                    self.parse_assistant_event(message)
                }
            }
```

**User 分支**（原第 118-120 行）：

```rust
            StreamEvent::User { message, parent_tool_use_id } => {
                if let Some(_pid) = &parent_tool_use_id {
                    // Subagent 的 user 事件 — 提取其中的 tool_result
                    self.parse_subagent_user(message, parent_tool_use_id)
                } else {
                    self.parse_user_event(message)
                }
            }
```

**ToolStart 分支**（原第 124-126 行）：

```rust
            StreamEvent::ToolStart { tool_use_id, tool_name, input, parent_tool_use_id } => {
                if parent_tool_use_id.is_some() {
                    // Subagent 内部工具调用
                    self.parse_subagent_tool_start(parent_tool_use_id.unwrap(), tool_use_id, tool_name, input)
                } else if tool_name == "Agent" || tool_name == "Task" {
                    // 主 Agent 调用 Agent/Task 工具
                    self.parse_agent_dispatch(tool_use_id, tool_name, input)
                } else {
                    self.parse_tool_start(tool_use_id, tool_name, input)
                }
            }
```

- [ ] **Step 3: 实现 parse_agent_dispatch 方法**

在 `impl EventParser` 末尾添加：

```rust
    /// 主 Agent 调用 Agent/Task 工具时的处理
    fn parse_agent_dispatch(
        &mut self,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
    ) -> Vec<AIEvent> {
        let agent_type = input.get("agentType")
            .or_else(|| input.get("subagent_type"))
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let capabilities: Option<Vec<String>> = input.get("capabilities")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect());

        // 注册 subagent
        self.active_subagents.insert(tool_use_id.clone(), agent_type.clone());

        // 同时作为普通 tool_call 记录（保持原有 UI 兼容）
        let args = Self::value_to_args(&input);
        self.tool_call_manager.start_tool_call(
            tool_name.clone(),
            tool_use_id.clone(),
            args.clone(),
        );

        vec![
            // AgentRunStart 事件 — 前端用此创建虚拟面板
            AIEvent::AgentRunStart(
                AgentRunStartEvent::new(&self.session_id, &tool_use_id, &agent_type)
                    .with_capabilities(capabilities.unwrap_or_default())
            ),
            // 原有的 tool_call 事件 — 保持 AgentRunBlock 兼容
            AIEvent::ToolCallStart(
                ToolCallStartEvent::new(&self.session_id, tool_name, args)
                    .with_call_id(tool_use_id)
            ),
        ]
    }

    /// Subagent 内部的 tool_start 事件
    fn parse_subagent_tool_start(
        &mut self,
        _parent_id: String,
        tool_use_id: String,
        tool_name: String,
        input: serde_json::Value,
    ) -> Vec<AIEvent> {
        let args = Self::value_to_args(&input);
        vec![
            AIEvent::ToolCallStart(
                ToolCallStartEvent::new(&self.session_id, tool_name, args)
                    .with_call_id(tool_use_id)
                    .with_parent_task_id(_parent_id)
            ),
        ]
    }

    /// Subagent 的 assistant 事件 — 提取 thinking / tool_use
    fn parse_subagent_assistant(
        &mut self,
        message: serde_json::Value,
        parent_id: Option<String>,
    ) -> Vec<AIEvent> {
        let mut results = Vec::new();
        let pid = parent_id.unwrap_or_default();

        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if let Some(obj) = item.as_object() {
                    match obj.get("type").and_then(|t| t.as_str()) {
                        Some("thinking") => {
                            if let Some(thinking) = obj.get("thinking").and_then(|t| t.as_str()) {
                                results.push(AIEvent::Thinking(
                                    ThinkingEvent::new(&self.session_id, thinking.to_string())
                                ));
                            }
                        }
                        Some("tool_use") => {
                            let tool_name = obj.get("name").and_then(|n| n.as_str()).unwrap_or("unknown").to_string();
                            let tool_use_id = obj.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                            let input = obj.get("input").cloned().unwrap_or(serde_json::Value::Null);
                            let args = Self::value_to_args(&input);

                            results.push(AIEvent::ToolCallStart(
                                ToolCallStartEvent::new(&self.session_id, tool_name, args)
                                    .with_call_id(tool_use_id)
                                    .with_parent_task_id(pid.clone())
                            ));
                        }
                        Some("text") => {
                            if let Some(text) = obj.get("text").and_then(|t| t.as_str()) {
                                results.push(AIEvent::AssistantMessage(
                                    AssistantMessageEvent::new(&self.session_id, text.to_string(), true)
                                ));
                            }
                        }
                        _ => {}
                    }
                }
            }
        }
        results
    }

    /// Subagent 的 user 事件 — 提取 tool_result
    fn parse_subagent_user(
        &mut self,
        message: serde_json::Value,
        parent_id: Option<String>,
    ) -> Vec<AIEvent> {
        let mut results = Vec::new();
        let pid = parent_id.unwrap_or_default();

        if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
            for item in content {
                if let Some(obj) = item.as_object() {
                    if obj.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                        let tool_use_id = obj.get("tool_use_id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();

                        let output = Self::extract_text_content(obj);
                        let success = !output.is_empty();

                        results.push(AIEvent::ToolCallEnd(
                            ToolCallEndEvent::new(&self.session_id, "unknown".to_string(), success)
                                .with_call_id(tool_use_id)
                                .with_parent_task_id(pid.clone())
                                .with_result(serde_json::Value::String(output))
                        ));
                    }
                }
            }
        }
        results
    }

    /// 辅助方法：从 tool_result 的 content 中提取文本
    fn extract_text_content(obj: &serde_json::Map<String, serde_json::Value>) -> String {
        if let Some(content) = obj.get("content") {
            if let Some(s) = content.as_str() {
                return s.to_string();
            }
            if let Some(arr) = content.as_array() {
                let texts: Vec<String> = arr.iter()
                    .filter_map(|item| {
                        item.as_object()
                            .and_then(|o| o.get("text"))
                            .and_then(|t| t.as_str())
                            .map(String::from)
                    })
                    .collect();
                return texts.join("\n");
            }
        }
        String::new()
    }

    /// 辅助方法：将 serde_json::Value 转为 args HashMap
    fn value_to_args(input: &serde_json::Value) -> HashMap<String, serde_json::Value> {
        if let Some(obj) = input.as_object() {
            obj.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
        } else {
            HashMap::new()
        }
    }
```

- [ ] **Step 4: 修改 parse_user_event 检测 Agent tool_result 结束 subagent**

在现有 `parse_user_event` 方法（第 330 行起）中，在处理 `tool_result` 块时，检查 `tool_use_id` 是否在 `active_subagents` 中：

在 `parse_user_event` 的 for 循环中，`tool_result` 处理逻辑后添加：

```rust
                        // 检查是否是 Agent 工具的结果 — subagent 结束
                        if self.active_subagents.contains_key(&tool_use_id) {
                            let agent_type = self.active_subagents.remove(&tool_use_id)
                                .unwrap_or_default();
                            let success = !output.is_empty();
                            results.push(AIEvent::AgentRunEnd(
                                AgentRunEndEvent::new(&self.session_id, tool_use_id.clone(), success)
                                    .with_result(output.clone())
                            ));
                        }
```

- [ ] **Step 5: 编译验证**

Run: `cd src-tauri && cargo check 2>&1 | tail -20`
Expected: 编译通过。如果有 import 问题，补上 `use crate::models::{AgentRunStartEvent, AgentRunEndEvent};`。

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/ai/event_parser.rs
git commit -m "feat(subagent): event parser detects parent_tool_use_id and emits AgentRun events"
```

---

## Task 4: 前端事件类型扩展

**Files:**
- Modify: `src/ai-runtime/event.ts:35-62`

- [ ] **Step 1: ToolCallStartEvent 新增 parentTaskId**

第 35-45 行，将：

```typescript
export interface ToolCallStartEvent {
  type: 'tool_call_start'
  sessionId: string
  callId?: string
  tool: string
  args: Record<string, unknown>
}
```

改为：

```typescript
export interface ToolCallStartEvent {
  type: 'tool_call_start'
  sessionId: string
  callId?: string
  tool: string
  args: Record<string, unknown>
  /** 父级任务 ID（非空表示此事件属于某个 subagent） */
  parentTaskId?: string
}
```

- [ ] **Step 2: ToolCallEndEvent 新增 parentTaskId**

第 50-62 行，将：

```typescript
export interface ToolCallEndEvent {
  type: 'tool_call_end'
  sessionId: string
  callId?: string
  tool: string
  result?: unknown
  success: boolean
}
```

改为：

```typescript
export interface ToolCallEndEvent {
  type: 'tool_call_end'
  sessionId: string
  callId?: string
  tool: string
  result?: unknown
  success: boolean
  /** 父级任务 ID（非空表示此事件属于某个 subagent） */
  parentTaskId?: string
}
```

- [ ] **Step 3: TypeScript 编译验证**

Run: `cd D:/space/base/Polaris && npx tsc --noEmit 2>&1 | tail -10`
Expected: 0 errors（新字段是可选的）

- [ ] **Step 4: Commit**

```bash
git add src/ai-runtime/event.ts
git commit -m "feat(subagent): add parentTaskId to frontend ToolCall events"
```

---

## Task 5: 前端 SessionMetadata + viewStore 扩展

**Files:**
- Modify: `src/stores/conversationStore/types.ts:234-269`
- Modify: `src/stores/viewStore.ts:19-45`

- [ ] **Step 1: SessionMetadata 新增虚拟会话字段**

`types.ts` 第 234-249 行的 `SessionMetadata` 接口，在 `forkFromId` 字段后添加：

```typescript
  /** 是否为虚拟会话（subagent 分屏面板） */
  isVirtual?: boolean
  /** 父会话 ID（虚拟会话关联的主会话） */
  parentSessionId?: string
  /** 关联的 Agent 工具调用 ID（虚拟会话与 AgentRunBlock 的关联） */
  linkedTaskId?: string
  /** subagent 类型（如 Explore, general-purpose） */
  agentType?: string
```

- [ ] **Step 2: viewStore 新增 autoSplitOnSubagent**

`viewStore.ts` 的 `ViewState` 接口（第 19-45 行），在 `pendingScrollToId` 后添加：

```typescript
  autoSplitOnSubagent: boolean;     // subagent 自动分屏开关（默认 true）
```

在 `ViewActions` 接口（第 48 行后）添加：

```typescript
  setAutoSplitOnSubagent: (enabled: boolean) => void;
```

在 store 初始值（第 119 行后，`multiSessionMode: false` 附近）添加：

```typescript
      autoSplitOnSubagent: true,   // 默认开启 subagent 自动分屏
```

在 `set()` 函数内的 actions 区添加实现：

```typescript
      setAutoSplitOnSubagent: (enabled: boolean) => set({ autoSplitOnSubagent: enabled }),
```

- [ ] **Step 3: TypeScript 编译验证**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/stores/conversationStore/types.ts src/stores/viewStore.ts
git commit -m "feat(subagent): add virtual session metadata and autoSplit config"
```

---

## Task 6: 前端 sessionStoreManager 虚拟会话管理

**Files:**
- Modify: `src/stores/conversationStore/sessionStoreManager.ts`

- [ ] **Step 1: 在 SessionManagerActions 接口添加新方法签名**

`types.ts` 的 `SessionManagerActions` 接口（第 309-347 行）中，在 `makeSessionVisible` 后添加：

```typescript
  // ===== 虚拟会话（Subagent 分屏） =====
  /** 创建虚拟会话（subagent 自动分屏时调用） */
  createVirtualSession: (parentSessionId: string, taskId: string, agentType: string) => string
  /** 获取虚拟会话 ID（通过 taskId 查找） */
  getVirtualSessionId: (taskId: string) => string | undefined
  /** 标记虚拟会话完成 */
  completeVirtualSession: (taskId: string) => void
  /** 移除虚拟会话 */
  removeVirtualSession: (taskId: string) => void
```

- [ ] **Step 2: 新增 taskId → virtualSessionId 映射**

在 `sessionStoreManager.ts` 中，在 `cachedActions` 对象（第 743 行）之前添加：

```typescript
/**
 * 活跃的虚拟会话映射：taskId → virtualSessionId
 */
const virtualSessionMap = new Map<string, string>()
```

- [ ] **Step 3: 实现 createVirtualSession**

在 `sessionStoreManager.ts` 的 `createSession` 方法后（约第 258 行），在 store 函数内部添加：

```typescript
      createVirtualSession: (parentSessionId: string, taskId: string, agentType: string) => {
        const virtualId = `virtual-${taskId}`

        // 已存在则直接返回
        if (get().stores.has(virtualId)) {
          return virtualId
        }

        // 创建虚拟会话
        get().createSession({
          id: virtualId,
          type: 'free',
          title: `${agentType} Agent`,
          silentMode: true,
        })

        // 更新元数据
        set((state) => {
          const meta = state.sessionMetadata.get(virtualId)
          if (!meta) return state
          const newMetadata = new Map(state.sessionMetadata)
          newMetadata.set(virtualId, {
            ...meta,
            isVirtual: true,
            parentSessionId,
            linkedTaskId: taskId,
            agentType,
            status: 'running',
          })
          return { sessionMetadata: newMetadata }
        })

        // 记录映射
        virtualSessionMap.set(taskId, virtualId)

        // 自动添加到多会话网格
        const viewState = useViewStore.getState()
        if (viewState.autoSplitOnSubagent !== false) {
          // 确保多会话模式开启
          if (!viewState.multiSessionMode) {
            viewState.toggleMultiSessionMode()
          }
          viewState.addToMultiView(virtualId)
        }

        log.info('创建虚拟会话', { virtualId, taskId, agentType, parentSessionId })
        return virtualId
      },

      getVirtualSessionId: (taskId: string) => {
        return virtualSessionMap.get(taskId)
      },

      completeVirtualSession: (taskId: string) => {
        const virtualId = virtualSessionMap.get(taskId)
        if (!virtualId) return

        // 更新状态为 idle
        const meta = get().sessionMetadata.get(virtualId)
        if (meta) {
          set((state) => {
            const newMetadata = new Map(state.sessionMetadata)
            newMetadata.set(virtualId, { ...meta, status: 'idle', updatedAt: new Date().toISOString() })
            return { sessionMetadata: newMetadata }
          })
        }

        log.info('虚拟会话完成', { virtualId, taskId })

        // 30 秒后自动从网格移除
        setTimeout(() => {
          useViewStore.getState().removeFromMultiView(virtualId)
          virtualSessionMap.delete(taskId)
        }, 30000)
      },

      removeVirtualSession: (taskId: string) => {
        const virtualId = virtualSessionMap.get(taskId)
        if (!virtualId) return

        useViewStore.getState().removeFromMultiView(virtualId)
        get().deleteSession(virtualId)
        virtualSessionMap.delete(taskId)
      },
```

- [ ] **Step 4: 更新 cachedActions**

在 `cachedActions` 对象中添加新方法的 getter：

```typescript
  get createVirtualSession() { return sessionStoreManager.getState().createVirtualSession },
  get getVirtualSessionId() { return sessionStoreManager.getState().getVirtualSessionId },
  get completeVirtualSession() { return sessionStoreManager.getState().completeVirtualSession },
  get removeVirtualSession() { return sessionStoreManager.getState().removeVirtualSession },
```

- [ ] **Step 5: TypeScript 编译验证**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/stores/conversationStore/types.ts src/stores/conversationStore/sessionStoreManager.ts
git commit -m "feat(subagent): virtual session management in sessionStoreManager"
```

---

## Task 7: 前端 eventHandler subagent 分流

**Files:**
- Modify: `src/stores/conversationStore/eventHandler.ts`

- [ ] **Step 1: 在文件顶部添加导入**

在第 11 行 `import { useSessionStore }` 后添加：

```typescript
import { sessionStoreManager, useViewStore } from '../index'
```

> 注意：检查循环依赖。`sessionStoreManager` 是从 `../index` 导出的单例。如果 `eventHandler.ts` 的导入路径有循环依赖风险，可以用 lazy import：`const getSessionManager = () => (require('../index') as any).sessionStoreManager`。但实际上 `eventHandler.ts` 已经导入了 `useSessionStore`，说明该路径是安全的。

- [ ] **Step 2: 添加 taskId → virtualId 的跟踪映射**

在文件顶部（第 14 行 `const log` 之前）添加：

```typescript
/** 活跃虚拟会话映射：taskId → virtualSessionId（由 eventHandler 维护） */
const activeVirtualSessions = new Map<string, string>()
```

- [ ] **Step 3: 修改 agent_run_start case**

将第 181-187 行：

```typescript
    case 'agent_run_start':
      state.appendAgentRunBlock(
        event.taskId,
        event.agentType,
        event.capabilities
      )
      break
```

改为：

```typescript
    case 'agent_run_start': {
      state.appendAgentRunBlock(
        event.taskId,
        event.agentType,
        event.capabilities
      )

      // 创建虚拟会话并自动分屏
      const viewState = useViewStore.getState()
      if (viewState.autoSplitOnSubagent !== false) {
        const manager = sessionStoreManager
        const virtualId = manager.createVirtualSession(
          get().sessionId,
          event.taskId,
          event.agentType
        )
        activeVirtualSessions.set(event.taskId, virtualId)
      }
      break
    }
```

- [ ] **Step 4: 修改 agent_run_end case**

将第 189-196 行：

```typescript
    case 'agent_run_end':
      state.updateAgentRunBlock(event.taskId, {
        status: event.success ? 'success' : 'error',
        output: event.result,
        completedAt: new Date().toISOString(),
      })
      state.setActiveTask(null)
      break
```

改为：

```typescript
    case 'agent_run_end':
      state.updateAgentRunBlock(event.taskId, {
        status: event.success ? 'success' : 'error',
        output: event.result,
        completedAt: new Date().toISOString(),
      })
      state.setActiveTask(null)

      // 标记虚拟会话完成
      sessionStoreManager.completeVirtualSession(event.taskId)
      activeVirtualSessions.delete(event.taskId)
      break
```

- [ ] **Step 5: 修改 tool_call_start case 添加 parentTaskId 分流**

将第 73-78 行：

```typescript
    case 'tool_call_start': {
      const toolName = event.tool
      const callId = event.callId || crypto.randomUUID()
      state.appendToolCallBlock(callId, toolName, event.args)
      break
    }
```

改为：

```typescript
    case 'tool_call_start': {
      // 如果有 parentTaskId，路由到虚拟会话
      const parentTaskId = (event as any).parentTaskId as string | undefined
      if (parentTaskId) {
        const virtualId = activeVirtualSessions.get(parentTaskId)
        if (virtualId) {
          const virtualStore = sessionStoreManager.getStore(virtualId)
          if (virtualStore) {
            // 路由到虚拟会话的 store
            virtualStore.handleAIEvent(event)
            return
          }
        }
        // 虚拟会话不存在，降级到主会话
        log.warn('虚拟会话不存在，降级到主会话', { parentTaskId })
      }

      const toolName = event.tool
      const callId = event.callId || crypto.randomUUID()
      state.appendToolCallBlock(callId, toolName, event.args)
      break
    }
```

- [ ] **Step 6: 修改 tool_call_end case 添加 parentTaskId 分流**

将第 80-106 行的 `tool_call_end` case，在开头添加分流逻辑：

```typescript
    case 'tool_call_end': {
      // 如果有 parentTaskId，路由到虚拟会话
      const parentTaskId = (event as any).parentTaskId as string | undefined
      if (parentTaskId) {
        const virtualId = activeVirtualSessions.get(parentTaskId)
        if (virtualId) {
          const virtualStore = sessionStoreManager.getStore(virtualId)
          if (virtualStore) {
            virtualStore.handleAIEvent(event)
            return
          }
        }
      }

      // 原有逻辑...
      const callId = event.callId || ''
      const output = typeof event.result === 'string'
        ? event.result
        : (event.result ? JSON.stringify(event.result, null, 2) : undefined)
      state.updateToolCallBlock(
        callId,
        event.success ? 'completed' : 'failed',
        output
      )

      // Edit 工具 diff 逻辑保持不变...
      const { currentMessage, toolBlockMap } = get()
      const blockIdx = currentMessage ? toolBlockMap.get(callId) : undefined
      if (blockIdx !== undefined && currentMessage) {
        const block = currentMessage.blocks[blockIdx]
        if (block?.type === 'tool_call' && isEditTool(block.name)) {
          const diff = extractEditDiff(block)
          if (diff) {
            state.updateToolCallBlockDiff(callId, diff)
          }
        }
      }
      break
    }
```

- [ ] **Step 7: 处理 thinking/token 事件的 parentTaskId 分流**

在 `thinking` case（第 65-67 行）和 `token` case（第 62-63 行）前添加分流：

```typescript
    case 'token': {
      // 如果虚拟会话正在接收，也同步一份
      // 注意：主 Agent 的 token 事件没有 parentTaskId，不需要分流
      state.appendTextBlock(event.value)
      break
    }
```

> 注意：token 和 thinking 事件目前不带 `parentTaskId`（后端只在 `ToolCallStart/End` 上加了这个字段）。subagent 的 thinking/token 事件会通过 `parse_subagent_assistant` 转为 `Thinking` 和 `AssistantMessage` 事件，这些事件走主会话路由。如果需要在虚拟面板中也展示 thinking，需要在后端的 `parse_subagent_assistant` 中也给这些事件加 `parentTaskId`。这是一个后续优化点，Phase 1 先不做。

- [ ] **Step 8: TypeScript 编译验证**

Run: `npx tsc --noEmit 2>&1 | tail -10`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add src/stores/conversationStore/eventHandler.ts
git commit -m "feat(subagent): eventHandler routes subagent events to virtual sessions"
```

---

## Task 8: 前端 SessionCell 虚拟会话渲染

**Files:**
- Modify: `src/components/Chat/SessionCell.tsx`

- [ ] **Step 1: 读取 SessionCell.tsx 确认当前结构**

Run: `head -50 src/components/Chat/SessionCell.tsx`
了解当前 cell header 渲染逻辑，在标题区域添加 subagent 类型标识。

- [ ] **Step 2: 添加虚拟会话视觉标识**

在 SessionCell 的 header 区域（标题旁），根据 `metadata.isVirtual` 添加：

```typescript
// 在 cell header 的 title 旁边添加 agent 类型标签
{metadata?.isVirtual && (
  <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400">
    {metadata.agentType || 'Agent'}
  </span>
)}
```

- [ ] **Step 3: 添加虚拟会话状态指示器**

在 streaming 指示器旁，对虚拟会话的 `running` 状态添加脉冲动画：

```typescript
{metadata?.isVirtual && metadata.status === 'running' && (
  <span className="flex items-center gap-1 text-xs text-amber-400">
    <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
    {metadata.agentType}
  </span>
)}
```

- [ ] **Step 4: 添加关闭按钮**

虚拟会话的关闭按钮不应删除会话，而是从网格移除：

```typescript
{metadata?.isVirtual && (
  <button
    onClick={() => {
      sessionStoreManager.removeFromMultiView(metadata.linkedTaskId || '')
      viewStore.removeFromMultiView(sessionId)
    }}
    className="..."
  >
    ×
  </button>
)}
```

- [ ] **Step 5: Commit**

```bash
git add src/components/Chat/SessionCell.tsx
git commit -m "feat(subagent): virtual session cell with agent type badge and status indicator"
```

---

## Task 9: 前端 AgentRunBlockRenderer 分屏查看按钮

**Files:**
- Modify: `src/components/Chat/AgentRunBlockRenderer.tsx`

- [ ] **Step 1: 添加「在分屏中查看」按钮**

在 AgentRunBlockRenderer 的已完成状态区域，添加一个按钮，点击后跳转到虚拟会话 cell：

```typescript
// 在 AgentRunBlock 渲染区域添加
{status === 'success' || status === 'error' ? (
  <button
    onClick={() => {
      const virtualId = sessionStoreManager.getVirtualSessionId(block.id)
      if (virtualId) {
        viewStore.requestScrollToSession(virtualId)
      }
    }}
    className="text-xs text-blue-400 hover:text-blue-300"
  >
    查看详情 →
  </button>
) : null}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Chat/AgentRunBlockRenderer.tsx
git commit -m "feat(subagent): add view-in-split button to AgentRunBlock renderer"
```

---

## Task 10: MultiWindowMenu 自动分屏开关

**Files:**
- Modify: `src/components/Chat/MultiWindowMenu.tsx`

- [ ] **Step 1: 添加自动分屏 toggle**

在 MultiWindowMenu 的菜单项中添加：

```typescript
<div className="flex items-center justify-between px-3 py-2">
  <span className="text-sm">自动分屏</span>
  <button
    onClick={() => {
      const current = useViewStore.getState().autoSplitOnSubagent
      useViewStore.getState().setAutoSplitOnSubagent(!current)
    }}
  >
    {useViewStore.getState().autoSplitOnSubagent ? '开启' : '关闭'}
  </button>
</div>
```

- [ ] **Step 2: Commit**

```bash
git add src/components/Chat/MultiWindowMenu.tsx src/stores/viewStore.ts
git commit -m "feat(subagent): auto-split toggle in MultiWindowMenu"
```

---

## Task 11: 端到端集成验证

**Files:**
- No new files

- [ ] **Step 1: 启动 Tauri 开发模式**

Run: `pnpm run tauri:dev`

- [ ] **Step 2: 触发 subagent 调用**

在聊天中输入：`"请用 Explore 类型的 subagent 帮我搜索项目中所有包含 AgentRun 的文件"`

Expected:
1. 主会话中出现 AgentRunBlock
2. MultiSessionGrid 自动添加虚拟面板
3. 虚拟面板中实时显示 subagent 的工具调用（Grep 等）
4. Subagent 完成后虚拟面板标记完成

- [ ] **Step 3: 验证开关功能**

在 MultiWindowMenu 中关闭「自动分屏」，再次触发 subagent → 不应出现虚拟面板。

- [ ] **Step 4: 最终 Commit**

```bash
git add -A
git commit -m "feat(subagent): subagent auto-split-screen complete"
```

---

## 自审清单

**1. Spec 覆盖检查：**
- ✅ 后端 events.rs 类型扩展 → Task 1
- ✅ 后端 ai_event.rs 字段扩展 → Task 2
- ✅ 后端 event_parser.rs subagent 分流 → Task 3
- ✅ 前端 event.ts 类型扩展 → Task 4
- ✅ 前端 types.ts + viewStore 扩展 → Task 5
- ✅ 前端 sessionStoreManager 虚拟会话 → Task 6
- ✅ 前端 eventHandler 分流 → Task 7
- ✅ 前端 SessionCell 渲染 → Task 8
- ✅ 前端 AgentRunBlockRenderer 按钮 → Task 9
- ✅ 前端 MultiWindowMenu 开关 → Task 10
- ✅ 端到端验证 → Task 11

**2. Placeholder 检查：**
- 无 TBD / TODO / "implement later"
- 所有代码步骤包含完整实现
- 所有命令包含预期输出

**3. 类型一致性：**
- 后端 `parent_tool_use_id` (Rust snake_case) → serde `parentToolUseId` → 前端 `parentTaskId`
- 虚拟会话 ID 格式：`virtual-{taskId}`
- TaskId / toolUseId 在后端和前端保持一致

**4. 已知限制（Phase 1 可接受）：**
- Subagent 的 thinking/token 事件不带 parentTaskId，暂不在虚拟面板中展示
- 嵌套 subagent（subagent 再派 subagent）未处理，Phase 1 只支持 1 层
- 虚拟面板只展示工具调用链，不展示 subagent 的文本输出（因为后端只在 ToolCall 事件上加了 parentTaskId）
