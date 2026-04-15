# Claude CLI 命令全景分析（深度修订版）

**CLI 版本**: 2.1.104 (Claude Code)
**分析日期**: 2026-04-15
**版本**: v2.0 — 基于 `--print --output-format stream-json` 实测数据修订

---

## 一、命令体系总览

```
claude [全局选项] [子命令] [子命令参数]
```

### 层级关系

```
claude (root)
├── [无子命令] → 启动交互式会话
├── agents          → 列出已配置的 Agent
├── auth            → 认证管理
│   ├── login       → 登录 (--claudeai / --console / --sso)
│   ├── logout      → 登出
│   └── status      → 状态查询 (JSON 输出)
├── auto-mode       → 自动模式配置
│   ├── config      → 查看生效配置 (JSON 输出)
│   ├── critique    → AI 审查自定义规则 (需模型调用)
│   └── defaults    → 查看默认规则 (JSON 输出)
├── doctor          → 健康检查 (需交互式终端)
├── install         → 安装/更新原生构建 (stable/latest/版本号)
├── mcp             → MCP 服务器管理
│   ├── add         → 添加 MCP 服务器 (stdio/http/sse)
│   ├── add-from-claude-desktop → 从桌面版导入 (Mac/WSL)
│   ├── add-json    → JSON 方式添加
│   ├── get         → 查看服务器详情
│   ├── list        → 列出所有服务器 (含健康检查)
│   ├── remove      → 移除服务器
│   ├── reset-project-choices → 重置项目级选择
│   └── serve       → 启动为 MCP 服务器
├── plugin/plugins  → 插件管理
│   ├── install     → 安装插件 (user/project/local scope)
│   ├── uninstall   → 卸载插件 (--keep-data 可保留数据)
│   ├── enable      → 启用插件
│   ├── disable     → 禁用插件 (--all 可禁用全部)
│   ├── update      → 更新插件
│   ├── list        → 列出已安装插件 (支持 --json)
│   ├── marketplace → 市场管理 (add/list/remove/update)
│   └── validate    → 验证插件/市场清单
├── setup-token     → 设置长期认证令牌
└── update/upgrade  → 检查并安装更新
```

---

## 二、全局选项分类详解

### 2.1 会话控制类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `-c, --continue` | flag | 继续最近的会话 | P0 — 已实现 |
| `-r, --resume [value]` | flag+value | 按 ID 恢复会话，支持搜索 | P0 — 已实现 |
| `--session-id <uuid>` | value | 指定会话 UUID | P2 |
| `--fork-session` | flag | 恢复时创建新会话 | P2 |
| `--from-pr [value]` | flag+value | 恢复 PR 关联的会话 | P2 |
| `-n, --name <name>` | value | 设置会话显示名称 | P1 — 未实现 |
| `--no-session-persistence` | flag | 禁用会话持久化 | P2 |

### 2.2 模型与 Agent 类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `--model <model>` | value | 模型选择 (sonnet/opus/haiku/全名) | P0 — 硬编码 |
| `--agent <agent>` | value | Agent 选择 (id 匹配) | P0 — 硬编码 |
| `--effort <level>` | enum | 努力级别 (low/medium/high/max) | P1 — 已实现但缺 max |
| `--agents <json>` | json | 自定义 Agent 定义 | P2 |

### 2.3 权限与安全类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `--permission-mode <mode>` | enum | 权限模式 (6种) | P0 — 已实现 |
| `--allowedTools <tools>` | list | 白名单工具 | P1 — 未实现 |
| `--disallowedTools <tools>` | list | 黑名单工具 | P1 — 未实现 |
| `--tools <tools>` | list | 指定可用工具集 | P1 — 未实现 |
| `--dangerously-skip-permissions` | flag | 跳过所有权限 | P2 |
| `--allow-dangerously-skip-permissions` | flag | 允许跳过权限选项 | P2 |

### 2.4 输入输出类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `-p, --print` | flag | 非交互模式 | P0 — 后端已用 |
| `--output-format <format>` | enum | 输出格式 (text/json/stream-json) | P0 — 已用 |
| `--input-format <format>` | enum | 输入格式 (text/stream-json) | P1 |
| `--json-schema <schema>` | json | 结构化输出验证 | P2 |
| `--verbose` | flag | 详细模式 (stream-json 必需) | P1 |
| `--brief` | flag | 简洁模式 | P1 |
| `--include-partial-messages` | flag | 包含部分消息块 | P2 |
| `--include-hook-events` | flag | 包含钩子事件 | P2 |
| `--replay-user-messages` | flag | 重放用户消息 | P2 |

