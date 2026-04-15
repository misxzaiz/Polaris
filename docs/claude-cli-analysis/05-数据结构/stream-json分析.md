# stream-json 数据结构深度分析

**版本**: v1.0
**日期**: 2026-04-15
**命令**: `claude -p --output-format stream-json --verbose "prompt"`

> 这是本次分析最重要的文档。stream-json 输出格式提供了 CLI 所有动态数据的结构化访问入口。

---

## 一、stream-json 概述

### 1.1 输出格式

stream-json 输出为 NDJSON (Newline-Delimited JSON)，每行一个 JSON 对象。

```bash
echo "" | claude -p --output-format stream-json --verbose "say ok"
```

**前置条件**:
- 必须使用 `--print` (`-p`) 模式
- `stream-json` 需要同时使用 `--verbose`
- 不使用 `--verbose` 会报错: `--output-format=stream-json requires --verbose`

### 1.2 事件类型总览

| type | subtype | 触发时机 | 可视化价值 |
|------|---------|---------|-----------|
| `system` | `hook_started` | Hook 开始执行 | 调试面板 |
| `system` | `hook_response` | Hook 执行完成 | 调试面板 |
| `system` | `init` | **会话初始化** | **核心数据源** |
| `assistant` | - | AI 回复消息 | 已实现 |
| `result` | `success` / `error` | 最终结果 | 已实现 |

---

## 二、init 事件完整数据结构

### 2.1 TypeScript 类型定义

```typescript
/** stream-json init 事件 */
export interface StreamInitEvent {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  mcp_servers: StreamMcpServer[]
  model: string
  permissionMode: string
  slash_commands: string[]
  apiKeySource: string
  claude_code_version: string
  output_style: string
  agents: string[]
  skills: string[]
  plugins: StreamPlugin[]
  fast_mode_state: 'on' | 'off'
}

/** MCP 服务器状态 */
export interface StreamMcpServer {
  name: string
  status: 'connected' | 'needs-auth' | 'pending' | 'error'
}

/** 活跃插件 */
export interface StreamPlugin {
  name: string
  path: string
  source: string  // 格式: "name@marketplace"
}
```

