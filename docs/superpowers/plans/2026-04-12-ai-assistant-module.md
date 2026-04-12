# AI 助手模块实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Polaris 内实现 AI 助手模块，支持多 Claude Code 会话管理，实现用户与 Claude Code 之间的智能协调层。

**Architecture:** 三层架构：OpenAI 协议适配器 → 助手引擎（工具调用协调）→ ClaudeCodeSessionManager（复用 SessionStoreManager）。助手通过 `invoke_claude_code` 工具管理多个 Claude Code 会话。

**Tech Stack:** TypeScript, React, Zustand, OpenAI API (SSE 流式), 复用现有 AI Runtime / SessionStoreManager

---

## 文件结构

### 新增文件

```
src/
├── engines/
│   └── openai-protocol/
│       ├── types.ts              # OpenAI API 类型定义
│       ├── config.ts             # 配置验证
│       ├── engine.ts             # OpenAI 协议引擎（实现 AIEngine）
│       ├── session.ts            # OpenAI 会话实现
│       └── index.ts              # 模块导出
│
├── assistant/
│   ├── types/
│   │   └── index.ts              # 助手类型定义
│   ├── core/
│   │   ├── SystemPrompt.ts       # 系统提示词
│   │   ├── ToolDefinitions.ts    # 工具定义
│   │   ├── ClaudeCodeSessionManager.ts  # Claude Code 会话管理器
│   │   └── AssistantEngine.ts    # 助手引擎
│   ├── store/
│   │   └── assistantStore.ts     # 助手状态管理
│   ├── hooks/
│   │   └── useAssistant.ts       # 助手交互 Hook
│   ├── components/
│   │   ├── AssistantPanel.tsx    # 助手面板
│   │   ├── AssistantChat.tsx     # 对话消息流
│   │   ├── AssistantInput.tsx    # 输入框
│   │   ├── ClaudeCodeSessionPanel.tsx  # 多会话面板
│   │   └── SessionTab.tsx        # 会话标签
│   └── index.ts                  # 模块导出
│
├── components/Settings/tabs/
│   └── AssistantTab.tsx          # 助手设置标签页
│
└── locales/
    ├── zh-CN/assistant.json      # 中文国际化
    └── en-US/assistant.json      # 英文国际化
```

### 修改文件

```
src/
├── types/config.ts               # 添加 AssistantConfig
├── components/Layout/ActivityBar.tsx  # 添加助手图标
├── components/Settings/SettingsSidebar.tsx  # 添加助手设置标签
├── components/Layout/LeftPanelContent.tsx  # 添加助手面板内容
└── stores/configStore.ts         # 添加助手配置默认值
```

---

## Task 1: OpenAI 协议类型定义

**Files:**
- Create: `src/engines/openai-protocol/types.ts`
- Test: `src/engines/openai-protocol/types.test.ts`

- [ ] **Step 1: 创建 OpenAI API 类型定义**

```typescript
// src/engines/openai-protocol/types.ts

/**
 * OpenAI API 类型定义
 * 支持 OpenAI 兼容的 API 服务
 */

/** OpenAI 消息角色 */
export type OpenAIMessageRole = 'system' | 'user' | 'assistant' | 'tool'

/** OpenAI 消息 */
export interface OpenAIMessage {
  role: OpenAIMessageRole
  content: string | null
  /** 工具调用（assistant 消息） */
  tool_calls?: OpenAIToolCall[]
  /** 工具调用 ID（tool 消息） */
  tool_call_id?: string
  /** 名称（tool 消息） */
  name?: string
}

/** OpenAI 工具定义 */
export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** OpenAI 工具调用 */
export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

/** OpenAI Chat Completion 请求 */
export interface OpenAIChatCompletionRequest {
  model: string
  messages: OpenAIMessage[]
  tools?: OpenAITool[]
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } }
  max_tokens?: number
  temperature?: number
  stream?: boolean
}

/** OpenAI Chat Completion 响应 */
export interface OpenAIChatCompletionResponse {
  id: string
  object: 'chat.completion'
  created: number
  model: string
  choices: Array<{
    index: number
    message: OpenAIMessage
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/** OpenAI 流式响应 Delta */
export interface OpenAIStreamDelta {
  role?: OpenAIMessageRole
  content?: string | null
  tool_calls?: Array<{
    index: number
    id?: string
    type?: 'function'
    function?: {
      name?: string
      arguments?: string
    }
  }>
}

/** OpenAI 流式响应块 */
export interface OpenAIStreamChunk {
  id: string
  object: 'chat.completion.chunk'
  created: number
  model: string
  choices: Array<{
    index: number
    delta: OpenAIStreamDelta
    finish_reason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null
  }>
}

/** OpenAI API 错误响应 */
export interface OpenAIError {
  error: {
    message: string
    type: string
    code?: string
    param?: string
  }
}

/** OpenAI 引擎配置 */
export interface OpenAIEngineConfig {
  /** API Base URL */
  baseUrl: string
  /** API Key */
  apiKey: string
  /** 模型 ID */
  model: string
  /** 最大 Token 数 */
  maxTokens?: number
  /** 温度参数 */
  temperature?: number
  /** 请求超时（毫秒） */
  timeout?: number
}

/** 默认配置 */
export const DEFAULT_OPENAI_CONFIG: Partial<OpenAIEngineConfig> = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
  maxTokens: 4096,
  temperature: 0.7,
  timeout: 60000,
}
```

- [ ] **Step 2: 创建类型测试**

```typescript
// src/engines/openai-protocol/types.test.ts
import { describe, it, expect } from 'vitest'
import type { OpenAIMessage, OpenAIToolCall, OpenAIStreamChunk } from './types'

describe('OpenAI Types', () => {
  it('should define OpenAIMessage correctly', () => {
    const message: OpenAIMessage = {
      role: 'user',
      content: 'Hello',
    }
    expect(message.role).toBe('user')
    expect(message.content).toBe('Hello')
  })

  it('should define OpenAIToolCall correctly', () => {
    const toolCall: OpenAIToolCall = {
      id: 'call_123',
      type: 'function',
      function: {
        name: 'test_function',
        arguments: '{"arg": "value"}',
      },
    }
    expect(toolCall.id).toBe('call_123')
    expect(toolCall.function.name).toBe('test_function')
  })

  it('should define OpenAIStreamChunk correctly', () => {
    const chunk: OpenAIStreamChunk = {
      id: 'chunk_123',
      object: 'chat.completion.chunk',
      created: 1234567890,
      model: 'gpt-4o',
      choices: [{
        index: 0,
        delta: { content: 'Hello' },
        finish_reason: null,
      }],
    }
    expect(chunk.object).toBe('chat.completion.chunk')
    expect(chunk.choices[0].delta.content).toBe('Hello')
  })
})
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run test -- src/engines/openai-protocol/types.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/engines/openai-protocol/types.ts src/engines/openai-protocol/types.test.ts
git commit -m "feat(openai-protocol): add OpenAI API type definitions"
```

---

## Task 2: OpenAI 配置验证

**Files:**
- Create: `src/engines/openai-protocol/config.ts`
- Test: `src/engines/openai-protocol/config.test.ts`

- [ ] **Step 1: 创建配置验证函数**

```typescript
// src/engines/openai-protocol/config.ts

import type { OpenAIEngineConfig } from './types'
import { DEFAULT_OPENAI_CONFIG } from './types'

/** 配置验证结果 */
export interface ConfigValidationResult {
  valid: boolean
  errors: string[]
}

/**
 * 验证 OpenAI 引擎配置
 */
export function validateConfig(config: Partial<OpenAIEngineConfig>): ConfigValidationResult {
  const errors: string[] = []

  // baseUrl 验证
  if (config.baseUrl !== undefined) {
    try {
      new URL(config.baseUrl)
    } catch {
      errors.push('baseUrl must be a valid URL')
    }
  }

  // apiKey 验证
  if (config.apiKey !== undefined && config.apiKey.trim() === '') {
    errors.push('apiKey cannot be empty string')
  }

  // model 验证
  if (config.model !== undefined && config.model.trim() === '') {
    errors.push('model cannot be empty string')
  }

  // maxTokens 验证
  if (config.maxTokens !== undefined) {
    if (config.maxTokens < 1) {
      errors.push('maxTokens must be at least 1')
    }
    if (config.maxTokens > 128000) {
      errors.push('maxTokens cannot exceed 128000')
    }
  }

  // temperature 验证
  if (config.temperature !== undefined) {
    if (config.temperature < 0 || config.temperature > 2) {
      errors.push('temperature must be between 0 and 2')
    }
  }

  // timeout 验证
  if (config.timeout !== undefined) {
    if (config.timeout < 1000) {
      errors.push('timeout must be at least 1000ms')
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * 合并配置与默认值
 */
export function mergeWithDefaults(config: Partial<OpenAIEngineConfig>): OpenAIEngineConfig {
  return {
    ...DEFAULT_OPENAI_CONFIG,
    ...config,
  } as OpenAIEngineConfig
}

/**
 * 检查配置是否完整（包含必要字段）
 */
export function isConfigComplete(config: Partial<OpenAIEngineConfig>): config is OpenAIEngineConfig {
  return (
    typeof config.baseUrl === 'string' &&
    config.baseUrl.length > 0 &&
    typeof config.apiKey === 'string' &&
    config.apiKey.length > 0 &&
    typeof config.model === 'string' &&
    config.model.length > 0
  )
}
```