### 2.5 系统配置类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `--system-prompt <prompt>` | value | 系统提示词 | P1 — 已实现 |
| `--append-system-prompt <prompt>` | value | 追加系统提示词 | P1 — 已实现 |
| `--settings <file-or-json>` | value | 设置文件或 JSON | P1 |
| `--setting-sources <sources>` | value | 设置来源过滤 | P2 |
| `--mcp-config <configs>` | list | MCP 配置文件 | P1 |
| `--strict-mcp-config` | flag | 仅使用指定 MCP | P2 |
| `--add-dir <dirs>` | list | 额外目录访问 | P1 |

### 2.6 运行环境类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `-w, --worktree [name]` | flag+value | 创建 Git Worktree | P1 |
| `--tmux` | flag | 创建 Tmux 会话 (需 --worktree) | P2 |
| `--bare` | flag | 最小化模式 | P2 |
| `--chrome` / `--no-chrome` | flag | Chrome 集成开关 | P2 |
| `--ide` | flag | IDE 自动连接 | P2 |
| `-d, --debug [filter]` | flag+value | 调试模式 (支持分类过滤) | P2 |
| `--debug-file <path>` | value | 调试日志文件 | P2 |

### 2.7 资源控制类

| 选项 | 类型 | 说明 | 可视化优先级 |
|------|------|------|-------------|
| `--max-budget-usd <amount>` | value | 最大预算 (USD) | P1 |
| `--fallback-model <model>` | value | 备用模型 (仅 --print) | P2 |
| `--betas <betas>` | list | Beta 功能标志 | P2 |
| `--file <specs>` | list | 文件资源下载 (file_id:path) | P2 |
| `--disable-slash-commands` | flag | 禁用所有 skills | P2 |

---

## 三、关键发现：stream-json 初始化数据

> **这是本次分析最重要的发现。** `claude -p --output-format stream-json --verbose` 会在第一条消息中输出完整的 `init` 事件，包含所有动态数据的结构化 JSON。

### 3.1 init 事件完整数据结构

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "D:\\space\\base\\Polaris",
  "session_id": "uuid-string",
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
    "pua:flavor", "pua:cancel-pua-loop", "pua:kpi", ...
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
    "update-config", "debug", "simplify", ...
  ],
  "plugins": [
    {
      "name": "figma",
      "path": "C:\\Users\\28409\\.claude\\plugins\\cache\\...\\figma\\2.0.7",
      "source": "figma@claude-plugins-official"
    },
    ...
  ],
  "fast_mode_state": "off"
}
```

### 3.2 init 数据对可视化的价值

| 字段 | 可视化用途 | 现有方案 |
|------|-----------|---------|
| `agents[]` | **动态 Agent 列表** — 替代硬编码 | 硬编码 4 个 |
| `model` | 当前使用的模型名 | 硬编码 |
| `tools[]` | **可用工具完整列表** — 工具权限管理 | 无 |
| `mcp_servers[]` | **MCP 服务器状态** — 含连接状态 | 仅在 PluginTab 中展示 |
| `slash_commands[]` | 可用 skills 列表 | 无 |
| `skills[]` | 去重后的 skills 列表 | 无 |
| `plugins[]` | 活跃插件列表 + 路径 + 来源 | 有但格式不同 |
| `permissionMode` | 当前权限模式 | 已有 |
| `claude_code_version` | CLI 版本号 | 已有 |
| `apiKeySource` | API 密钥来源 | 无 |
| `fast_mode_state` | 快速模式状态 | 无 |
| `session_id` | 当前会话 ID | 已有 |
| `output_style` | 输出风格 | 无 |

### 3.3 其他 stream-json 事件类型

| type | subtype | 说明 | 可视化价值 |
|------|---------|------|-----------|
| `system` | `hook_started` | Hook 开始执行 | 调试面板 |
| `system` | `hook_response` | Hook 执行结果 (含输出) | 调试面板 |
| `system` | `init` | 会话初始化数据 | **核心数据源** |
| `assistant` | - | AI 回复消息 (含 thinking/text) | 已实现 |
| `result` | `success` / `error` | 最终结果 (含 cost/usage) | 已实现 |

### 3.4 result 事件完整数据结构

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 10285,
  "duration_api_ms": 9211,
  "num_turns": 1,
  "result": "回复内容...",
  "stop_reason": "end_turn",
  "session_id": "uuid",
  "total_cost_usd": 0.068314,
  "usage": {
    "input_tokens": 11149,
    "cache_creation_input_tokens": 0,
    "cache_read_input_tokens": 18688,
    "output_tokens": 129,
    "server_tool_use": {
      "web_search_requests": 0,
      "web_fetch_requests": 0
    },
    "service_tier": "standard",
    "cache_creation": {
      "ephemeral_1h_input_tokens": 0,
      "ephemeral_5m_input_tokens": 0
    },
    "inference_geo": "",
    "iterations": [],
    "speed": "standard"
  },
  "modelUsage": {
    "glm-5.1": {
      "inputTokens": 11149,
      "outputTokens": 129,
      "cacheReadInputTokens": 18688,
      "cacheCreationInputTokens": 0,
      "webSearchRequests": 0,
      "costUSD": 0.068314,
      "contextWindow": 200000,
      "maxOutputTokens": 32000
    }
  },
  "permission_denials": [],
  "terminal_reason": "completed",
  "fast_mode_state": "off"
}
```