### 2.2 实测数据 (v2.1.104)

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "D:\\space\\base\\Polaris",
  "session_id": "8f725403-8a36-4052-acd5-20fb6bf5eeb5",
  "tools": [
    "Task", "AskUserQuestion", "Bash", "CronCreate", "CronDelete",
    "CronList", "Edit", "EnterPlanMode", "EnterWorktree", "ExitPlanMode",
    "ExitWorktree", "Glob", "Grep", "LSP", "NotebookEdit", "Read",
    "ScheduleWakeup", "Skill", "TaskOutput", "TaskStop", "TodoWrite",
    "WebFetch", "WebSearch", "Write",
    "mcp__plugin_figma_figma__authenticate",
    "mcp__plugin_figma_figma__complete_authentication",
    "mcp__plugin_supabase_supabase__authenticate",
    "mcp__plugin_supabase_supabase__complete_authentication"
  ],
  "mcp_servers": [
    { "name": "plugin:figma:figma", "status": "needs-auth" },
    { "name": "plugin:playwright:playwright", "status": "pending" },
    { "name": "plugin:supabase:supabase", "status": "needs-auth" },
    { "name": "chrome-devtools", "status": "pending" }
  ],
  "model": "glm-5.1",
  "permissionMode": "default",
  "slash_commands": [
    "update-config", "debug", "simplify", "batch", "loop", "claude-api",
    "pua:flavor", "pua:cancel-pua-loop", "pua:kpi", "pua:mama",
    "pua:off", "pua:p10", "pua:p7", "pua:p9", "pua:on", "pua:pro",
    "pua:pua", "pua:pua-loop", "pua:survey", "pua:yes",
    "superpowers:brainstorm", "superpowers:execute-plan",
    "superpowers:write-plan",
    "figma:figma-create-design-system-rules", "figma:figma-code-connect",
    "figma:figma-generate-design", "figma:figma-generate-library",
    "figma:figma-use", "figma:figma-implement-design",
    "frontend-design:frontend-design",
    "pua:pua-en", "pua:shot", "pua:pua-ja",
    "superpowers:brainstorming", "superpowers:executing-plans",
    "superpowers:dispatching-parallel-agents",
    "superpowers:finishing-a-development-branch",
    "superpowers:receiving-code-review", "superpowers:requesting-code-review",
    "superpowers:systematic-debugging", "superpowers:test-driven-development",
    "superpowers:subagent-driven-development", "superpowers:using-git-worktrees",
    "superpowers:using-superpowers", "superpowers:writing-skills",
    "superpowers:writing-plans", "superpowers:verification-before-completion",
    "compact", "context", "cost", "heapdump", "init", "review",
    "security-review", "insights", "team-onboarding"
  ],
  "apiKeySource": "none",
  "claude_code_version": "2.1.104",
  "output_style": "default",
  "agents": [
    "general-purpose", "statusline-setup", "Explore", "Plan",
    "pua:cto-p10", "pua:senior-engineer-p7", "pua:tech-lead-p9",
    "superpowers:code-reviewer"
  ],
  "skills": [
    "update-config", "debug", "simplify", "batch", "loop", "claude-api",
    "figma:figma-create-design-system-rules", "figma:figma-code-connect",
    "figma:figma-generate-design", "figma:figma-generate-library",
    "figma:figma-use", "figma:figma-implement-design",
    "frontend-design:frontend-design",
    "pua:mama", "pua:p10", "pua:p7", "pua:pro", "pua:p9", "pua:pua",
    "pua:pua-en", "pua:pua-loop", "pua:shot", "pua:pua-ja", "pua:yes",
    "superpowers:brainstorming", "superpowers:executing-plans",
    "superpowers:dispatching-parallel-agents",
    "superpowers:finishing-a-development-branch",
    "superpowers:receiving-code-review", "superpowers:requesting-code-review",
    "superpowers:systematic-debugging", "superpowers:test-driven-development",
    "superpowers:subagent-driven-development", "superpowers:using-git-worktrees",
    "superpowers:using-superpowers", "superpowers:writing-skills",
    "superpowers:writing-plans", "superpowers:verification-before-completion"
  ],
  "plugins": [
    {
      "name": "figma",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\figma\\2.0.7",
      "source": "figma@claude-plugins-official"
    },
    {
      "name": "frontend-design",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\frontend-design\\52e95f6756e5",
      "source": "frontend-design@claude-plugins-official"
    },
    {
      "name": "playwright",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\playwright\\52e95f6756e5",
      "source": "playwright@claude-plugins-official"
    },
    {
      "name": "pua",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\pua-skills\\pua\\3.1.0",
      "source": "pua@pua-skills"
    },
    {
      "name": "rust-analyzer-lsp",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\rust-analyzer-lsp\\1.0.0",
      "source": "rust-analyzer-lsp@claude-plugins-official"
    },
    {
      "name": "supabase",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\supabase\\52e95f6756e5",
      "source": "supabase@claude-plugins-official"
    },
    {
      "name": "superpowers",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\superpowers\\5.0.7",
      "source": "superpowers@claude-plugins-official"
    },
    {
      "name": "typescript-lsp",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\claude-plugins-official\\typescript-lsp\\1.0.0",
      "source": "typescript-lsp@claude-plugins-official"
    }
  ],
  "fast_mode_state": "off"
}
```

### 2.3 字段详细说明

| 字段 | 类型 | 说明 | 前端用途 |
|------|------|------|---------|
| `cwd` | string | 当前工作目录 | 显示上下文 |
| `session_id` | string | 会话唯一 ID | 关联会话 |
| `tools[]` | string[] | **所有可用工具名称** | 工具权限管理面板 |
| `mcp_servers[]` | object[] | **MCP 服务器及状态** | MCP 状态监控 |
| `model` | string | 当前使用的模型 ID | 模型指示器 |
| `permissionMode` | string | 当前权限模式 | 权限指示器 |
| `slash_commands[]` | string[] | 所有斜杠命令/技能名 | 技能列表展示 |
| `apiKeySource` | string | API 密钥来源 | 安全信息 |
| `claude_code_version` | string | CLI 版本号 | 版本显示 |
| `output_style` | string | 输出风格 | 设置展示 |
| `agents[]` | string[] | **Agent ID 列表** | 动态 Agent 下拉 |
| `skills[]` | string[] | **去重技能列表** | 技能浏览面板 |
| `plugins[]` | object[] | **活跃插件** | 插件状态同步 |
| `fast_mode_state` | string | 快速模式状态 | 设置展示 |

### 2.4 tools[] 工具分类

```typescript
// 工具分类解析
function categorizeTools(tools: string[]): ToolCategories {
  const builtin: string[] = []
  const mcpTools: Map<string, string[]> = new Map()

  for (const tool of tools) {
    if (tool.startsWith('mcp__')) {
      // mcp__plugin_figma_figma__authenticate → plugin:figma:figma
      const parts = tool.split('__')
      const serverName = parts.slice(1, -1).join(':')
      if (!mcpTools.has(serverName)) mcpTools.set(serverName, [])
      mcpTools.get(serverName)!.push(tool)
    } else {
      builtin.push(tool)
    }
  }

  return { builtin, mcpTools }
}

