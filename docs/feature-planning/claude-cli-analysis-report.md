# Claude CLI 功能可视化分析报告

> 分析日期：2026-04-14
> 分析范围：Claude CLI v2.1.104 完整功能集
> 目标：识别适合 Polaris 可视化支持的功能缺口

---

## 一、Claude CLI 完整功能清单

### 1. 核心命令

| 命令 | 功能描述 | 交互特性 |
|------|---------|---------|
| `claude` | 启动交互式会话 | 需要 TTY |
| `claude -p/--print` | 非交互模式，输出后退出 | 无需 TTY |
| `claude -c/--continue` | 继续最近会话 | 需要 TTY |
| `claude -r/--resume [id]` | 恢复指定会话 | 交互选择器 |
| `claude --from-pr` | 从 PR 恢复会话 | 需要 TTY |

### 2. 子命令

| 子命令 | 功能 | 输出格式 |
|--------|------|---------|
| `claude auth` | 认证管理 | 交互式/JSON |
| `claude agents` | 列出配置的 Agent | 文本列表 |
| `claude mcp` | MCP 服务器管理 | 交互式/文本 |
| `claude plugin` | 插件管理 | 交互式/文本 |
| `claude doctor` | 健康检查 | 交互式 |
| `claude install` | 安装原生版本 | 文本 |
| `claude setup-token` | 设置长期令牌 | 交互式 |
| `claude update` | 更新检查 | 文本 |
| `claude auto-mode` | 自动模式配置 | JSON |

### 3. 关键参数

#### 3.1 会话控制

```
--session-id <uuid>          指定会话 ID
--fork-session               恢复时创建新会话 ID
-n, --name <name>            设置会话显示名称
--no-session-persistence     禁用会话持久化
```

#### 3.2 输出控制

```
--output-format <format>     输出格式：text | json | stream-json
--input-format <format>      输入格式：text | stream-json
--json-schema <schema>       JSON Schema 输出验证
--verbose                    详细输出模式
--brief                      简洁模式（agent-to-user 通信）
```

#### 3.3 权限控制

```
--permission-mode <mode>     权限模式：default | auto | bypassPermissions | plan | acceptEdits | dontAsk
--dangerously-skip-permissions  完全跳过权限检查
--allow-dangerously-skip-permissions  允许跳过但不默认启用
--allowed-tools <tools>      允许的工具列表
--disallowed-tools <tools>   禁止的工具列表
```

#### 3.4 上下文配置

```
--add-dir <dirs>             添加允许访问的目录
--system-prompt <prompt>     覆盖系统提示词
--append-system-prompt       追加系统提示词
--mcp-config <configs>       MCP 配置文件
--strict-mcp-config          仅使用指定的 MCP 配置
--settings <file|json>       设置文件或 JSON
--setting-sources <sources>  设置来源：user, project, local
--agent <agent>              指定 Agent
--agents <json>              自定义 Agent 定义
```

#### 3.5 模型配置

```
--model <model>              指定模型（sonnet/opus 或完整名称）
--fallback-model <model>     过载时回退模型
--effort <level>             努力级别：low | medium | high | max
--betas <betas>              Beta 功能头
```

#### 3.6 资源控制

```
--max-budget-usd <amount>    最大 API 费用限制
--tools <tools>              指定可用工具
--bare                       最小模式（跳过大部分初始化）
--worktree [name]            创建 Git worktree
--tmux                       创建 tmux 会话
```

#### 3.7 流事件控制

```
--include-hook-events        包含 hook 生命周期事件
--include-partial-messages   包含部分消息块
--replay-user-messages       重放用户消息确认
```

### 4. MCP 子命令

```
claude mcp list                      列出 MCP 服务器（含健康检查）
claude mcp add <name> <cmd>          添加 MCP 服务器
claude mcp add-json <name> <json>    添加 MCP 服务器（JSON）
claude mcp get <name>                获取 MCP 详情
claude mcp remove <name>             移除 MCP 服务器
claude mcp serve                     启动 Claude Code MCP Server
claude mcp add-from-claude-desktop   从 Claude Desktop 导入
claude mcp reset-project-choices     重置项目级 MCP 选择
```