- [ ] **Step 2: 创建配置测试**

```typescript
// src/engines/openai-protocol/config.test.ts
import { describe, it, expect } from 'vitest'
import { validateConfig, mergeWithDefaults, isConfigComplete } from './config'

describe('OpenAI Config', () => {
  describe('validateConfig', () => {
    it('should pass valid config', () => {
      const result = validateConfig({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
        maxTokens: 4096,
        temperature: 0.7,
      })
      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
    })

    it('should fail on invalid baseUrl', () => {
      const result = validateConfig({ baseUrl: 'not-a-url' })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('baseUrl must be a valid URL')
    })

    it('should fail on empty apiKey', () => {
      const result = validateConfig({ apiKey: '' })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('apiKey cannot be empty string')
    })

    it('should fail on invalid maxTokens', () => {
      const result = validateConfig({ maxTokens: 0 })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('maxTokens must be at least 1')
    })

    it('should fail on invalid temperature', () => {
      const result = validateConfig({ temperature: 3 })
      expect(result.valid).toBe(false)
      expect(result.errors).toContain('temperature must be between 0 and 2')
    })
  })

  describe('mergeWithDefaults', () => {
    it('should merge with defaults', () => {
      const config = mergeWithDefaults({ apiKey: 'sk-test' })
      expect(config.baseUrl).toBe('https://api.openai.com/v1')
      expect(config.model).toBe('gpt-4o')
      expect(config.apiKey).toBe('sk-test')
    })
  })

  describe('isConfigComplete', () => {
    it('should return true for complete config', () => {
      expect(isConfigComplete({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      })).toBe(true)
    })

    it('should return false for incomplete config', () => {
      expect(isConfigComplete({ apiKey: 'sk-test' })).toBe(false)
      expect(isConfigComplete({})).toBe(false)
    })
  })
})
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run test -- src/engines/openai-protocol/config.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/engines/openai-protocol/config.ts src/engines/openai-protocol/config.test.ts
git commit -m "feat(openai-protocol): add config validation utilities"
```

---

## Task 3: OpenAI 协议引擎实现

**Files:**
- Create: `src/engines/openai-protocol/engine.ts`
- Create: `src/engines/openai-protocol/session.ts`
- Create: `src/engines/openai-protocol/index.ts`
- Test: `src/engines/openai-protocol/engine.test.ts`

- [ ] **Step 1: 创建 OpenAI 会话实现**

```typescript
// src/engines/openai-protocol/session.ts

import type { AISession, AISessionStatus } from '../../ai-runtime'
import type { AITask, AIEvent } from '../../ai-runtime'
import { EventEmitter } from '../../ai-runtime'
import type { OpenAIEngineConfig, OpenAIMessage, OpenAITool, OpenAIToolCall } from './types'

/**
 * OpenAI 会话配置
 */
export interface OpenAISessionConfig extends OpenAIEngineConfig {
  /** 系统提示词 */
  systemPrompt?: string
}

/**
 * OpenAI 协议会话
 */
export class OpenAISession extends EventEmitter implements AISession {
  readonly id: string
  status: AISessionStatus = 'idle'

  private config: OpenAISessionConfig
  private messages: OpenAIMessage[] = []
  private tools: OpenAITool[] = []
  private abortController: AbortController | null = null
  private _isDisposed = false

  constructor(id: string, config: OpenAISessionConfig) {
    super()
    this.id = id
    this.config = config

    // 初始化系统消息
    if (config.systemPrompt) {
      this.messages.push({
        role: 'system',
        content: config.systemPrompt,
      })
    }
  }

  /**
   * 设置可用工具
   */
  setTools(tools: OpenAITool[]): void {
    this.tools = tools
  }

  /**
   * 执行任务
   */
  async *run(task: AITask): AsyncIterable<AIEvent> {
    this.status = 'running'
    this.abortController = new AbortController()

    // 添加用户消息
    this.messages.push({
      role: 'user',
      content: task.input.prompt,
    })

    try {
      // 流式调用 API
      yield* this.streamCompletion()
    } catch (error) {
      this.status = 'idle'
      throw error
    }

    this.status = 'idle'
  }

  /**
   * 流式调用 OpenAI API
   */
  private async *streamCompletion(): AsyncIterable<AIEvent> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: this.messages,
        tools: this.tools.length > 0 ? this.tools : undefined,
        tool_choice: this.tools.length > 0 ? 'auto' : undefined,
        max_tokens: this.config.maxTokens,
        temperature: this.config.temperature,
        stream: true,
      }),
      signal: this.abortController?.signal,
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: { message: response.statusText } }))
      throw new Error(error.error?.message || `API error: ${response.status}`)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      throw new Error('Response body is null')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let currentToolCalls: Map<number, OpenAIToolCall> = new Map()
    let assistantContent = ''

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6)
            if (data === '[DONE]') continue

            try {
              const chunk = JSON.parse(data)
              const delta = chunk.choices?.[0]?.delta
              const finishReason = chunk.choices?.[0]?.finish_reason

              if (delta?.content) {
                assistantContent += delta.content
                yield {
                  type: 'assistant_message',
                  sessionId: this.id,
                  content: delta.content,
                  isDelta: true,
                }
              }

              // 处理工具调用
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const existing = currentToolCalls.get(tc.index)
                  if (existing) {
                    // 追加参数
                    if (tc.function?.arguments) {
                      existing.function.arguments += tc.function.arguments
                    }
                  } else {
                    // 新建工具调用
                    currentToolCalls.set(tc.index, {
                      id: tc.id || `call_${tc.index}`,
                      type: 'function',
                      function: {
                        name: tc.function?.name || '',
                        arguments: tc.function?.arguments || '',
                      },
                    })
                  }
                }
              }

              // 流结束
              if (finishReason === 'stop' || finishReason === 'tool_calls') {
                // 保存 assistant 消息
                const assistantMessage: OpenAIMessage = {
                  role: 'assistant',
                  content: assistantContent || null,
                }

                if (currentToolCalls.size > 0) {
                  assistantMessage.tool_calls = Array.from(currentToolCalls.values())
                  
                  // 发送工具调用事件
                  for (const tc of assistantMessage.tool_calls) {
                    yield {
                      type: 'tool_call_start',
                      sessionId: this.id,
                      callId: tc.id,
                      tool: tc.function.name,
                      args: JSON.parse(tc.function.arguments),
                    }
                  }
                }

                this.messages.push(assistantMessage)
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 添加工具结果
   */
  addToolResult(toolCallId: string, result: string): void {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      content: result,
    })
  }

  /**
   * 中断执行
   */
  abort(): void {
    this.abortController?.abort()
    this.status = 'idle'
  }

  /**
   * 销毁会话
   */
  dispose(): void {
    this._isDisposed = true
    this.abort()
    this.removeAllListeners()
    this.messages = []
  }

  /**
   * 获取消息历史
   */
  getMessages(): OpenAIMessage[] {
    return [...this.messages]
  }
}
```

- [ ] **Step 2: 创建 OpenAI 引擎**

```typescript
// src/engines/openai-protocol/engine.ts

import type { AIEngine, AISession, AISessionConfig, EngineCapabilities } from '../../ai-runtime'
import { createCapabilities } from '../../ai-runtime'
import type { OpenAIEngineConfig, OpenAITool } from './types'
import { OpenAISession } from './session'
import { validateConfig, mergeWithDefaults, isConfigComplete } from './config'

/**
 * OpenAI 协议引擎
 * 
 * 实现 AIEngine 接口，支持 OpenAI 兼容的 API 服务
 */
export class OpenAIProtocolEngine implements AIEngine {
  readonly id = 'openai-protocol'
  readonly name = 'OpenAI Protocol'
  readonly capabilities: EngineCapabilities

  private config: OpenAIEngineConfig
  private sessions = new Map<string, OpenAISession>()
  private sessionCounter = 0
  private tools: OpenAITool[] = []

  constructor(config: Partial<OpenAIEngineConfig>) {
    // 验证并合并配置
    const validation = validateConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid OpenAI config: ${validation.errors.join(', ')}`)
    }

    this.config = mergeWithDefaults(config)

    this.capabilities = createCapabilities({
      supportedTaskKinds: ['chat'],
      supportsStreaming: true,
      supportsConcurrentSessions: true,
      supportsTaskAbort: true,
      maxConcurrentSessions: 0, // 无限制
      description: 'OpenAI Protocol Engine - 支持所有 OpenAI 兼容 API',
      version: '1.0.0',
    })
  }

  /**
   * 设置可用工具
   */
  setTools(tools: OpenAITool[]): void {
    this.tools = tools
  }

  /**
   * 创建新会话
   */
  createSession(config?: AISessionConfig): AISession {
    const sessionId = this.generateSessionId()
    
    const session = new OpenAISession(sessionId, {
      ...this.config,
      systemPrompt: config?.options?.systemPrompt as string | undefined,
    })

    // 设置工具
    if (this.tools.length > 0) {
      session.setTools(this.tools)
    }

    // 清理已销毁的会话
    session.onEvent((event) => {
      if (event.type === 'session_end') {
        setTimeout(() => {
          if (session.status === 'idle') {
            this.sessions.delete(sessionId)
          }
        }, 5000)
      }
    })

    this.sessions.set(sessionId, session)
    return session
  }

  /**
   * 检查引擎是否可用
   */
  async isAvailable(): Promise<boolean> {
    return isConfigComplete(this.config)
  }

  /**
   * 初始化引擎
   */
  async initialize(): Promise<boolean> {
    return this.isAvailable()
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    this.sessions.forEach((session) => {
      session.dispose()
    })
    this.sessions.clear()
  }

  /**
   * 获取配置
   */
  getConfig(): OpenAIEngineConfig {
    return { ...this.config }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<OpenAIEngineConfig>): void {
    const validation = validateConfig(config)
    if (!validation.valid) {
      throw new Error(`Invalid OpenAI config: ${validation.errors.join(', ')}`)
    }
    this.config = mergeWithDefaults({ ...this.config, ...config })
  }

  /**
   * 生成唯一会话 ID
   */
  private generateSessionId(): string {
    return `openai-${Date.now()}-${++this.sessionCounter}`
  }
}
```

- [ ] **Step 3: 创建模块导出**

```typescript
// src/engines/openai-protocol/index.ts