// 示例输出:
// builtin: ["Task", "Bash", "Edit", "Read", "Write", "Grep", "Glob", ...]
// mcpTools: {
//   "plugin:figma:figma": ["authenticate", "complete_authentication"],
//   "plugin:supabase:supabase": ["authenticate", "complete_authentication"]
// }
```

### 2.5 mcp_servers[] 状态语义

| status | 含义 | UI 展示 | 操作 |
|--------|------|---------|------|
| `connected` | 服务器已连接，可用 | 🟢 已连接 | 无需操作 |
| `pending` | 正在连接中 | 🟡 连接中 | 等待 |
| `needs-auth` | 需要 OAuth 认证 | 🟠 需认证 | [认证] 按钮 |
| `error` | 连接失败 | 🔴 错误 | [重试] 按钮 |

---

## 三、result 事件数据结构

### 3.1 TypeScript 类型定义

```typescript
export interface StreamResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  duration_ms: number
  duration_api_ms: number
  num_turns: number
  result: string
  stop_reason: string
  session_id: string
  total_cost_usd: number
  usage: StreamUsage
  modelUsage: Record<string, ModelUsage>
  permission_denials: any[]
  terminal_reason: string
  fast_mode_state: 'on' | 'off'
}

export interface StreamUsage {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: {
    web_search_requests: number
    web_fetch_requests: number
  }
  service_tier: string
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string
  iterations: any[]
  speed: string
}

export interface ModelUsage {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}
```

### 3.2 result 数据的可视化价值

| 字段 | 可视化用途 |
|------|-----------|
| `total_cost_usd` | 消费统计面板 |
| `duration_ms` / `duration_api_ms` | 响应时间监控 |
| `num_turns` | 对话轮次统计 |
| `usage.input_tokens` / `output_tokens` | Token 消耗分析 |
| `usage.cache_read_input_tokens` | 缓存命中率分析 |
| `modelUsage` | 按模型分组的消耗统计 |
| `permission_denials` | 权限拒绝日志 |
| `stop_reason` | 停止原因分析 |

---

## 四、hook 事件数据结构

### 4.1 hook_started

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "uuid",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "uuid": "uuid",
  "session_id": "uuid"
}
```

### 4.2 hook_response

```json
{
  "type": "system",
  "subtype": "hook_response",
  "hook_id": "uuid",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart",
  "output": "...",
  "stdout": "...",
  "stderr": "...",
  "exit_code": 0,
  "outcome": "success",
  "uuid": "uuid",
  "session_id": "uuid"
}
```

**可视化价值**: 调试模式下展示 Hook 执行链路。

---

## 五、在 Polaris 中的集成方案

### 5.1 当前 stream 处理位置

```
src-tauri/src/ai/engine/claude.rs:
  - 启动 CLI 子进程 (L291-318)
  - 读取 stdout stream
  - 解析 stream-json 事件
  - 通过 Tauri event 发送到前端
```

### 5.2 需要新增的处理

```rust
// 在现有的 stream 解析逻辑中增加 init 事件处理
match event_type {
    "init" => {
        // 解析 init 事件
        let init_data: StreamInitEvent = serde_json::from_str(&line)?;
        // 通过 Tauri event 发送到前端
        app_handle.emit("cli:init", &init_data)?;
    },
    "assistant" => { /* 已有处理 */ },
    "result" => { /* 已有处理 */ },
    "hook_started" | "hook_response" => {
        // 可选：调试模式下发送到前端
        if debug_mode {
            app_handle.emit("cli:hook", &event)?;
        }
    },
    _ => {}
}
```

### 5.3 前端监听

```typescript
// 在 conversationStore 或 cliInfoStore 中
import { listen } from '@tauri-apps/api/event'

// 监听 init 事件
const unlisten = await listen<StreamInitEvent>('cli:init', (event) => {
  const data = event.payload
  useCliInfoStore.getState().updateFromInit({
    agents: data.agents,
    tools: data.tools,
    mcpServers: data.mcp_servers,
    skills: data.skills,
    model: data.model,
  })
})
```

---

## 六、数据获取策略最终建议

### 策略 C: 混合模式

```
┌─────────────────────────────────────────────────────┐
│ 启动阶段 (快速、低成本)                              │
│                                                       │
│ get_cli_version()        → 版本号                     │
│ get_cli_auth_status()    → 认证状态                   │
│ get_cli_agents()         → Agent 列表                 │
│                                                       │
│ 耗时: ~3-5 秒                                        │
│ 成本: $0 (无 API 调用)                               │
├─────────────────────────────────────────────────────┤
│ 首次会话 (自动补充，无额外成本)                       │
│                                                       │
│ stream-json init 事件:                                │
│   tools[]       → 可用工具列表                        │
│   mcp_servers[] → MCP 服务器状态                      │
│   skills[]      → 技能列表                           │
│   agents[]      → Agent 列表 (补充验证)               │
│   plugins[]     → 活跃插件 (补充验证)                 │
│                                                       │
│ 耗时: 随首次消息一起                                 │
│ 成本: $0 (init 是 stream 的副产品)                   │
├─────────────────────────────────────────────────────┤
│ 手动刷新                                             │
│                                                       │
│ 重新执行启动阶段命令                                 │
│                                                       │
│ 耗时: ~3-5 秒                                        │
│ 成本: $0                                             │
└─────────────────────────────────────────────────────┘
```

**核心优势**: 无需额外 API 调用即可获取全部动态数据。