### 5. Plugin 子命令

```
claude plugin list                   列出已安装插件
claude plugin install <plugin>       安装插件
claude plugin enable <plugin>        启用插件
claude plugin disable <plugin>       禁用插件
claude plugin update <plugin>        更新插件
claude plugin uninstall <plugin>     卸载插件
claude plugin validate <path>        验证插件/市场清单
claude plugin marketplace list       列出市场
claude plugin marketplace add        添加市场
claude plugin marketplace remove     移除市场
claude plugin marketplace update     更新市场
```

### 6. Auth 子命令

```
claude auth login [--claudeai|--console] [--email] [--sso]
claude auth logout
claude auth status [--json|--text]
```

### 7. Auto-mode 子命令

```
claude auto-mode config              输出当前配置
claude auto-mode defaults            输出默认规则
claude auto-mode critique            AI 反馈自定义规则
```

---

## 二、输出数据结构分析

### 1. stream-json 格式

#### 1.1 初始化事件

```json
{
  "type": "system",
  "subtype": "init",
  "cwd": "D:\\space\\base\\Polaris",
  "session_id": "uuid",
  "tools": ["Task", "Bash", "Edit", ...],
  "mcp_servers": [
    {"name": "plugin:figma:figma", "status": "needs-auth"},
    {"name": "plugin:playwright:playwright", "status": "connected"}
  ],
  "model": "GLM-5",
  "permissionMode": "default",
  "slash_commands": ["loop", "claude-api", ...],
  "apiKeySource": "none",
  "agents": ["general-purpose", "Explore", ...],
  "skills": [...],
  "plugins": [...]
}
```

#### 1.2 Hook 事件

```json
{
  "type": "system",
  "subtype": "hook_started",
  "hook_id": "uuid",
  "hook_name": "SessionStart:startup",
  "hook_event": "SessionStart"
}
```