export * from './types'
export * from './config'
export { OpenAIProtocolEngine } from './engine'
export { OpenAISession } from './session'
export type { OpenAISessionConfig } from './session'
```

- [ ] **Step 4: 创建引擎测试**

```typescript
// src/engines/openai-protocol/engine.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { OpenAIProtocolEngine } from './engine'

describe('OpenAIProtocolEngine', () => {
  let engine: OpenAIProtocolEngine

  beforeEach(() => {
    engine = new OpenAIProtocolEngine({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    })
  })

  it('should create engine with correct id and name', () => {
    expect(engine.id).toBe('openai-protocol')
    expect(engine.name).toBe('OpenAI Protocol')
  })

  it('should have correct capabilities', () => {
    expect(engine.capabilities.supportsStreaming).toBe(true)
    expect(engine.capabilities.supportsConcurrentSessions).toBe(true)
    expect(engine.capabilities.supportsTaskAbort).toBe(true)
  })

  it('should create session', () => {
    const session = engine.createSession()
    expect(session.id).toBeDefined()
    expect(session.status).toBe('idle')
  })

  it('should be available with complete config', async () => {
    const available = await engine.isAvailable()
    expect(available).toBe(true)
  })

  it('should throw on invalid config', () => {
    expect(() => new OpenAIProtocolEngine({ baseUrl: 'not-a-url' })).toThrow()
  })

  it('should cleanup sessions', () => {
    engine.createSession()
    engine.createSession()
    engine.cleanup()
    // 无错误即通过
  })
})
```

- [ ] **Step 5: 运行测试验证**

```bash
npm run test -- src/engines/openai-protocol/
```

Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/engines/openai-protocol/
git commit -m "feat(openai-protocol): implement OpenAI protocol engine with streaming support"
```

---

## Task 4: 助手类型定义

**Files:**
- Create: `src/assistant/types/index.ts`

- [ ] **Step 1: 创建助手类型定义**

```typescript
// src/assistant/types/index.ts

/**
 * AI 助手模块类型定义
 */

// ============================================
// 消息类型
// ============================================

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

// ============================================
// Claude Code 调用参数
// ============================================

/** Claude Code 调用参数（支持多会话） */
export interface InvokeClaudeCodeParams {
  prompt: string
  /** 目标会话 ID */
  sessionId?: string
  /** 执行模式 */
  mode: 'continue' | 'new' | 'interrupt'
  reason?: string
  /** 是否后台执行 */
  background?: boolean
}

// ============================================
// Claude Code 会话状态
// ============================================

/** Claude Code 会话类型 */
export type ClaudeCodeSessionType = 'primary' | 'analysis' | 'background'

/** Claude Code 会话状态 */
export interface ClaudeCodeSessionState {
  /** 会话 ID */
  id: string
  /** 会话类型 */
  type: ClaudeCodeSessionType
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

// ============================================
// 助手事件
// ============================================

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

// ============================================
// 配置类型
// ============================================

/** 助手配置 */
export interface AssistantConfig {
  /** 是否启用助手模块 */
  enabled: boolean

  /** LLM 配置 */
  llm: {
    /** API Base URL */
    baseUrl: string
    /** API Key */
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
    defaultMode: 'continue' | 'new'
    /** 超时时间（毫秒） */
    timeout?: number
  }
}

/** 默认助手配置 */
export const DEFAULT_ASSISTANT_CONFIG: AssistantConfig = {
  enabled: false,
  llm: {
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-4o',
    maxTokens: 4096,
    temperature: 0.7,
  },
  claudeCode: {
    defaultMode: 'continue',
    timeout: 300000,
  },
}
```

- [ ] **Step 2: 提交**

```bash
git add src/assistant/types/index.ts
git commit -m "feat(assistant): add assistant type definitions"
```

---

## Task 5: 助手核心模块 - 系统提示词和工具定义

**Files:**
- Create: `src/assistant/core/SystemPrompt.ts`
- Create: `src/assistant/core/ToolDefinitions.ts`

- [ ] **Step 1: 创建系统提示词**

```typescript
// src/assistant/core/SystemPrompt.ts

/**
 * AI 助手系统提示词
 */

export const ASSISTANT_SYSTEM_PROMPT = `# 角色定义

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

/**
 * 获取系统提示词
 */
export function getSystemPrompt(): string {
  return ASSISTANT_SYSTEM_PROMPT
}
```

- [ ] **Step 2: 创建工具定义**

```typescript
// src/assistant/core/ToolDefinitions.ts

import type { OpenAITool } from '../../engines/openai-protocol'
import type { InvokeClaudeCodeParams } from '../types'

/**
 * invoke_claude_code 工具定义
 */
export const INVOKE_CLAUDE_CODE_TOOL: OpenAITool = {
  type: 'function',
  function: {
    name: 'invoke_claude_code',
    description: `调用 Claude Code 执行项目操作。支持管理多个独立会话。

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
- 可创建独立的分析会话并行执行任务`,
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '发送给 Claude Code 的指令',
        },
        sessionId: {
          type: 'string',
          description: `目标会话 ID。可选值：
- 'primary': 主对话会话（默认），保持长期上下文
- 'new-{purpose}': 创建新的分析会话，如 'new-analysis'、'new-security-check'
- 已有会话 ID: 继续该会话的任务`,
        },
        mode: {
          type: 'string',
          enum: ['continue', 'new', 'interrupt'],
          description: '执行模式：continue=继续会话, new=创建新会话, interrupt=中断指定会话',
        },
        reason: {
          type: 'string',
          description: '简要说明为什么需要调用 Claude Code',
        },
        background: {
          type: 'boolean',
          description: '是否在后台执行（不阻塞用户对话）',
        },
      },
      required: ['prompt', 'reason'],
    },
  },
}

/**
 * 助手可用工具列表
 */
export const ASSISTANT_TOOLS: OpenAITool[] = [
  INVOKE_CLAUDE_CODE_TOOL,
]

/**
 * 解析工具调用参数
 */
export function parseToolCallArgs(argsString: string): InvokeClaudeCodeParams {
  const parsed = JSON.parse(argsString)
  return {
    prompt: parsed.prompt,
    sessionId: parsed.sessionId,
    mode: parsed.mode || 'continue',
    reason: parsed.reason,
    background: parsed.background || false,
  }
}

/**
 * 获取工具名称列表
 */
export function getToolNames(): string[] {
  return ASSISTANT_TOOLS.map(t => t.function.name)
}
```

- [ ] **Step 3: 提交**

```bash
git add src/assistant/core/SystemPrompt.ts src/assistant/core/ToolDefinitions.ts
git commit -m "feat(assistant): add system prompt and tool definitions"
```

---

## Task 6: ClaudeCodeSessionManager 实现

**Files:**
- Create: `src/assistant/core/ClaudeCodeSessionManager.ts`
- Test: `src/assistant/core/ClaudeCodeSessionManager.test.ts`

- [ ] **Step 1: 创建 ClaudeCodeSessionManager**

```typescript
// src/assistant/core/ClaudeCodeSessionManager.ts

import { sessionStoreManager } from '../../stores/conversationStore'
import type { ClaudeCodeSessionType, ClaudeCodeSessionState } from '../types'

/**
 * Claude Code 会话管理器
 *
 * 负责：
 * 1. 创建和管理多个 Claude Code 会话
 * 2. 复用现有 SessionStoreManager 架构
 * 3. 事件路由到正确的会话
 */
export class ClaudeCodeSessionManager {
  private sessions: Map<string, ClaudeCodeSessionState> = new Map()

