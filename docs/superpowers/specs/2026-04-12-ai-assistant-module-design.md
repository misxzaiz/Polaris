# AI 助手模块设计规格

## 概述

在 Polaris 内新增一个 AI 助手模块，作为用户与 Claude Code 之间的智能协调层。助手只有一个工具——调用 Claude Code，由助手自主判断何时需要调用。

**核心特性**：支持助手同时管理多个 Claude Code 会话，实现主对话与分析任务的并行执行。

## 核心定位

| 角色 | 职责 |
|------|------|
| **用户** | 发出需求、做决策 |
| **AI 助手** | 理解意图、润色输入、规划方案、自主判断何时调用 Claude Code，管理多个 Claude Code 会话 |
| **Claude Code** | 执行具体的项目操作（代码修改、文件读写等），支持多会话并行 |

## 多会话管理架构

### 设计理念

助手可以同时管理多个 Claude Code 会话，每个会话有独立的上下文和生命周期：

```
┌─────────────────────────────────────────────────────────────────┐
│                        AI 助手                                   │
├─────────────────────────────────────────────────────────────────┤
│  主对话会话 (primary)    │  分析会话 #1    │  分析会话 #2        │
│  ┌───────────────────┐  │ ┌─────────────┐ │ ┌─────────────┐    │
│  │ sessionId: main   │  │ │ sessionId:  │ │ │ sessionId:  │    │
│  │ 状态: running     │  │ │ analyze-1   │ │ │ analyze-2   │    │
│  │ 任务: 重构认证模块 │  │ │ 状态: idle  │ │ │ 状态: running│   │
│  └───────────────────┘  │ └─────────────┘ │ └─────────────┘    │
│                         │ 任务: 分析依赖 │ │ 任务: 检查安全│   │
└─────────────────────────────────────────────────────────────────┘
```

### 会话类型定义

| 类型 | 用途 | 生命周期 |
|------|------|----------|
| **primary** | 主对话会话，保持长期上下文 | 与助手对话生命周期一致 |
| **analysis** | 分析任务会话，短期独立任务 | 任务完成后可回收 |
| **background** | 后台任务会话 | 完成后通知助手 |

## 模块架构

```
src/
├── engines/
│   └── openai-protocol/          # OpenAI 协议适配器（新增）
│       ├── engine.ts             # 实现 AIEngine 接口
│       ├── session.ts            # 会话管理
│       ├── types.ts              # OpenAI API 类型定义
│       ├── config.ts             # 配置验证
│       └── index.ts
│
├── assistant/                    # AI 助手模块（新增）
│   ├── core/
│   │   ├── AssistantEngine.ts    # 助手引擎，协调 LLM 和 Claude Code
│   │   ├── SystemPrompt.ts       # 系统提示词
│   │   └── ToolDefinitions.ts    # 工具定义（invoke_claude_code）
│   ├── store/
│   │   └── assistantStore.ts     # 助手状态管理
│   ├── components/
│   │   ├── AssistantPanel.tsx    # 助手面板（主界面）
│   │   ├── AssistantChat.tsx     # 对话消息流
│   │   ├── ClaudeCodeCard.tsx    # Claude Code 执行卡片
│   │   ├── ExecutionStatus.tsx   # 执行状态指示器
│   │   └── AssistantInput.tsx    # 输入框
│   ├── hooks/
│   │   └── useAssistant.ts       # 助手交互 Hook
│   ├── types/
│   │   └── index.ts              # 类型定义
│   └── utils/
│       └── promptBuilder.ts      # 提示词构建
│
├── components/Layout/
│   └── ActivityBar.tsx           # 修改：添加助手图标
│
└── types/
    └── config.ts                 # 修改：添加助手配置类型
```

## 核心组件设计

### 1. OpenAI 协议适配器

#### engine.ts