#### 1.3 结果事件

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 3605,
  "duration_api_ms": 3388,
  "num_turns": 1,
  "result": "response text",
  "stop_reason": "end_turn",
  "session_id": "uuid",
  "total_cost_usd": 0.16135,
  "usage": {
    "input_tokens": 32235,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0,
    "output_tokens": 7
  },
  "modelUsage": {...},
  "permission_denials": [],
  "terminal_reason": "completed"
}
```

### 2. JSON 格式（单次）

```json
{
  "type": "result",
  "subtype": "success",
  "result": "response",
  "session_id": "uuid",
  "total_cost_usd": 0.188605,
  "usage": {...}
}
```

### 3. 配置文件格式

#### 3.1 settings.json

```json
{
  "enabledPlugins": {...},
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "...",
    "ANTHROPIC_BASE_URL": "...",
    "ANTHROPIC_MODEL": "GLM-5"
  },
  "extraKnownMarketplaces": {...},
  "model": "glm-5"
}
```

#### 3.2 history.jsonl

```json
{"display":"用户消息","pastedContents":{},"timestamp":1770907779509,"project":"path","sessionId":"uuid"}
```

#### 3.3 会话存储

```jsonl
{"type":"queue-operation","operation":"enqueue","timestamp":"...","sessionId":"...","content":"..."}
{"type":"queue-operation","operation":"dequeue","timestamp":"...","sessionId":"..."}
```

---

## 三、Polaris 现有实现对照

| 功能 | CLI 命令/参数 | Polaris 状态 | 实现位置 |
|------|-------------|-------------|---------|
| 发送消息 | `claude -p` | 已实现 | `chat.rs:start_chat` |
| 流式响应 | `--output-format stream-json` | 已实现 | 事件监听 |
| 继续会话 | `--resume` | 已实现 | `continue_chat` |
| 中断对话 | - | 已实现 | `interrupt_chat` |
| 系统提示词 | `--system-prompt` | 已实现 | 设置页 |
| MCP 工具 | `--mcp-config` | 已实现 | 配置生成 |
| Plan 模式 | `--permission-mode plan` | 已实现 | 事件处理 |
| 权限请求 | - | 已实现 | UI 确认框 |
| Git 操作 | - | 已实现 | GitPanel |
| 会话历史 | - | 已实现 | 历史面板 |
| 多会话并行 | - | 已实现 | Store 架构 |

---

## 四、功能缺口分析

### 1. 未实现的高价值功能

| 功能 | CLI 支持 | 用户价值 | 实现复杂度 |
|------|---------|---------|-----------|
| **Plugin 管理** | `claude plugin` | 高 | 中 |
| **MCP 可视化配置** | `claude mcp` | 高 | 中 |
| **Agent 选择器** | `--agent`, `claude agents` | 高 | 低 |
| **认证管理** | `claude auth` | 中 | 中 |
| **模型切换** | `--model`, `--effort` | 中 | 低 |
| **工具权限可视化** | `--allowed-tools` | 中 | 中 |
| **费用预算控制** | `--max-budget-usd` | 中 | 低 |
| **会话 Fork** | `--fork-session` | 中 | 低 |
| **Worktree 管理** | `--worktree` | 中 | 中 |
| **Auto-mode 规则编辑** | `claude auto-mode` | 低 | 高 |
| **Hook 配置** | hook 事件 | 低 | 高 |

### 2. 可视化增强机会

| 场景 | 当前状态 | 改进方向 |
|------|---------|---------|
| 插件管理 | 无 | 插件市场浏览、安装、启用/禁用 |
| MCP 配置 | 文件编辑 | 可视化添加/编辑 MCP Server |
| Agent 选择 | 无 | Agent 选择器 UI |
| 模型配置 | 固定 | 模型/努力级别选择器 |
| 工具权限 | bypass | 工具白名单/黑名单配置 |
| 费用追踪 | 无 | 实时费用显示、预算设置 |
| 会话管理 | 基础 | Fork、命名、标签 |

---

## 五、优先级评估

### 第一优先级（核心功能补全）

1. **Plugin 管理面板** - 插件是扩展核心
2. **MCP 可视化配置** - MCP 是工具扩展核心
3. **Agent 选择器** - 影响执行质量

### 第二优先级（体验增强）

4. **模型/努力级别选择** - 日常使用频繁
5. **工具权限可视化** - 安全性提升
6. **费用追踪面板** - 成本控制

### 第三优先级（高级功能）

7. **认证管理 UI** - 账号相关
8. **会话 Fork/命名** - 高级会话管理
9. **Worktree 集成** - 开发流程

---

## 六、实现路径建议

### Phase 1: 插件管理

```
CLI: claude plugin list/install/enable/disable/update
UI:  插件市场面板 + 已安装列表 + 操作按钮
API: Tauri command 封装 CLI 调用
```

### Phase 2: MCP 可视化

```
CLI: claude mcp list/add/remove/get
UI:  MCP 配置面板 + 表单添加 + 健康状态显示
API: Tauri command 封装 + 配置文件读写
```

### Phase 3: Agent 选择器

```
CLI: claude agents / --agent <name>
UI:  Agent 下拉选择器 + 描述显示
API: 解析 agents 输出 + 传递参数
```

### Phase 4: 模型配置

```
CLI: --model <model> / --effort <level>
UI:  模型选择下拉 + 努力级别滑块
API: 参数传递
```

### Phase 5: 费用追踪

```
数据: stream-json result.total_cost_usd
UI:   会话费用显示 + 预算设置 + 统计面板
API:  解析 usage 数据
```

---

## 七、技术可行性

| 功能 | CLI 输出格式 | 解析难度 | UI 复杂度 |
|------|------------|---------|----------|
| Plugin 管理 | 文本列表 | 低 | 中 |
| MCP 管理 | 文本列表 + JSON | 中 | 中 |
| Agent 列表 | 文本列表 | 低 | 低 |
| 模型配置 | 参数传递 | 低 | 低 |
| 费用数据 | JSON | 低 | 低 |
| 认证状态 | JSON | 低 | 中 |

---

## 八、下一步行动

1. 为每个优先功能创建详细的规划文档
2. 设计 UI 原型
3. 实现后端 API 封装
4. 逐步集成到现有界面

---

*报告生成：Claude Code 分析任务*