  /**
   * 创建新的 Claude Code 会话
   */
  createSession(type: ClaudeCodeSessionType, label?: string): string {
    // primary 会话使用固定 ID
    const sessionId = type === 'primary' ? 'primary' : `${type}-${Date.now()}`
    const displayLabel = label || this.getDefaultLabel(type)

    // 复用现有 SessionStoreManager 创建会话
    sessionStoreManager.getState().createSession({
      id: sessionId,
      type: 'free',
      title: displayLabel,
      silentMode: type === 'background',
    })

    // 记录会话状态
    const sessionState: ClaudeCodeSessionState = {
      id: sessionId,
      type,
      status: 'idle',
      label: displayLabel,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      events: [],
    }

    this.sessions.set(sessionId, sessionState)

    console.log(`[ClaudeCodeSessionManager] 创建会话: ${sessionId} (${type})`)

    return sessionId
  }

  /**
   * 获取会话状态
   */
  getSession(sessionId: string): ClaudeCodeSessionState | undefined {
    return this.sessions.get(sessionId)
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): ClaudeCodeSessionState[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 获取运行中的会话
   */
  getRunningSessions(): ClaudeCodeSessionState[] {
    return Array.from(this.sessions.values()).filter(s => s.status === 'running')
  }

  /**
   * 在指定会话中执行任务
   */
  async executeInSession(sessionId: string, prompt: string, workspacePath?: string): Promise<void> {
    const sessionState = this.sessions.get(sessionId)
    if (!sessionState) {
      throw new Error(`Session not found: ${sessionId}`)
    }

    // 更新状态
    sessionState.status = 'running'
    sessionState.lastActiveAt = Date.now()

    // 获取 ConversationStore 并发送消息
    const store = sessionStoreManager.getState().getStore(sessionId)
    if (!store) {
      throw new Error(`ConversationStore not found for session: ${sessionId}`)
    }

    await store.sendMessage(prompt, workspacePath)
  }

  /**
   * 中断指定会话
   */
  async abortSession(sessionId: string): Promise<void> {
    await sessionStoreManager.getState().interruptSession(sessionId)

    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.status = 'idle'
    }
  }

  /**
   * 中断所有运行中的会话
   */
  async abortAllSessions(): Promise<void> {
    const runningSessions = this.getRunningSessions()
    await Promise.all(runningSessions.map(s => this.abortSession(s.id)))
  }

  /**
   * 更新会话状态
   */
  updateSessionStatus(sessionId: string, status: ClaudeCodeSessionState['status']): void {
    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.status = status
      sessionState.lastActiveAt = Date.now()
    }
  }

  /**
   * 添加执行事件
   */
  addEvent(sessionId: string, event: ClaudeCodeSessionState['events'][0]): void {
    const sessionState = this.sessions.get(sessionId)
    if (sessionState) {
      sessionState.events.push(event)
      sessionState.lastActiveAt = Date.now()
    }
  }

  /**
   * 删除会话
   */
  deleteSession(sessionId: string): void {
    // 不删除 primary 会话
    if (sessionId === 'primary') {
      return
    }

    sessionStoreManager.getState().deleteSession(sessionId)
    this.sessions.delete(sessionId)

    console.log(`[ClaudeCodeSessionManager] 删除会话: ${sessionId}`)
  }

  /**
   * 清理已完成的非主会话
   */
  cleanupCompletedSessions(): void {
    const toDelete: string[] = []

    this.sessions.forEach((state, id) => {
      if (id !== 'primary' && (state.status === 'completed' || state.status === 'error')) {
        toDelete.push(id)
      }
    })

    toDelete.forEach(id => this.deleteSession(id))
  }

  /**
   * 获取默认标签
   */
  private getDefaultLabel(type: ClaudeCodeSessionType): string {
    const labels: Record<ClaudeCodeSessionType, string> = {
      primary: '主会话',
      analysis: '分析任务',
      background: '后台任务',
    }
    return labels[type]
  }
}

/**
 * 全局单例
 */
let managerInstance: ClaudeCodeSessionManager | null = null

export function getClaudeCodeSessionManager(): ClaudeCodeSessionManager {
  if (!managerInstance) {
    managerInstance = new ClaudeCodeSessionManager()
  }
  return managerInstance
}

export function resetClaudeCodeSessionManager(): void {
  if (managerInstance) {
    managerInstance = null
  }
}
```

- [ ] **Step 2: 创建测试**

```typescript
// src/assistant/core/ClaudeCodeSessionManager.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ClaudeCodeSessionManager, resetClaudeCodeSessionManager } from './ClaudeCodeSessionManager'

// Mock sessionStoreManager
vi.mock('../../stores/conversationStore', () => ({
  sessionStoreManager: {
    getState: () => ({
      createSession: vi.fn(),
      getStore: vi.fn(() => ({ sendMessage: vi.fn() })),
      deleteSession: vi.fn(),
      interruptSession: vi.fn(),
    }),
  },
}))

describe('ClaudeCodeSessionManager', () => {
  let manager: ClaudeCodeSessionManager

  beforeEach(() => {
    resetClaudeCodeSessionManager()
    manager = new ClaudeCodeSessionManager()
  })

  it('should create primary session with fixed id', () => {
    const id = manager.createSession('primary', '主会话')
    expect(id).toBe('primary')
  })

  it('should create analysis session with unique id', () => {
    const id = manager.createSession('analysis', '分析任务')
    expect(id).toMatch(/^analysis-\d+$/)
  })

  it('should track session state', () => {
    manager.createSession('primary', '主会话')
    const state = manager.getSession('primary')
    expect(state).toBeDefined()
    expect(state?.type).toBe('primary')
    expect(state?.label).toBe('主会话')
  })

  it('should return all sessions', () => {
    manager.createSession('primary', '主会话')
    manager.createSession('analysis', '分析任务')
    const sessions = manager.getAllSessions()
    expect(sessions).toHaveLength(2)
  })

  it('should not delete primary session', () => {
    manager.createSession('primary', '主会话')
    manager.deleteSession('primary')
    expect(manager.getSession('primary')).toBeDefined()
  })

  it('should delete non-primary sessions', () => {
    const id = manager.createSession('analysis', '分析任务')
    manager.deleteSession(id)
    expect(manager.getSession(id)).toBeUndefined()
  })

  it('should update session status', () => {
    manager.createSession('primary', '主会话')
    manager.updateSessionStatus('primary', 'running')
    expect(manager.getSession('primary')?.status).toBe('running')
  })
})
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run test -- src/assistant/core/ClaudeCodeSessionManager.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/assistant/core/ClaudeCodeSessionManager.ts src/assistant/core/ClaudeCodeSessionManager.test.ts
git commit -m "feat(assistant): implement ClaudeCodeSessionManager for multi-session support"
```

---

## Task 7: 助手状态管理

**Files:**
- Create: `src/assistant/store/assistantStore.ts`
- Test: `src/assistant/store/assistantStore.test.ts`

- [ ] **Step 1: 创建助手 Store**

```typescript
// src/assistant/store/assistantStore.ts

import { create } from 'zustand'
import type {
  AssistantMessage,
  ClaudeCodeSessionState,
  InvokeClaudeCodeParams,
  ClaudeCodeExecutionEvent,
} from '../types'
import { getClaudeCodeSessionManager } from '../core/ClaudeCodeSessionManager'

/**
 * 助手 Store 状态
 */
export interface AssistantState {
  // 消息状态
  messages: AssistantMessage[]
  isLoading: boolean

  // Claude Code 会话管理
  claudeCodeSessions: Map<string, ClaudeCodeSessionState>
  activeClaudeCodeSessionId: string | null

  // UI 状态
  executionPanelExpanded: boolean
  executionPanelSessionId: string | null

  // 错误状态
  error: string | null
}

/**
 * 助手 Store 操作
 */
export interface AssistantActions {
  // 消息操作
  addMessage: (message: AssistantMessage) => void
  updateLastAssistantMessage: (content: string) => void
  clearMessages: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void

  // Claude Code 会话管理
  createClaudeCodeSession: (type: 'primary' | 'analysis' | 'background', label?: string) => string
  getClaudeCodeSession: (sessionId: string) => ClaudeCodeSessionState | undefined
  getAllClaudeCodeSessions: () => ClaudeCodeSessionState[]
  getRunningSessions: () => ClaudeCodeSessionState[]
  updateSessionStatus: (sessionId: string, status: ClaudeCodeSessionState['status']) => void
  addSessionEvent: (sessionId: string, event: ClaudeCodeExecutionEvent) => void

  // Claude Code 执行控制
  executeInSession: (sessionId: string, params: InvokeClaudeCodeParams) => Promise<void>
  abortSession: (sessionId: string) => Promise<void>
  abortAllSessions: () => Promise<void>

  // UI 控制
  toggleExecutionPanel: () => void
  setExecutionPanelSession: (sessionId: string | null) => void

  // 初始化
  initialize: () => void
}

export type AssistantStore = AssistantState & AssistantActions

/**
 * 创建助手 Store
 */