```typescript
export interface OpenAIEngineConfig {
  /** API Base URL（支持自定义服务商） */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 模型 ID */
  model: string
  /** 最大 Token 数 */
  maxTokens?: number
  /** 温度参数 */
  temperature?: number
}

export class OpenAIProtocolEngine implements AIEngine {
  readonly id = 'openai-protocol'
  readonly name = 'OpenAI Protocol'

  // 实现流式输出
  async *stream(messages: Message[], tools?: Tool[]): AsyncGenerator<AIEvent>

  // 工具调用处理
  async handleToolCall(toolCall: ToolCall): Promise<ToolResult>
}
```

#### types.ts

```typescript
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: object
  }
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}
```

### 2. AI 助手核心

#### AssistantEngine.ts

```typescript
export class AssistantEngine {
  private llmEngine: OpenAIProtocolEngine
  private claudeCodeEngine: ClaudeCodeEngine
  private eventBus: EventBus

  /**
   * 处理用户消息
   * 1. 发送给 LLM
   * 2. 判断是否需要调用工具
   * 3. 执行工具调用（如有）
   * 4. 返回结果给用户
   */
  async *processMessage(
    message: string,
    context?: AssistantContext
  ): AsyncGenerator<AssistantEvent>

  /**
   * 执行 Claude Code 调用
   */
  async *executeClaudeCode(
    params: InvokeClaudeCodeParams
  ): AsyncGenerator<ClaudeCodeExecutionEvent>

  /**
   * 中断当前执行
   */
  abort(): void
}
```

#### ToolDefinitions.ts

```typescript
export const INVOKE_CLAUDE_CODE_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'invoke_claude_code',
    description: `
调用 Claude Code 执行项目操作。支持管理多个独立会话。

何时使用：
- 需要读取/修改项目文件
- 需要了解项目结构或代码
- 需要执行代码重构或调试
- 需要进行 Git 操作

何时不需要：
- 用户只是闲聊或咨询概念
- 可以直接回答的技术问题
- 不涉及具体项目的规划讨论

多会话管理：
- 使用 sessionId 参数指定目标会话
- primary 会话保持主对话上下文
- 可创建独立的分析会话并行执行任务
    `.trim(),
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '发送给 Claude Code 的指令'
        },
        sessionId: {
          type: 'string',
          description: `目标会话 ID。可选值：
- 'primary': 主对话会话（默认），保持长期上下文
- 'new-{purpose}': 创建新的分析会话，如 'new-analysis'、'new-security-check'
- 已有会话 ID: 继续该会话的任务`
        },
        mode: {
          type: 'string',
          enum: ['continue', 'new', 'interrupt'],
          description: '执行模式：continue=继续会话, new=创建新会话, interrupt=中断指定会话'
        },
        reason: {
          type: 'string',
          description: '简要说明为什么需要调用 Claude Code'
        },
        background: {
          type: 'boolean',
          description: '是否在后台执行（不阻塞用户对话）'
        }
      },
      required: ['prompt', 'reason']
    }
  }
}
```

#### SystemPrompt.ts（更新版）

```typescript
export const ASSISTANT_SYSTEM_PROMPT = `
# 角色定义