---

## 四、各子命令实测输出详解

### 4.1 `claude agents` — Agent 列表

**命令**: `claude agents` / `claude agents --setting-sources <sources>`
**输出格式**: 纯文本（无 JSON 选项）
**实测输出**:

```
8 active agents

Plugin agents:
  pua:cto-p10 · opus
  pua:senior-engineer-p7 · inherit
  pua:tech-lead-p9 · inherit
  superpowers:code-reviewer · inherit

Built-in agents:
  Explore · haiku
  general-purpose · inherit
  Plan · inherit
  statusline-setup · sonnet
```

**解析规则**:
- 第一行: `(\d+) active agents` → 提取总数
- 分组标识: `Plugin agents:` / `Built-in agents:`
- Agent 行: `^\s{2}(\S+)\s+·\s+(\S+)$` → name, defaultModel
- 模型值: `opus` / `haiku` / `sonnet` / `inherit`（继承默认）

**关键问题**:
- 无 JSON 输出选项，必须文本解析
- `inherit` 表示继承会话默认模型，不是独立模型名
- Agent ID 格式不统一: 内置用简名 (`Explore`)，插件用 `plugin:agent` 格式

---

### 4.2 `claude auth status` — 认证状态

**命令**: `claude auth status`
**输出格式**: JSON
**实测输出**:

```json
{
  "loggedIn": true,
  "authMethod": "oauth_token",
  "apiProvider": "firstParty"
}
```

**字段说明**:

| 字段 | 类型 | 说明 | 可视化 |
|------|------|------|--------|
| `loggedIn` | boolean | 是否已登录 | 状态指示灯 |
| `authMethod` | string | 认证方式: `oauth_token` / `api_key` | 显示认证类型 |
| `apiProvider` | string | API 提供商: `firstParty` / `bedrock` / `vertex` | 显示提供商 |

---

### 4.3 `claude mcp list` — MCP 服务器列表

**命令**: `claude mcp list`
**输出格式**: 纯文本（含交互式健康检查）
**实测输出**:

```
Checking MCP server health...

plugin:figma:figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
plugin:playwright:playwright: npx @playwright/mcp@latest - ✓ Connected
plugin:supabase:supabase: https://mcp.supabase.com/mcp (HTTP) - ! Needs authentication
chrome-devtools: cmd /c npx chrome-devtools-mcp@latest - ✓ Connected
```

**解析规则**:
- 名称: `^(\S+):`
- 类型标识: `(HTTP)` / `(SSE)` / 无标记则默认 stdio
- 命令/URL: 名称和类型之间的文本
- 状态: `✓ Connected` / `! Needs authentication` / `✗ Error`

**关键发现**:
- **插件管理的 MCP 无法通过 `claude mcp get/remove` 操作**
  - `claude mcp get plugin:figma:figma` → `No MCP server found with name: plugin:figma:figma`
  - 插件管理的 MCP 只能通过插件的启用/禁用来控制
- **用户手动添加的 MCP 可以正常管理**
  - `claude mcp get chrome-devtools` → 正常返回详情
- 执行时会触发健康检查，可能耗时数秒

---

### 4.4 `claude mcp get <name>` — MCP 服务器详情

**命令**: `claude mcp get chrome-devtools`
**输出格式**: 纯文本
**实测输出**:

```
chrome-devtools:
  Scope: User config (available in all your projects)
  Status: ✓ Connected
  Type: stdio
  Command: cmd
  Args: /c npx chrome-devtools-mcp@latest
  Environment:

To remove this server, run: claude mcp remove "chrome-devtools" -s user
```

**解析规则**:
- 名称: 第一行 `(\S+):`
- Scope: `Scope:\s+(.+)`
- Status: `Status:\s+(.+)`
- Type: `Type:\s+(stdio|http|sse)`
- Command: `Command:\s+(.+)`
- Args: `Args:\s+(.+)`
- Environment: 后续行为空则为空，否则为 KEY=VALUE 列表

---

### 4.5 `claude plugin list` — 插件列表

**命令**: `claude plugin list` / `claude plugin list --json`
**输出格式**: 支持 `--json`
**实测 JSON 输出** (简化):