export const useAssistantStore = create<AssistantStore>((set, get) => ({
  // 初始状态
  messages: [],
  isLoading: false,
  claudeCodeSessions: new Map(),
  activeClaudeCodeSessionId: null,
  executionPanelExpanded: false,
  executionPanelSessionId: null,
  error: null,

  // 消息操作
  addMessage: (message) => {
    set((state) => ({
      messages: [...state.messages, message],
    }))
  },

  updateLastAssistantMessage: (content) => {
    set((state) => {
      const messages = [...state.messages]
      const lastIdx = messages.length - 1
      if (lastIdx >= 0 && messages[lastIdx].role === 'assistant') {
        messages[lastIdx] = {
          ...messages[lastIdx],
          content,
        }
      }
      return { messages }
    })
  },

  clearMessages: () => {
    set({ messages: [] })
  },

  setLoading: (loading) => {
    set({ isLoading: loading })
  },

  setError: (error) => {
    set({ error })
  },

  // Claude Code 会话管理
  createClaudeCodeSession: (type, label) => {
    const manager = getClaudeCodeSessionManager()
    const sessionId = manager.createSession(type, label)

    // 同步状态到 store
    const sessionState = manager.getSession(sessionId)!
    set((state) => {
      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, sessionState)
      return {
        claudeCodeSessions: newSessions,
        activeClaudeCodeSessionId: sessionId,
        executionPanelSessionId: sessionId,
      }
    })

    return sessionId
  },

  getClaudeCodeSession: (sessionId) => {
    return get().claudeCodeSessions.get(sessionId)
  },

  getAllClaudeCodeSessions: () => {
    return Array.from(get().claudeCodeSessions.values())
  },

  getRunningSessions: () => {
    return Array.from(get().claudeCodeSessions.values()).filter(
      (s) => s.status === 'running'
    )
  },

  updateSessionStatus: (sessionId, status) => {
    set((state) => {
      const session = state.claudeCodeSessions.get(sessionId)
      if (!session) return state

      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, {
        ...session,
        status,
        lastActiveAt: Date.now(),
      })

      return { claudeCodeSessions: newSessions }
    })
  },

  addSessionEvent: (sessionId, event) => {
    set((state) => {
      const session = state.claudeCodeSessions.get(sessionId)
      if (!session) return state

      const newSessions = new Map(state.claudeCodeSessions)
      newSessions.set(sessionId, {
        ...session,
        events: [...session.events, event],
        lastActiveAt: Date.now(),
      })

      return { claudeCodeSessions: newSessions }
    })
  },

  // Claude Code 执行控制
  executeInSession: async (sessionId, params) => {
    const manager = getClaudeCodeSessionManager()

    // 更新状态为运行中
    get().updateSessionStatus(sessionId, 'running')

    try {
      await manager.executeInSession(sessionId, params.prompt)
    } catch (error) {
      get().updateSessionStatus(sessionId, 'error')
      throw error
    }
  },

  abortSession: async (sessionId) => {
    const manager = getClaudeCodeSessionManager()
    await manager.abortSession(sessionId)
    get().updateSessionStatus(sessionId, 'idle')
  },

  abortAllSessions: async () => {
    const runningSessions = get().getRunningSessions()
    await Promise.all(runningSessions.map((s) => get().abortSession(s.id)))
  },

  // UI 控制
  toggleExecutionPanel: () => {
    set((state) => ({
      executionPanelExpanded: !state.executionPanelExpanded,
    }))
  },

  setExecutionPanelSession: (sessionId) => {
    set({
      executionPanelSessionId: sessionId,
      executionPanelExpanded: sessionId !== null,
    })
  },

  // 初始化
  initialize: () => {
    // 创建 primary 会话
    const hasPrimary = get().claudeCodeSessions.has('primary')
    if (!hasPrimary) {
      get().createClaudeCodeSession('primary', '主会话')
    }
  },
}))

/**
 * 初始化助手 Store
 */
export function initializeAssistantStore(): void {
  useAssistantStore.getState().initialize()
}
```

- [ ] **Step 2: 创建 Store 测试**

```typescript
// src/assistant/store/assistantStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAssistantStore, initializeAssistantStore } from './assistantStore'
import type { AssistantMessage } from '../types'

// Mock ClaudeCodeSessionManager
vi.mock('../core/ClaudeCodeSessionManager', () => ({
  getClaudeCodeSessionManager: () => ({
    createSession: (type: string, label?: string) => {
      const id = type === 'primary' ? 'primary' : `${type}-${Date.now()}`
      return id
    },
    getSession: (id: string) => ({
      id,
      type: id === 'primary' ? 'primary' : 'analysis',
      status: 'idle',
      label: id === 'primary' ? '主会话' : '分析任务',
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      events: [],
    }),
    executeInSession: vi.fn(),
    abortSession: vi.fn(),
  }),
}))

describe('assistantStore', () => {
  beforeEach(() => {
    // 重置 store
    useAssistantStore.setState({
      messages: [],
      isLoading: false,
      claudeCodeSessions: new Map(),
      activeClaudeCodeSessionId: null,
      executionPanelExpanded: false,
      executionPanelSessionId: null,
      error: null,
    })
  })

  it('should add message', () => {
    const message: AssistantMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    }
    useAssistantStore.getState().addMessage(message)
    expect(useAssistantStore.getState().messages).toHaveLength(1)
    expect(useAssistantStore.getState().messages[0].content).toBe('Hello')
  })

  it('should clear messages', () => {
    useAssistantStore.getState().addMessage({
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    })
    useAssistantStore.getState().clearMessages()
    expect(useAssistantStore.getState().messages).toHaveLength(0)
  })

  it('should set loading state', () => {
    useAssistantStore.getState().setLoading(true)
    expect(useAssistantStore.getState().isLoading).toBe(true)
  })

  it('should set error', () => {
    useAssistantStore.getState().setError('Test error')
    expect(useAssistantStore.getState().error).toBe('Test error')
  })

  it('should create primary session on initialize', () => {
    initializeAssistantStore()
    const sessions = useAssistantStore.getState().getAllClaudeCodeSessions()
    expect(sessions.length).toBeGreaterThan(0)
  })

  it('should toggle execution panel', () => {
    expect(useAssistantStore.getState().executionPanelExpanded).toBe(false)
    useAssistantStore.getState().toggleExecutionPanel()
    expect(useAssistantStore.getState().executionPanelExpanded).toBe(true)
  })
})
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run test -- src/assistant/store/assistantStore.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/assistant/store/assistantStore.ts src/assistant/store/assistantStore.test.ts
git commit -m "feat(assistant): implement assistant store with multi-session support"
```

---

## Task 8: 助手引擎实现

**Files:**
- Create: `src/assistant/core/AssistantEngine.ts`
- Test: `src/assistant/core/AssistantEngine.test.ts`

- [ ] **Step 1: 创建助手引擎**

```typescript
// src/assistant/core/AssistantEngine.ts

import { OpenAIProtocolEngine } from '../../engines/openai-protocol'
import type { OpenAIToolCall } from '../../engines/openai-protocol'
import { getEventBus } from '../../ai-runtime'
import type { AIEvent } from '../../ai-runtime'
import { getSystemPrompt } from './SystemPrompt'
import { ASSISTANT_TOOLS, parseToolCallArgs } from './ToolDefinitions'
import { getClaudeCodeSessionManager } from './ClaudeCodeSessionManager'
import { useAssistantStore } from '../store/assistantStore'
import type {
  AssistantEvent,
  InvokeClaudeCodeParams,
  ToolCallInfo,
  ClaudeCodeSessionState,
} from '../types'

/**
 * 助手引擎配置
 */
export interface AssistantEngineConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
  temperature?: number
}

/**
 * 助手引擎
 *
 * 负责：
 * 1. 协调 LLM 调用
 * 2. 处理工具调用
 * 3. 管理 Claude Code 会话
 */
export class AssistantEngine {
  private llmEngine: OpenAIProtocolEngine | null = null
  private eventBus = getEventBus()
  private eventUnsubscribe: (() => void) | null = null

  /**
   * 初始化引擎
   */
  initialize(config: AssistantEngineConfig): void {
    this.llmEngine = new OpenAIProtocolEngine({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
    })

    this.llmEngine.setTools(ASSISTANT_TOOLS)

    // 订阅事件
    this.subscribeToEvents()

    console.log('[AssistantEngine] 初始化完成')
  }