你是用户的 AI 助手，负责帮助用户分析需求、规划方案、协调资源。
你有一个工具：\`invoke_claude_code\`，可以调用 Claude Code 执行项目操作。

# 多会话管理能力

你可以同时管理多个 Claude Code 会话：

## 会话类型

1. **primary（主会话）**：
   - 保持与用户的长期对话上下文
   - 用于主要开发任务
   - 默认会话，不指定 sessionId 时自动使用

2. **analysis（分析会话）**：
   - 独立的短期任务
   - 不影响主会话上下文
   - 适合：代码分析、依赖检查、安全扫描等

## 使用场景

### 场景 1：主任务执行
用户："重构认证模块"
→ 使用 primary 会话，保持上下文连续性

### 场景 2：并行分析
用户："重构认证模块，同时检查有没有安全问题"
→ primary 会话：执行重构
→ 新建 analysis 会话：并行安全检查
→ 两个任务独立执行，互不干扰

### 场景 3：后台任务
用户："帮我分析整个项目的依赖关系，我继续和你聊天"
→ 创建后台 analysis 会话执行依赖分析
→ 用户可以继续与你对话
→ 分析完成后你主动汇报结果

# 工作原则

1. **先理解再行动**：充分理解用户意图后，再决定是否需要调用工具
2. **透明沟通**：调用工具前告知用户你的计划和原因
3. **主动汇报**：工具执行完成后，主动总结结果并询问下一步
4. **保持对话**：Claude Code 执行期间，用户可以继续和你对话
5. **会话隔离**：分析任务使用独立会话，不影响主对话上下文

# 判断逻辑

## 不需要调用 Claude Code 的情况
- 用户只是咨询概念、方法论
- 可以直接回答的技术问题
- 纯粹的需求讨论和规划
- 代码逻辑解释（不需要读取实际文件）

## 需要调用 Claude Code 的情况
- 需要了解项目具体代码结构
- 需要修改项目文件
- 需要执行 Git 操作
- 需要调试或分析具体问题
- 用户明确要求操作项目

# 调用模式选择

- **continue**: 继续指定会话（默认 primary）
- **new**: 创建新会话执行独立任务
- **interrupt**: 中断指定会话

# 输出格式

1. 调用工具前，用简洁语言说明你要做什么
2. 工具执行中，等待结果（后台任务可继续对话）
3. 收到结果后，总结关键信息，提出下一步建议
`
```

### 3. 状态管理

#### assistantStore.ts（支持多会话）

```typescript
/** Claude Code 会话状态 */
export interface ClaudeCodeSessionState {
  /** 会话 ID */
  id: string
  /** 会话类型 */
  type: 'primary' | 'analysis' | 'background'
  /** 会话状态 */
  status: 'idle' | 'running' | 'completed' | 'error'
  /** 显示名称 */
  label: string
  /** 创建时间 */
  createdAt: number
  /** 最后活动时间 */
  lastActiveAt: number
  /** 执行事件列表 */
  events: ClaudeCodeExecutionEvent[]
  /** 关联的工具调用 ID */
  toolCallId?: string
}

export interface AssistantState {
  // 会话状态
  messages: AssistantMessage[]
  isLoading: boolean

  // 多 Claude Code 会话管理
  claudeCodeSessions: Map<string, ClaudeCodeSessionState>
  /** 主会话 ID（固定为 'primary'） */
  primarySessionId: 'primary'
  /** 当前活跃的会话 ID（用于 UI 聚焦） */
  activeClaudeCodeSessionId: string | null

  // 当前工具调用
  pendingToolCall: ToolCall | null

  // 折叠状态
  executionPanelExpanded: boolean
  /** 执行面板当前显示的会话 ID */
  executionPanelSessionId: string | null
}

export interface AssistantActions {
  // 消息操作
  sendMessage: (content: string) => Promise<void>
  clearMessages: () => void

  // Claude Code 会话管理
  createClaudeCodeSession: (type: 'primary' | 'analysis' | 'background', label?: string) => string
  getClaudeCodeSession: (sessionId: string) => ClaudeCodeSessionState | undefined
  getAllClaudeCodeSessions: () => ClaudeCodeSessionState[]
  getRunningSessions: () => ClaudeCodeSessionState[]

  // Claude Code 控制
  executeInSession: (sessionId: string, params: InvokeClaudeCodeParams) => Promise<void>
  abortSession: (sessionId: string) => void
  abortAllSessions: () => void

  // UI 控制
  toggleExecutionPanel: () => void
  setExecutionPanelSession: (sessionId: string | null) => void

  // 事件处理
  handleClaudeCodeEvent: (sessionId: string, event: ClaudeCodeExecutionEvent) => void
}