```json
[
  {
    "id": "figma@claude-plugins-official",
    "version": "2.0.7",
    "scope": "user",
    "enabled": true,
    "installPath": "C:\\Users\\28409\\.claude\\plugins\\cache\\...\\figma\\2.0.7",
    "installedAt": "2026-04-03T16:38:55.885Z",
    "lastUpdated": "2026-04-14T15:12:46.292Z",
    "mcpServers": {
      "figma": {
        "type": "http",
        "url": "https://mcp.figma.com/mcp"
      }
    }
  }
]
```

**字段说明**:

| 字段 | 说明 | 可视化 |
|------|------|--------|
| `id` | 插件 ID (格式: name@marketplace) | 名称展示 |
| `version` | 版本号 | 版本显示 |
| `scope` | 作用域: user/project/local | 作用域标签 |
| `enabled` | 是否启用 | 开关状态 |
| `installPath` | 安装路径 | 高级信息 |
| `installedAt` | 安装时间 | 高级信息 |
| `lastUpdated` | 最后更新时间 | 更新提示 |
| `mcpServers` | MCP 服务器配置 (可选) | MCP 管理关联 |
| `projectPath` | 项目路径 (仅 local scope) | 项目关联 |

---

### 4.6 `claude auto-mode defaults` / `config` — 自动模式规则

**输出格式**: JSON
**数据结构**:

```json
{
  "allow": ["规则名: 规则描述", ...],
  "soft_deny": ["规则名: 规则描述", ...],
  "environment": ["环境描述", ...]
}
```

**规则格式**: `"CategoryName: Detailed description"`

**分类** (从实测数据提取):
- allow: Test Artifacts, Local Operations, Read-Only, Declared Dependencies, Toolchain Bootstrap, Standard Credentials, Git Push to Working Branch, Memory Directory
- soft_deny: Git Destructive, Git Push to Default Branch, Code from External, Cloud Storage Mass Delete, Production Deploy, Remote Shell Writes, Production Reads, Blind Apply, Logging/Audit Tampering, Permission Grant, TLS/Auth Weaken, Security Weaken, Create Unsafe Agents, Interfere With Others, Modify Shared Resources, Irreversible Local Destruction, Create RCE Surface, Expose Local Services, Credential Leakage, Credential Exploration, Data Exfiltration, Exfil Scouting, Trusting Guessed External Services, Create Public Surface, Untrusted Code Integration, Unauthorized Persistence, Self-Modification, Memory Poisoning, External System Writes, Content Integrity / Impersonation, Real-World Transactions

---

## 五、命令输出格式总结

| 命令 | 输出格式 | JSON 支持 | 解析难度 |
|------|---------|----------|---------|
| `claude agents` | 文本 | ❌ | 中 — 正则解析 |
| `claude auth status` | JSON | ✅ 原生 | 低 — 直接反序列化 |
| `claude mcp list` | 文本+状态 | ❌ | 中 — 正则 + 状态符号 |
| `claude mcp get <name>` | 文本 | ❌ | 低 — key-value 格式 |
| `claude plugin list` | 文本/JSON | ✅ `--json` | 低 |
| `claude plugin marketplace list` | 文本/JSON | ✅ `--json` | 低 |
| `claude auto-mode config` | JSON | ✅ 原生 | 低 |
| `claude auto-mode defaults` | JSON | ✅ 原生 | 低 |
| `claude -p --output-format stream-json` | NDJSON | ✅ 原生 | 低 — **核心数据源** |
| `claude -p --output-format json` | JSON | ✅ 原生 | 低 |

---

## 六、数据获取策略建议

### 策略 A: 独立命令模式（当前方案）

逐个调用 CLI 命令获取数据:
```
claude agents → 解析文本
claude auth status → 解析 JSON
claude mcp list → 解析文本
claude plugin list --json → 解析 JSON
```

**优点**: 精确、按需获取
**缺点**: 多次进程启动、文本解析脆弱、无 MCP 状态

### 策略 B: stream-json 初始化模式（推荐）

启动一次短会话获取 init 事件:
```bash
echo "" | claude -p --output-format stream-json --verbose "say ok"
```

**优点**: 一次调用获取全部数据 (agents, tools, mcp_servers, plugins, skills, model, version)
**缺点**: 需要启动完整会话、有 API 成本、耗时较长

### 策略 C: 混合模式（最佳方案）

```
启动时: 策略 A 快速获取 (agents, auth status)
首条消息时: 从 stream-json init 事件补充 (tools, mcp_servers, skills)
定期/手动: 策略 A 刷新特定数据
```

**优点**: 启动快 + 数据完整
**缺点**: 实现复杂度略高