  /**
   * 处理用户消息
   */
  async *processMessage(message: string): AsyncGenerator<AssistantEvent> {
    if (!this.llmEngine) {
      throw new Error('AssistantEngine not initialized')
    }

    // 添加用户消息到 store
    const userMessage = {
      id: `user-${Date.now()}`,
      role: 'user' as const,
      content: message,
      timestamp: Date.now(),
    }
    useAssistantStore.getState().addMessage(userMessage)

    // 创建 LLM 会话
    const session = this.llmEngine.createSession({
      options: { systemPrompt: getSystemPrompt() },
    })

    yield { type: 'message_start' }

    try {
      // 执行任务
      const task = {
        id: `task-${Date.now()}`,
        kind: 'chat' as const,
        input: { prompt: message },
      }

      let currentContent = ''
      const pendingToolCalls: ToolCallInfo[] = []

      for await (const event of session.run(task)) {
        // 处理文本增量
        if (event.type === 'assistant_message' && event.isDelta) {
          currentContent += event.content
          yield { type: 'content_delta', content: event.content }
        }

        // 处理工具调用开始
        if (event.type === 'tool_call_start') {
          const toolCallInfo: ToolCallInfo = {
            id: event.callId || `tc-${Date.now()}`,
            name: event.tool,
            arguments: parseToolCallArgs(JSON.stringify(event.args)),
            status: 'pending',
          }
          pendingToolCalls.push(toolCallInfo)
        }
      }

      // 更新助手消息
      const assistantMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant' as const,
        content: currentContent,
        timestamp: Date.now(),
        toolCalls: pendingToolCalls.length > 0 ? pendingToolCalls : undefined,
      }
      useAssistantStore.getState().addMessage(assistantMessage)

      // 处理工具调用
      for (const toolCall of pendingToolCalls) {
        yield* this.handleToolCall(toolCall)
      }

      yield { type: 'message_complete' }
    } catch (error) {
      console.error('[AssistantEngine] 处理消息失败:', error)
      useAssistantStore.getState().setError((error as Error).message)
      throw error
    }
  }

  /**
   * 处理工具调用
   */
  private async *handleToolCall(toolCall: ToolCallInfo): AsyncGenerator<AssistantEvent> {
    if (toolCall.name !== 'invoke_claude_code') {
      return
    }

    const params = toolCall.arguments
    let sessionId = params.sessionId || 'primary'

    // 创建新会话
    if (params.mode === 'new' || sessionId.startsWith('new-')) {
      const purpose = sessionId.replace('new-', '') || 'analysis'
      sessionId = useAssistantStore.getState().createClaudeCodeSession(
        params.background ? 'background' : 'analysis',
        purpose
      )
      yield { type: 'session_created', session: useAssistantStore.getState().getClaudeCodeSession(sessionId)! }
    }

    // 中断指定会话
    if (params.mode === 'interrupt') {
      await useAssistantStore.getState().abortSession(sessionId)
      return
    }

    // 更新工具调用状态
    yield { type: 'tool_call', toolCall: { ...toolCall, status: 'running', claudeCodeSessionId: sessionId } }

    try {
      // 执行任务
      await useAssistantStore.getState().executeInSession(sessionId, params)

      // 非后台任务等待完成
      if (!params.background) {
        yield* this.waitForSessionCompletion(sessionId)
      }

      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'completed', claudeCodeSessionId: sessionId } }
    } catch (error) {
      yield { type: 'tool_call', toolCall: { ...toolCall, status: 'error', claudeCodeSessionId: sessionId } }
    }
  }

  /**
   * 等待会话完成
   */
  private async *waitForSessionCompletion(sessionId: string): AsyncGenerator<AssistantEvent> {
    yield new Promise<void>((resolve) => {
      const unsubscribe = this.eventBus.subscribe((event: AIEvent) => {
        if (event.type === 'session_end' && event.sessionId === sessionId) {
          unsubscribe()
          resolve()
        }
      })
    }) as unknown as AsyncGenerator<AssistantEvent>
  }

  /**
   * 订阅事件
   */
  private subscribeToEvents(): void {
    this.eventUnsubscribe = this.eventBus.subscribe((event: AIEvent) => {
      // 同步会话状态
      if (event.type === 'session_start' || event.type === 'session_end') {
        const sessionId = event.sessionId
        const status = event.type === 'session_start' ? 'running' : 'idle'
        useAssistantStore.getState().updateSessionStatus(sessionId, status)
      }
    })
  }

  /**
   * 清理资源
   */
  cleanup(): void {
    if (this.eventUnsubscribe) {
      this.eventUnsubscribe()
      this.eventUnsubscribe = null
    }
    if (this.llmEngine) {
      this.llmEngine.cleanup()
      this.llmEngine = null
    }
  }
}

/**
 * 全局单例
 */
let engineInstance: AssistantEngine | null = null

export function getAssistantEngine(): AssistantEngine {
  if (!engineInstance) {
    engineInstance = new AssistantEngine()
  }
  return engineInstance
}

export function resetAssistantEngine(): void {
  if (engineInstance) {
    engineInstance.cleanup()
    engineInstance = null
  }
}
```

- [ ] **Step 2: 创建测试**

```typescript
// src/assistant/core/AssistantEngine.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AssistantEngine, resetAssistantEngine } from './AssistantEngine'

// Mock dependencies
vi.mock('../../engines/openai-protocol', () => ({
  OpenAIProtocolEngine: vi.fn().mockImplementation(() => ({
    setTools: vi.fn(),
    createSession: vi.fn(() => ({
      run: vi.fn(async function* () {
        yield { type: 'assistant_message', content: 'Hello', isDelta: true }
        yield { type: 'session_end', sessionId: 'test' }
      }),
    })),
    cleanup: vi.fn(),
  })),
}))

vi.mock('../../ai-runtime', () => ({
  getEventBus: () => ({
    subscribe: vi.fn(() => vi.fn()),
  }),
}))

vi.mock('../store/assistantStore', () => ({
  useAssistantStore: {
    getState: () => ({
      addMessage: vi.fn(),
      createClaudeCodeSession: vi.fn(() => 'test-session'),
      getClaudeCodeSession: vi.fn(() => ({ id: 'test-session', status: 'idle' })),
      executeInSession: vi.fn(),
      updateSessionStatus: vi.fn(),
      setError: vi.fn(),
    }),
  },
}))

describe('AssistantEngine', () => {
  let engine: AssistantEngine

  beforeEach(() => {
    resetAssistantEngine()
    engine = new AssistantEngine()
  })

  it('should initialize with config', () => {
    engine.initialize({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    })
    // 无错误即通过
  })

  it('should throw error when not initialized', async () => {
    await expect(async () => {
      for await (const _ of engine.processMessage('Hello')) {
        // empty
      }
    }).rejects.toThrow('not initialized')
  })

  it('should cleanup resources', () => {
    engine.initialize({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'test-key',
      model: 'gpt-4o',
    })
    engine.cleanup()
    // 无错误即通过
  })
})
```

- [ ] **Step 3: 运行测试验证**

```bash
npm run test -- src/assistant/core/AssistantEngine.test.ts
```

Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add src/assistant/core/AssistantEngine.ts src/assistant/core/AssistantEngine.test.ts
git commit -m "feat(assistant): implement AssistantEngine for LLM and tool coordination"
```

---

## Task 9: 助手 UI 组件

**Files:**
- Create: `src/assistant/components/AssistantPanel.tsx`
- Create: `src/assistant/components/AssistantChat.tsx`
- Create: `src/assistant/components/AssistantInput.tsx`
- Create: `src/assistant/components/ClaudeCodeSessionPanel.tsx`
- Create: `src/assistant/components/SessionTab.tsx`

- [ ] **Step 1: 创建 AssistantPanel**

```typescript
// src/assistant/components/AssistantPanel.tsx

import React, { useEffect } from 'react'
import { useAssistantStore, initializeAssistantStore } from '../store/assistantStore'
import { AssistantChat } from './AssistantChat'
import { AssistantInput } from './AssistantInput'
import { ClaudeCodeSessionPanel } from './ClaudeCodeSessionPanel'

/**
 * 助手面板 - 主界面
 */
export function AssistantPanel() {
  const { claudeCodeSessions, initialize } = useAssistantStore()

  // 初始化
  useEffect(() => {
    initialize()
  }, [initialize])

  const sessionCount = claudeCodeSessions.size
  const runningCount = Array.from(claudeCodeSessions.values()).filter(
    (s) => s.status === 'running'
  ).length

  return (
    <div className="flex flex-col h-full bg-surface">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-medium text-text">AI 助手</h2>
        <div className="flex items-center gap-2 text-xs text-text-muted">
          {sessionCount > 0 && (
            <span>
              {runningCount > 0 && (
                <span className="inline-flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  {runningCount} 运行中
                </span>
              )}
            </span>
          )}
        </div>
      </div>

      {/* 对话消息流 */}
      <div className="flex-1 overflow-hidden">
        <AssistantChat />
      </div>

      {/* Claude Code 多会话面板 */}
      <ClaudeCodeSessionPanel />

      {/* 输入框 */}
      <AssistantInput />
    </div>
  )
}
```

- [ ] **Step 2: 创建 AssistantChat**

```typescript
// src/assistant/components/AssistantChat.tsx

import React, { useRef, useEffect } from 'react'
import { useAssistantStore } from '../store/assistantStore'

/**
 * 助手对话消息流
 */
export function AssistantChat() {
  const { messages, isLoading } = useAssistantStore()
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted text-sm">
        <div className="text-center">
          <p className="mb-2">👋 你好！我是 AI 助手</p>
          <p className="text-xs text-text-faint">
            我可以帮你分析需求、调用 Claude Code 执行项目操作
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3">
      {messages.map((message) => (
        <div
          key={message.id}
          className={`mb-4 ${
            message.role === 'user' ? 'text-right' : 'text-left'
          }`}
        >
          <div
            className={`inline-block max-w-[80%] px-3 py-2 rounded-lg text-sm ${
              message.role === 'user'
                ? 'bg-primary text-primary-foreground'
                : 'bg-surface-elevated text-text'
            }`}
          >
            {message.content}
          </div>

          {/* 工具调用指示 */}
          {message.toolCalls && message.toolCalls.length > 0 && (
            <div className="mt-2 text-left">
              {message.toolCalls.map((tc) => (
                <div
                  key={tc.id}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-surface-elevated rounded text-xs text-text-muted"
                >
                  {tc.status === 'running' && (
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                  )}
                  {tc.status === 'completed' && (
                    <span className="w-2 h-2 rounded-full bg-success" />
                  )}
                  {tc.status === 'error' && (
                    <span className="w-2 h-2 rounded-full bg-danger" />
                  )}
                  <span>Claude Code: {tc.arguments.reason || tc.arguments.prompt?.slice(0, 30)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* 加载指示器 */}
      {isLoading && (
        <div className="mb-4 text-left">
          <div className="inline-flex items-center gap-2 px-3 py-2 bg-surface-elevated rounded-lg text-sm text-text-muted">
            <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
            思考中...
          </div>
        </div>
      )}

      <div ref={messagesEndRef} />
    </div>
  )
}
```