export type AssistantStore = AssistantState & AssistantActions
```

#### ClaudeCodeSessionManager.ts

```typescript
/**
 * Claude Code 会话管理器
 *
 * 负责：
 * 1. 创建和管理多个 Claude Code 会话
 * 2. 复用现有 SessionStoreManager 架构
 * 3. 事件路由到正确的会话
 */
export class ClaudeCodeSessionManager {
  private sessionStoreManager: SessionStoreManager

  /**
   * 创建新的 Claude Code 会话
   *
   * @param type 会话类型
   * @param label 显示标签
   * @returns 会话 ID
   */
  createSession(type: 'primary' | 'analysis' | 'background', label?: string): string {
    const sessionId = type === 'primary' ? 'primary' : `${type}-${Date.now()}`

    // 复用现有 SessionStoreManager 创建会话
    // silentMode: background 类型使用静默模式
    this.sessionStoreManager.createSession({
      id: sessionId,
      type: 'free',
      title: label || `${type} 会话`,
      silentMode: type === 'background'
    })

    return sessionId
  }

  /**
   * 获取会话状态
   */
  getSession(sessionId: string): ConversationStore | undefined {
    return this.sessionStoreManager.getStore(sessionId)
  }

  /**
   * 在指定会话中执行任务
   */
  async executeInSession(
    sessionId: string,
    prompt: string,
    workspacePath?: string
  ): Promise<void> {
    const store = this.getSession(sessionId)
    if (!store) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    await store.getState().sendMessage(prompt, workspacePath)
  }

  /**
   * 中断指定会话
   */
  async abortSession(sessionId: string): Promise<void> {
    await this.sessionStoreManager.interruptSession(sessionId)
  }