- [ ] **Step 3: 创建 AssistantInput**

```typescript
// src/assistant/components/AssistantInput.tsx

import React, { useState, useRef, KeyboardEvent } from 'react'
import { Send, Square } from 'lucide-react'
import { useAssistantStore } from '../store/assistantStore'
import { getAssistantEngine } from '../core/AssistantEngine'

/**
 * 助手输入框
 */
export function AssistantInput() {
  const [input, setInput] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const { isLoading, setLoading, setError, abortAllSessions, getRunningSessions } = useAssistantStore()

  const handleSubmit = async () => {
    const trimmedInput = input.trim()
    if (!trimmedInput || isLoading) return

    setInput('')
    setLoading(true)
    setError(null)

    try {
      const engine = getAssistantEngine()
      for await (const _ of engine.processMessage(trimmedInput)) {
        // 处理事件
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSubmit()
    }
  }

  const handleAbort = async () => {
    await abortAllSessions()
    setLoading(false)
  }

  const runningSessions = getRunningSessions()
  const isRunning = runningSessions.length > 0 || isLoading

  return (
    <div className="border-t border-border p-3 shrink-0">
      <div className="flex items-end gap-2">
        <div className="flex-1 relative">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="输入消息..."
            rows={1}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text placeholder-text-muted resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
            style={{ minHeight: '40px', maxHeight: '120px' }}
          />
        </div>

        {isRunning ? (
          <button
            onClick={handleAbort}
            className="flex items-center justify-center w-10 h-10 bg-danger rounded-lg text-danger-foreground hover:bg-danger/90 transition-colors"
          >
            <Square className="w-4 h-4" />
          </button>
        ) : (
          <button
            onClick={handleSubmit}
            disabled={!input.trim()}
            className="flex items-center justify-center w-10 h-10 bg-primary rounded-lg text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Send className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: 创建 ClaudeCodeSessionPanel**

```typescript
// src/assistant/components/ClaudeCodeSessionPanel.tsx

import React, { useState } from 'react'
import { ChevronUp, ChevronDown, Loader2, CheckCircle, XCircle } from 'lucide-react'
import { useAssistantStore } from '../store/assistantStore'
import { SessionTab } from './SessionTab'
import { cn } from '../../utils'

/**
 * Claude Code 多会话面板
 */
export function ClaudeCodeSessionPanel() {
  const [isCollapsed, setIsCollapsed] = useState(true)
  const {
    claudeCodeSessions,
    executionPanelSessionId,
    setExecutionPanelSession,
  } = useAssistantStore()

  const sessions = Array.from(claudeCodeSessions.values())
  const runningSessions = sessions.filter((s) => s.status === 'running')

  if (sessions.length === 0) return null

  return (
    <div
      className={cn(
        'border-t border-border transition-all shrink-0',
        isCollapsed ? 'h-10' : 'h-48'
      )}
    >
      {/* 折叠状态栏 */}
      <div
        className="flex items-center justify-between px-4 h-10 cursor-pointer hover:bg-surface-elevated/50"
        onClick={() => setIsCollapsed(!isCollapsed)}
      >
        <div className="flex items-center gap-2">
          {runningSessions.length > 0 && (
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
          )}
          <span className="text-sm text-text-muted">
            {runningSessions.length > 0
              ? `${runningSessions.length} 个会话运行中`
              : 'Claude Code 会话'}
          </span>
        </div>
        {isCollapsed ? (
          <ChevronUp className="w-4 h-4 text-text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-text-muted" />
        )}
      </div>

      {/* 展开内容 */}
      {!isCollapsed && (
        <>
          {/* 会话标签栏 */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-border/50 overflow-x-auto">
            {sessions.map((session) => (
              <SessionTab
                key={session.id}
                session={session}
                isActive={executionPanelSessionId === session.id}
                onClick={() => setExecutionPanelSession(session.id)}
              />
            ))}
          </div>

          {/* 会话内容 */}
          {executionPanelSessionId && (
            <div className="h-[calc(100%-78px)] overflow-auto px-4 py-2">
              <SessionContent sessionId={executionPanelSessionId} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * 会话内容
 */
function SessionContent({ sessionId }: { sessionId: string }) {
  const { getClaudeCodeSession } = useAssistantStore()
  const session = getClaudeCodeSession(sessionId)

  if (!session) return null

  if (session.events.length === 0) {
    return (
      <div className="text-sm text-text-muted text-center py-4">
        等待执行...
      </div>
    )
  }

  return (
    <div className="space-y-1">
      {session.events.map((event, idx) => (
        <div
          key={idx}
          className="text-xs font-mono text-text-muted flex items-start gap-2"
        >
          <span className="text-text-faint shrink-0">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-text">
            {event.data.message || event.data.content || event.data.tool}
          </span>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 5: 创建 SessionTab**

```typescript
// src/assistant/components/SessionTab.tsx

import React from 'react'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'
import type { ClaudeCodeSessionState } from '../types'
import { cn } from '../../utils'

interface SessionTabProps {
  session: ClaudeCodeSessionState
  isActive: boolean
  onClick: () => void
}

/**
 * 会话标签
 */
export function SessionTab({ session, isActive, onClick }: SessionTabProps) {
  return (
    <button
      className={cn(
        'flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors',
        isActive
          ? 'bg-primary/20 text-primary'
          : 'text-text-muted hover:bg-surface-elevated'
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

- [ ] **Step 6: 提交**

```bash
git add src/assistant/components/
git commit -m "feat(assistant): add UI components for assistant panel"
```

---

## Task 10: 助手 Hook 和模块导出

**Files:**
- Create: `src/assistant/hooks/useAssistant.ts`
- Create: `src/assistant/index.ts`

- [ ] **Step 1: 创建 useAssistant Hook**

```typescript
// src/assistant/hooks/useAssistant.ts

import { useCallback } from 'react'
import { useAssistantStore } from '../store/assistantStore'
import { getAssistantEngine } from '../core/AssistantEngine'

/**
 * 助手交互 Hook
 */
export function useAssistant() {
  const store = useAssistantStore()

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || store.isLoading) return

    store.setLoading(true)
    store.setError(null)

    try {
      const engine = getAssistantEngine()
      for await (const _ of engine.processMessage(content)) {
        // 处理事件
      }
    } catch (error) {
      store.setError((error as Error).message)
    } finally {
      store.setLoading(false)
    }
  }, [store])

  const abort = useCallback(async () => {
    await store.abortAllSessions()
    store.setLoading(false)
  }, [store])

  return {
    // 状态
    messages: store.messages,
    isLoading: store.isLoading,
    error: store.error,
    sessions: store.getAllClaudeCodeSessions(),
    runningSessions: store.getRunningSessions(),

    // 操作
    sendMessage,
    abort,
    clearMessages: store.clearMessages,

    // UI
    executionPanelExpanded: store.executionPanelExpanded,
    toggleExecutionPanel: store.toggleExecutionPanel,
  }
}
```

- [ ] **Step 2: 创建模块导出**

```typescript
// src/assistant/index.ts

// 类型
export * from './types'

// 核心
export { ASSISTANT_SYSTEM_PROMPT, getSystemPrompt } from './core/SystemPrompt'
export { INVOKE_CLAUDE_CODE_TOOL, ASSISTANT_TOOLS, parseToolCallArgs, getToolNames } from './core/ToolDefinitions'
export { ClaudeCodeSessionManager, getClaudeCodeSessionManager } from './core/ClaudeCodeSessionManager'
export { AssistantEngine, getAssistantEngine } from './core/AssistantEngine'

// Store
export { useAssistantStore, initializeAssistantStore } from './store/assistantStore'

// Hooks
export { useAssistant } from './hooks/useAssistant'

// Components
export { AssistantPanel } from './components/AssistantPanel'
export { AssistantChat } from './components/AssistantChat'
export { AssistantInput } from './components/AssistantInput'
export { ClaudeCodeSessionPanel } from './components/ClaudeCodeSessionPanel'
export { SessionTab } from './components/SessionTab'
```

- [ ] **Step 3: 提交**

```bash
git add src/assistant/hooks/useAssistant.ts src/assistant/index.ts
git commit -m "feat(assistant): add useAssistant hook and module exports"
```

---

## Task 11: 配置扩展

**Files:**
- Modify: `src/types/config.ts`
- Modify: `src/stores/configStore.ts`

- [ ] **Step 1: 扩展配置类型**

在 `src/types/config.ts` 中添加：

```typescript
// 在文件末尾添加

import type { AssistantConfig } from '../assistant/types'

// 扩展 AppConfig
declare module './config' {
  interface AppConfig {
    /** 助手配置 */
    assistant?: AssistantConfig
  }
}
```

- [ ] **Step 2: 更新 configStore**

在 `src/stores/configStore.ts` 中添加默认值：

```typescript
// 导入
import { DEFAULT_ASSISTANT_CONFIG } from '../assistant/types'

// 在 defaultConfig 中添加
const defaultConfig: AppConfig = {
  // ... 现有配置
  assistant: DEFAULT_ASSISTANT_CONFIG,
}
```

- [ ] **Step 3: 提交**

```bash
git add src/types/config.ts src/stores/configStore.ts
git commit -m "feat(config): add assistant configuration support"
```

---

## Task 12: Activity Bar 集成

**Files:**
- Modify: `src/components/Layout/ActivityBar.tsx`
- Modify: `src/components/Layout/LeftPanelContent.tsx`

- [ ] **Step 1: 修改 ActivityBar 添加助手图标**

在 `src/components/Layout/ActivityBar.tsx` 中：

```typescript
// 添加导入
import { Bot } from 'lucide-react'

// 在 activityItems 数组中添加
const activityItems = [
  // ... 现有项目
  {
    id: 'assistant',
    icon: Bot,
    label: t('activity.assistant', { ns: 'common' }),
  },
]
```

- [ ] **Step 2: 修改 LeftPanelContent 添加助手面板**

在 `src/components/Layout/LeftPanelContent.tsx` 中：

```typescript
// 添加导入
import { AssistantPanel } from '../../assistant'

// 在 panelContentMap 中添加
const panelContentMap: Record<string, React.ReactNode> = {
  // ... 现有项目
  assistant: <AssistantPanel />,
}
```

- [ ] **Step 3: 提交**

```bash
git add src/components/Layout/ActivityBar.tsx src/components/Layout/LeftPanelContent.tsx
git commit -m "feat(ui): integrate assistant panel into activity bar"
```

---

## Task 13: 设置页面集成

**Files:**
- Create: `src/components/Settings/tabs/AssistantTab.tsx`
- Modify: `src/components/Settings/SettingsSidebar.tsx`

- [ ] **Step 1: 创建助手设置标签页**

```typescript
// src/components/Settings/tabs/AssistantTab.tsx

import React from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../../stores/configStore'
import { DEFAULT_ASSISTANT_CONFIG } from '../../../assistant/types'

export function AssistantTab() {
  const { t } = useTranslation('settings')
  const { config, updateConfig } = useConfigStore()

  const assistantConfig = config?.assistant || DEFAULT_ASSISTANT_CONFIG

  const handleToggle = () => {
    updateConfig({
      ...config,
      assistant: {
        ...assistantConfig,
        enabled: !assistantConfig.enabled,
      },
    })
  }

  const handleLLMConfigChange = (key: string, value: string | number) => {
    updateConfig({
      ...config,
      assistant: {
        ...assistantConfig,
        llm: {
          ...assistantConfig.llm,
          [key]: value,
        },
      },
    })
  }

  return (
    <div className="space-y-6">
      {/* 启用开关 */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-text">
            {t('assistant.enable')}
          </h3>
          <p className="text-xs text-text-muted mt-1">
            {t('assistant.enableDescription')}
          </p>
        </div>
        <button
          onClick={handleToggle}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            assistantConfig.enabled ? 'bg-primary' : 'bg-surface-elevated'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              assistantConfig.enabled ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* LLM 配置 */}
      <div className="space-y-4">
        <h3 className="text-sm font-medium text-text">
          {t('assistant.llmConfig')}
        </h3>

        {/* Base URL */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.baseUrl')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.baseUrl}
            onChange={(e) => handleLLMConfigChange('baseUrl', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="https://api.openai.com/v1"
          />
        </div>

        {/* API Key */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.apiKey')}
          </label>
          <input
            type="password"
            value={assistantConfig.llm.apiKey}
            onChange={(e) => handleLLMConfigChange('apiKey', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="sk-..."
          />
        </div>

        {/* Model */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.model')}
          </label>
          <input
            type="text"
            value={assistantConfig.llm.model}
            onChange={(e) => handleLLMConfigChange('model', e.target.value)}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
            placeholder="gpt-4o"
          />
        </div>

        {/* Temperature */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            {t('assistant.temperature')}
          </label>
          <input
            type="number"
            min="0"
            max="2"
            step="0.1"
            value={assistantConfig.llm.temperature || 0.7}
            onChange={(e) => handleLLMConfigChange('temperature', parseFloat(e.target.value))}
            className="w-full px-3 py-2 bg-surface-elevated border border-border rounded-lg text-sm text-text"
          />
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 修改 SettingsSidebar**

在 `src/components/Settings/SettingsSidebar.tsx` 中添加助手标签：

```typescript
// 添加导入
import { Bot } from 'lucide-react'

// 在 tabs 数组中添加
const tabs = [
  // ... 现有标签
  { id: 'assistant', icon: Bot, label: 'AI 助手' },
]
```

- [ ] **Step 3: 提交**

```bash
git add src/components/Settings/tabs/AssistantTab.tsx src/components/Settings/SettingsSidebar.tsx
git commit -m "feat(settings): add assistant settings tab"
```

---

## Task 14: 国际化

**Files:**
- Create: `src/locales/zh-CN/assistant.json`
- Create: `src/locales/en-US/assistant.json`

- [ ] **Step 1: 创建中文国际化**

```json
{
  "activity": {
    "assistant": "AI 助手"
  },
  "panel": {
    "title": "AI 助手",
    "placeholder": "输入消息...",
    "thinking": "思考中...",
    "empty": "👋 你好！我是 AI 助手",
    "emptyHint": "我可以帮你分析需求、调用 Claude Code 执行项目操作"
  },
  "session": {
    "primary": "主会话",
    "analysis": "分析任务",
    "background": "后台任务",
    "running": "运行中",
    "completed": "已完成",
    "error": "执行失败",
    "idle": "等待执行"
  },
  "settings": {
    "enable": "启用 AI 助手",
    "enableDescription": "启用后可在左侧面板使用 AI 助手",
    "llmConfig": "LLM 配置",
    "baseUrl": "API Base URL",
    "apiKey": "API Key",
    "model": "模型",
    "temperature": "温度参数"
  }
}
```

- [ ] **Step 2: 创建英文国际化**

```json
{
  "activity": {
    "assistant": "AI Assistant"
  },
  "panel": {
    "title": "AI Assistant",
    "placeholder": "Type a message...",
    "thinking": "Thinking...",
    "empty": "👋 Hello! I'm your AI Assistant",
    "emptyHint": "I can help analyze requirements and invoke Claude Code for project operations"
  },
  "session": {
    "primary": "Primary",
    "analysis": "Analysis",
    "background": "Background",
    "running": "Running",
    "completed": "Completed",
    "error": "Error",
    "idle": "Idle"
  },
  "settings": {
    "enable": "Enable AI Assistant",
    "enableDescription": "Enable AI Assistant in the left panel",
    "llmConfig": "LLM Configuration",
    "baseUrl": "API Base URL",
    "apiKey": "API Key",
    "model": "Model",
    "temperature": "Temperature"
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/locales/zh-CN/assistant.json src/locales/en-US/assistant.json
git commit -m "feat(i18n): add assistant localization for zh-CN and en-US"
```

---

## Task 15: 集成测试和验证

**Files:**
- Test: 集成测试

- [ ] **Step 1: 运行所有测试**

```bash
npm run test
```

Expected: PASS

- [ ] **Step 2: 运行 TypeScript 编译检查**

```bash
npm run build
```

Expected: 无错误

- [ ] **Step 3: 运行 lint 检查**

```bash
npm run lint
```

Expected: 无错误

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "feat(assistant): complete AI assistant module implementation

- Add OpenAI protocol engine with streaming support
- Implement multi-session Claude Code management
- Add assistant store with state management
- Create UI components (AssistantPanel, ClaudeCodeSessionPanel)
- Integrate with Activity Bar and Settings
- Add i18n support for zh-CN and en-US

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

## 自检清单

完成计划后，对照规格文档检查：

| 规格要求 | 任务覆盖 |
|---------|---------|
| OpenAI 协议适配器 | Task 1-3 |
| 助手类型定义 | Task 4 |
| 系统提示词和工具定义 | Task 5 |
| 多会话管理 (ClaudeCodeSessionManager) | Task 6 |
| 助手状态管理 | Task 7 |
| 助手引擎 | Task 8 |
| UI 组件 | Task 9 |
| Hook 和模块导出 | Task 10 |
| 配置扩展 | Task 11 |
| Activity Bar 集成 | Task 12 |
| 设置页面集成 | Task 13 |
| 国际化 | Task 14 |

**无占位符确认：** 所有步骤均包含完整代码，无 TBD/TODO。

**类型一致性确认：** 所有类型定义在 Task 4 统一定义，后续任务引用一致。