  /**
   * 获取所有运行中的会话
   */
  getRunningSessions(): string[] {
    return this.sessionStoreManager.getState().getStreamingSessions()
  }
}
```

### 4. UI 组件（支持多会话）

#### AssistantPanel.tsx

```typescript
export function AssistantPanel() {
  return (
    <div className="flex flex-col h-full">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-medium">AI 助手</h2>
        <ClaudeCodeSessionIndicator />
      </div>

      {/* 对话消息流 */}
      <AssistantChat />

      {/* Claude Code 多会话面板 */}
      <ClaudeCodeSessionPanel />

      {/* 输入框 */}
      <AssistantInput />
    </div>
  )
}
```

#### ClaudeCodeSessionPanel.tsx（多会话管理）

```typescript
export function ClaudeCodeSessionPanel() {
  const { claudeCodeSessions, executionPanelExpanded, executionPanelSessionId } = useAssistantStore()
  const [isCollapsed, setIsCollapsed] = useState(false)

  const sessions = Array.from(claudeCodeSessions.values())
  const runningSessions = sessions.filter(s => s.status === 'running')

  if (sessions.length === 0) return null

  return (
    <div className={cn(
      "border-t border-border transition-all",
      isCollapsed ? "h-10" : "h-64"
    )}>
      {/* 会话标签栏 */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 overflow-x-auto">
        {sessions.map(session => (
          <SessionTab
            key={session.id}
            session={session}
            isActive={executionPanelSessionId === session.id}
            onClick={() => setExecutionPanelSession(session.id)}
          />
        ))}
      </div>

      {/* 当前会话内容 */}
      {!isCollapsed && executionPanelSessionId && (
        <div className="px-4 py-2 overflow-auto h-[calc(100%-60px)]">
          <SessionContent sessionId={executionPanelSessionId} />
        </div>
      )}

      {/* 折叠状态栏 */}
      {isCollapsed && (
        <div
          className="flex items-center justify-between px-4 py-2 cursor-pointer"
          onClick={() => setIsCollapsed(false)}
        >
          <div className="flex items-center gap-2">
            {runningSessions.length > 0 && (
              <Loader2 className="w-4 h-4 animate-spin text-primary" />
            )}
            <span className="text-sm text-text-muted">
              {runningSessions.length > 0
                ? `${runningSessions.length} 个会话运行中...`
                : '无运行中的会话'}
            </span>
          </div>
          <ChevronUp className="w-4 h-4" />
        </div>
      )}
    </div>
  )
}

/** 会话标签 */
function SessionTab({ session, isActive, onClick }: SessionTabProps) {
  return (
    <button
      className={cn(
        "flex items-center gap-1 px-2 py-1 rounded text-xs",
        isActive ? "bg-primary/20 text-primary" : "text-text-muted hover:bg-surface-elevated"
      )}
      onClick={onClick}
    >
      {/* 状态图标 */}
      {session.status === 'running' && (
        <Loader2 className="w-3 h-3 animate-spin" />
      )}
      {session.status === 'completed' && (
        <CheckCircle className="w-3 h-3 text-success" />
      )}
      {session.status === 'error' && (
        <XCircle className="w-3 h-3 text-danger" />
      )}

      {/* 标签 */}
      <span>{session.label}</span>

      {/* 类型标记 */}
      {session.type === 'primary' && (
        <span className="text-[10px] text-text-faint">主</span>
      )}
      {session.type === 'background' && (
        <span className="text-[10px] text-text-faint">后台</span>
      )}
    </button>
  )
}
```

#### ClaudeCodeCard.tsx（单会话视图）

```typescript
export function ClaudeCodeCard() {
  const { claudeCodeStatus, claudeCodeEvents, executionPanelExpanded } = useAssistantStore()
  const [isCollapsed, setIsCollapsed] = useState(false)

  if (claudeCodeStatus === 'idle') return null

  return (
    <div className={cn(
      "border-t border-border transition-all",
      isCollapsed ? "h-10" : "h-48"
    )}>
      {/* 状态栏 */}
      <div
        className="flex items-center justify-between px-4 py-2 cursor-pointer"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          {claudeCodeStatus === 'running' && (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          )}
          {claudeCodeStatus === 'completed' && (
            <CheckCircle className="w-4 h-4 text-success" />
          )}
          {claudeCodeStatus === 'error' && (
            <XCircle className="w-4 h-4 text-danger" />
          )}
          <span className="text-sm">
            {claudeCodeStatus === 'running' ? 'Claude Code 执行中...' :
             claudeCodeStatus === 'completed' ? '执行完成' : '执行失败'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {claudeCodeStatus === 'running' && (
            <Button size="sm" variant="ghost" onClick={handleAbort}>
              中断
            </Button>
          )}
          {isCollapsed ? <ChevronUp /> : <ChevronDown />}
        </div>
      </div>

      {/* 执行详情 */}
      {!isCollapsed && (
        <div className="px-4 py-2 overflow-auto h-[calc(100%-40px)]">
          {claudeCodeEvents.map((event, idx) => (
            <ExecutionEventItem key={idx} event={event} />
          ))}
        </div>
      )}
    </div>
  )
}
```

### 5. 类型定义

#### types/index.ts（支持多会话）

```typescript
/** 助手消息 */
export interface AssistantMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: number

  // 工具调用信息
  toolCalls?: ToolCallInfo[]
  toolResults?: ToolResultInfo[]
}

/** 工具调用信息 */
export interface ToolCallInfo {
  id: string
  name: string
  arguments: InvokeClaudeCodeParams
  status: 'pending' | 'running' | 'completed' | 'error'
  /** 关联的 Claude Code 会话 ID */
  claudeCodeSessionId?: string
}

/** 工具执行结果 */
export interface ToolResultInfo {
  toolCallId: string
  result: string
  success: boolean
  /** 来源会话 ID */
  sessionId?: string
}

/** Claude Code 调用参数（支持多会话） */
export interface InvokeClaudeCodeParams {
  prompt: string
  /** 目标会话 ID：
   * - 'primary': 主会话（默认）
   * - 'new-{purpose}': 创建新会话
   * - 已有 ID: 继续该会话
   */
  sessionId?: string
  /** 执行模式 */
  mode: 'continue' | 'new' | 'interrupt'
  reason?: string
  /** 是否后台执行 */
  background?: boolean
}

/** Claude Code 会话类型 */
export type ClaudeCodeSessionType = 'primary' | 'analysis' | 'background'

/** Claude Code 执行事件 */
export interface ClaudeCodeExecutionEvent {
  type: 'tool_call' | 'token' | 'progress' | 'error' | 'complete' | 'session_end'
  timestamp: number
  /** 所属会话 ID */
  sessionId: string
  data: {
    tool?: string
    content?: string
    message?: string
    error?: string
  }
}

/** 助手事件 */
export type AssistantEvent =
  | { type: 'message_start' }
  | { type: 'content_delta'; content: string }
  | { type: 'tool_call'; toolCall: ToolCallInfo }
  | { type: 'tool_result'; result: ToolResultInfo }
  | { type: 'message_complete' }
  | { type: 'claude_code_event'; sessionId: string; event: ClaudeCodeExecutionEvent }
  | { type: 'session_created'; session: ClaudeCodeSessionState }
  | { type: 'session_completed'; sessionId: string; success: boolean }
```

### 6. AssistantEngine 核心逻辑

```typescript
export class AssistantEngine {
  private llmEngine: OpenAIProtocolEngine
  private sessionManager: ClaudeCodeSessionManager
  private eventBus: EventBus

  /**
   * 处理工具调用 - invoke_claude_code
   */
  async handleToolCall(toolCall: ToolCallInfo): AsyncGenerator<AssistantEvent> {
    const params = toolCall.arguments as InvokeClaudeCodeParams

    // 解析会话 ID
    let sessionId = params.sessionId || 'primary'

    // 创建新会话
    if (params.mode === 'new' || sessionId.startsWith('new-')) {
      const purpose = sessionId.replace('new-', '') || 'analysis'
      sessionId = this.sessionManager.createSession(
        params.background ? 'background' : 'analysis',
        purpose
      )
      yield { type: 'session_created', session: this.getSessionState(sessionId)! }
    }

    // 中断指定会话
    if (params.mode === 'interrupt') {
      await this.sessionManager.abortSession(sessionId)
      return
    }

    // 执行任务
    yield { type: 'tool_call', toolCall: { ...toolCall, status: 'running', claudeCodeSessionId: sessionId } }

    try {
      // 发送消息到 Claude Code 会话
      await this.sessionManager.executeInSession(
        sessionId,
        params.prompt
      )

      // 等待会话完成（或后台执行时立即返回）
      if (!params.background) {
        yield* this.waitForSessionCompletion(sessionId, toolCall.id)
      }

      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'completed', claudeCodeSessionId: sessionId } }
    } catch (error) {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 等待会话完成
   */
  private async *waitForSessionCompletion(
    sessionId: string,
    toolCallId: string
  ): AsyncGenerator<AssistantEvent> {
    return new Promise((resolve) => {
      const unsubscribe = this.eventBus.subscribe((event: AIEvent) => {
        if (event.type === 'session_end' && event.sessionId === sessionId) {
          unsubscribe()
          resolve()
        }
      })
    })
  }

  /**
   * 获取会话状态
   */
  private getSessionState(sessionId: string): ClaudeCodeSessionState | undefined {
    // 从 sessionManager 获取状态
    return this.sessionManager.getSession(sessionId)?.getState()
  }
}
```

## 数据流设计（支持多会话）

```
用户输入
    │
    ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AssistantStore                             │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ sendMessage(content)                                       │  │
│  └──────────────────────────┬────────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                       AssistantEngine                            │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ 1. 构建消息（含系统提示词）                                 │  │
│  │ 2. 调用 OpenAI Protocol Engine                            │  │
│  │ 3. 流式接收响应                                            │  │
│  └──────────────────────────┬────────────────────────────────┘  │
│                             │                                    │
│            ┌────────────────┴────────────────┐                   │
│            │                                 │                   │
│            ▼                                 ▼                   │
│      直接回复                      检测到工具调用                │
│            │                                 │                   │
│            │                                 ▼                   │
│            │                    ┌────────────────────────┐      │
│            │                    │ 解析 sessionId/mode    │      │
│            │                    └───────────┬────────────┘      │
│            │                                │                    │
│            │              ┌─────────────────┼─────────────────┐  │
│            │              │                 │                 │  │
│            │              ▼                 ▼                 ▼  │
│            │        continue           new               interrupt│
│            │        primary            analysis           指定ID │
│            │              │                 │                 │  │
│            │              ▼                 ▼                 │  │
│            │   ┌──────────────────────────────────────────────┐ │  │
│            │   │          ClaudeCodeSessionManager            │ │  │
│            │   │  ┌─────────────┐ ┌─────────────┐            │ │  │
│            │   │  │ primary     │ │ analysis-1  │ ...        │ │  │
│            │   │  │ sessionId   │ │ sessionId   │            │ │  │
│            │   │  └──────┬──────┘ └──────┬──────┘            │ │  │
│            │   └─────────┼───────────────┼───────────────────┘ │  │
│            │             │               │                     │  │
│            │             ▼               ▼                     │  │
│            │   ┌──────────────────────────────────────────────┐ │  │
│            │   │          SessionStoreManager（复用）          │ │  │
│            │   │  管理多个 ConversationStore 实例             │ │  │
│            │   │  支持后台运行、事件路由                       │ │  │
│            │   └──────────────────────┬───────────────────────┘ │  │
│            │                          │                         │  │
│            │                          ▼                         │  │
│            │              ┌───────────────────────┐            │  │
│            │              │ 收集执行结果          │            │  │
│            │              │ 返回给 LLM            │            │  │
│            │              └───────────┬───────────┘            │  │
│            │                          │                         │  │
│            └──────────────────────────┘                         │  │
│                             │                                    │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              ▼
                       更新 UI 显示
                  （多会话面板 + 对话流）
```

## 会话生命周期管理

### 会话创建流程

```
工具调用参数: { prompt: "...", sessionId: "new-analysis", mode: "new" }
                            │
                            ▼
                ┌───────────────────────┐
                │ ClaudeCodeSessionManager │
                │ .createSession()        │
                └───────────┬───────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │ SessionStoreManager    │
                │ .createSession({       │
                │   id: "analysis-xxx",  │
                │   type: "free",        │
                │   silentMode: true     │ ← 后台会话使用静默模式
                │ })                     │
                └───────────┬───────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │ 返回 sessionId         │
                │ 开始执行任务           │
                └───────────────────────┘
```

### 会话状态同步

```typescript
// 助手监听 Claude Code 会话事件
sessionStoreManager.subscribe((state) => {
  // 检测会话状态变化
  state.sessionMetadata.forEach((meta, sessionId) => {
    const assistantSession = assistantStore.getState().claudeCodeSessions.get(sessionId)

    if (assistantSession && assistantSession.status !== meta.status) {
      // 同步状态到助手 store
      assistantStore.getState().updateSessionStatus(sessionId, meta.status)

      // 会话完成时通知 LLM
      if (meta.status === 'idle' && assistantSession.status === 'running') {
        // 收集执行结果，准备返回给 LLM
        assistantStore.getState().collectSessionResult(sessionId)
      }
    }
  })
})
```

## 配置设计

### config.ts 扩展

```typescript
export interface AssistantConfig {
  /** 是否启用助手模块 */
  enabled: boolean

  /** LLM 配置 */
  llm: {
    /** API Base URL */
    baseUrl: string
    /** API Key（加密存储） */
    apiKey: string
    /** 模型 ID */
    model: string
    /** 最大 Token */
    maxTokens?: number
    /** 温度 */
    temperature?: number
  }

  /** Claude Code 调用配置 */
  claudeCode: {
    /** 默认执行模式 */
    defaultMode: 'new_session' | 'continue_session'
    /** 超时时间（毫秒） */
    timeout?: number
  }
}
```

### 默认配置

```typescript
export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.7
  },
  claudeCode: {
    defaultMode: 'continue_session',
    timeout: 300000
  }
}
```

## 界面集成

### Activity Bar 扩展

在 Activity Bar 添加助手图标，点击后在左侧面板显示助手界面。

```typescript
// ActivityBar 图标配置
const ACTIVITY_ITEMS = [
  { id: 'files', icon: FileText, label: '文件' },
  { id: 'git', icon: GitBranch, label: 'Git' },
  { id: 'todo', icon: CheckSquare, label: '待办' },
  { id: 'assistant', icon: Bot, label: 'AI 助手' }, // 新增
  { id: 'settings', icon: Settings, label: '设置' }
]
```

### 设置页面扩展

在设置页面添加"AI 助手"标签页，配置 LLM 参数。

```typescript
// SettingsSidebar 标签页
const SETTINGS_TABS = [
  { id: 'general', label: '常规' },
  { id: 'assistant', label: 'AI 助手' }, // 新增
  { id: 'window', label: '窗口' },
  // ...
]
```

## 实现优先级

### Phase 1：核心基础（必须）

1. OpenAI 协议适配器实现
2. 助手状态管理（assistantStore）
3. 基础对话 UI
4. 单会话 Claude Code 工具调用（primary 会话）

### Phase 2：多会话管理（重要）

1. ClaudeCodeSessionManager 实现
2. 多会话 UI 面板
3. 会话创建/切换/中断
4. 后台会话支持

### Phase 3：体验优化（重要）

1. 会话执行卡片（折叠/展开）
2. 执行进度实时显示
3. 会话完成通知
4. 结果汇总返回 LLM

### Phase 4：完善功能（可选）

1. 对话历史持久化
2. 多助手配置
3. 自定义系统提示词
4. 快捷键支持
5. 会话模板

## 测试策略

### 单元测试

- OpenAI 协议适配器 API 调用
- 工具参数验证
- 状态管理逻辑

### 集成测试

- 完整对话流程
- Claude Code 调用流程
- 中断和恢复

### E2E 测试

- 用户完整操作流程
- 多种场景覆盖

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| OpenAI API 调用失败 | 完善错误处理，支持重试，显示友好错误信息 |
| Claude Code 执行超时 | 可配置超时时间，支持中断 |
| 工具调用判断错误 | 优化系统提示词，提供手动调用选项 |
| 流式输出中断 | 实现断点续传，保存中间状态 |

## 兼容性考虑

- 支持主流 OpenAI 兼容服务商（OpenAI、Azure、本地模型）
- 复用现有 EventBus 和事件系统
- 复用现有 SessionStoreManager 架构（多会话管理）
- 不影响现有 Claude Code 对话功能

## 架构复用分析

### 复用现有模块

| 模块 | 复用方式 |
|------|----------|
| **SessionStoreManager** | 直接复用，管理 Claude Code 多会话 |
| **ConversationStore** | 每个 Claude Code 会话独立实例 |
| **EventBus** | 事件广播，助手订阅会话完成事件 |
| **EventRouter** | 事件按 sessionId 路由到对应会话 |
| **ClaudeCodeEngine** | 复用，由 SessionStoreManager 管理 |

### 新增模块

| 模块 | 职责 |
|------|------|
| **AssistantStore** | 助手对话状态 + Claude Code 会话索引 |
| **AssistantEngine** | LLM 调用 + 工具执行协调 |
| **ClaudeCodeSessionManager** | 封装 SessionStoreManager，简化会话创建 |
| **OpenAIProtocolEngine** | OpenAI API 适配 |
