# SimpleAI 架构与扩展指南

> SimpleAI 是 Polaris 内置的轻量 AI 引擎，直连用户配置的 OpenAI 兼容 API，无需外部 CLI。
> 本文档讲解其 MCP / Skill / Agent / Subagent 等能力的实现机制与扩展方法。
>
> 关联文档：
> - `docs/simple-ai-codex-refactor-plan.md` —— Phase 0/1/2 基础重构（对话/工具/身份/项目指令）
> - `docs/simple-ai-power-up-plan.md` —— 能力跃升方案与决策记录

---

## 1. 能力概览

| 能力 | 实现位置 | 状态 |
|---|---|---|
| 流式对话（三协议） | `simple_ai/chat_loop.rs` + `simple_ai_protocol.rs` | ✅ |
| 内置工具（9+1） | `simple_ai/tools/{bash,fs,search,apply_patch,plan,skill,agent,computer}.rs` | ✅ |
| MCP 工具消费（内置 + 插件） | `simple_ai/mcp/` + `commands/chat.rs` | ✅ |
| Skill（progressive disclosure） | `simple_ai/skill.rs` + `tools/skill.rs` | ✅ |
| Agent preset | `simple_ai/agent.rs` + `mod.rs` | ✅ |
| Subagent（dispatch_agent） | `tools/agent.rs` | ✅ |
| Retry 指数退避 | `simple_ai/retry.rs` | ✅ |
| Token usage 统计 | `simple_ai_protocol.rs` | ✅ |
| 上下文压缩 | `simple_ai/compact.rs` | ✅ |
| 项目指令注入 | `simple_ai/context.rs`（AGENTS.md/CLAUDE.md） | ✅ |

---

## 2. 架构总览

```
                        ┌─────────────────────────────────────────┐
                        │           SimpleAIEngine                │
                        │  (mod.rs: 会话表 / profile / 启动)       │
                        └────────────────┬────────────────────────┘
                                         │
                ┌────────────────────────┼─────────────────────────┐
                │                        │                         │
        ┌───────▼────────┐    ┌──────────▼──────────┐    ┌────────▼─────────┐
        │  prompt.rs     │    │   chat_loop.rs       │    │  context.rs      │
        │  persona +     │    │  retry/compact/      │    │  env_context +   │
        │  skill/agent   │    │  usage/mcp/dispatch  │    │  AGENTS/CLAUDE + │
        │  overlay       │    │                      │    │  skill 索引注入  │
        └────────────────┘    └──────────┬──────────┘    └──────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │  ToolRegistry       │
                              │  (async Tool trait) │
                              └──────────┬──────────┘
                                         │
            ┌────────────────────────────┼────────────────────────────┐
            │                            │                            │
    ┌───────▼───────┐         ┌──────────▼──────────┐      ┌──────────▼──────────┐
    │ 内置工具      │         │  McpClientPool      │      │  DispatchAgentTool  │
    │ (bash/fs/     │         │  (内置 + 插件 MCP)  │      │  (spawn 子会话)     │
    │  search/      │         │                     │      │                     │
    │  apply_patch/ │         │  mcp__{srv}__{tool} │      │                     │
    │  plan/skill/  │         └──────────┬──────────┘      └─────────────────────┘
    │  agent/computer)│                  │
    └───────────────┘         ┌──────────▼──────────┐
                              │  mcp/ (client)      │
                              │  stdio JSON-RPC     │
                              └──────────┬──────────┘
                                         │ spawn + stdin/stdout
              ┌──────────────────────────┼──────────────────────────┐
              │                          │                          │
       ┌──────▼───┐             ┌────────▼────────┐         ┌──────▼──────┐
       │ 内置 MCP │             │ 插件 MCP        │         │ 用户 .mcp   │
       │ todo/    │             │ bb-browser/...  │         │ (CLI 引擎)  │
       │ req/...  │             │                 │         │             │
       └──────────┘             └─────────────────┘         └─────────────┘
```

**核心设计**：SimpleAI 在 Rust 进程内自研 stdio MCP client，直接 spawn MCP server 子进程消费其工具，不依赖外部 CLI。

---

## 3. MCP 实现详解

### 3.1 为什么需要自研 client

Polaris 的所有功能（todo/requirements/scheduler/computer/ask/prd-preview）与第三方插件（如 `bb-browser`）都以 **stdio MCP server** 形式贡献工具。Claude/codex CLI 内置 MCP client，能直接消费；SimpleAI 没有 CLI 外壳，必须在 Rust 进程内自研 client。

### 3.2 MCP 协议基础

MCP（Model Context Protocol）基于 JSON-RPC 2.0，stdio 传输：

- **帧格式**：每行一条 JSON-RPC 消息（换行分隔，非 LSP 的 `Content-Length`）
- **握手**：client 发 `initialize`（含 `protocolVersion`）→ server 返回 `result`（含协商后的 `protocolVersion`）→ client 发 `notifications/initialized`
- **工具发现**：client 发 `tools/list` → server 返回 `{tools: [{name, description, inputSchema}]}`
- **工具调用**：client 发 `tools/call {name, arguments}` → server 返回 `{content: [{type:"text", text}], isError}`

### 3.3 实现分层

```
simple_ai/mcp/
├── types.rs     # JSON-RPC envelope + MCP 类型
├── client.rs    # McpClient：单 server 连接
└── mod.rs       # McpClientPool：聚合 + 路由
```

#### `types.rs` —— 协议类型

```rust
pub(crate) struct JsonRpcRequest<'a> { pub jsonrpc: &'a str, pub id: Option<u64>, pub method: &'a str, pub params: Option<Value> }
pub(crate) struct JsonRpcResponse { pub id: Option<Value>, pub result: Option<Value>, pub error: Option<JsonRpcError> }
pub(crate) struct McpTool { pub name: String, pub description: Option<String>, pub input_schema: Option<Value> }
pub(crate) struct McpCallResult { pub content: Vec<McpContentBlock>, pub is_error: bool }
```

#### `client.rs` —— `McpClient`（单连接）

**生命周期**：`spawn` → `initialize` 握手 → `tools/list` 缓存 → 多次 `call_tool` → `Drop` kill 子进程。

**关键机制**：
- `tokio::process::Command` spawn 子进程，捕获 stdin/stdout
- **stdout reader task**：逐行 `read_line` → 解析 JSON-RPC → 按 `id` 路由到 `pending: HashMap<u64, oneshot::Sender>`
- **请求/响应配对**：`call_method` 分配 `id`，插入 `pending`，写入 stdin，`await` oneshot（30s 超时）
- **通知**：`send_notification`（无 `id`，不等待响应）

```rust
pub(crate) async fn spawn(server_name, command, args, env) -> Result<Self> {
    // 1. spawn 子进程 + 捕获 stdin/stdout
    // 2. 启动 reader task
    // 3. initialize（protocolVersion: "2025-06-18"，读 server 返回值降级）
    // 4. notifications/initialized
    // 5. tools/list 缓存
}

pub(crate) async fn call_tool(&self, name, args) -> Result<McpCallResult> {
    // tools/call {name, arguments} → 解析 result
}
```

**Windows 注意**：`creation_flags(CREATE_NO_WINDOW)` 避免子进程弹窗。

#### `mod.rs` —— `McpClientPool`（聚合）

**职责**：会话级聚合多个 MCP server，缓存工具列表，按 `mcp__{server}__{tool}` 命名路由调用。

```rust
pub(crate) struct McpClientPool {
    clients: HashMap<String, Arc<McpClient>>,           // server_name → client
    tool_index: HashMap<String, (String, String)>,      // mcp__srv__tool → (server, tool)
    cached_specs: Vec<Value>,                           // OpenAI function spec（spawn 后固定）
}
```

**命名约定**：`mcp__{server_name}__{tool_name}`，避免与内置工具冲突，且可解析前缀路由。

**工具 schema 转换**：MCP 的 `inputSchema`（JSON Schema）直接包成 OpenAI function spec：

```rust
fn mcp_tool_to_spec(mcp_name: &str, tool: &McpTool) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": mcp_name,                          // mcp__srv__tool
            "description": tool.description,
            "parameters": tool.input_schema.unwrap_or(default_object_schema),
        }
    })
}
```

### 3.4 桥接：配置 → SimpleAI

#### `mcp_config_service.rs` —— `resolved_simple_ai_servers()`

合并**内置 MCP**（todo/req/scheduler/prd-preview/computer/ask）+ **外部插件 MCP**，输出 `Vec<ResolvedExternalMcpServer>`：

```rust
pub fn resolved_simple_ai_servers(&self, workspace_path, disabled) -> Vec<ResolvedExternalMcpServer> {
    // 内置：遍历 self.binaries（ResolvedMcpBinary），检查 executable_path.exists()，
    //       build_mcp_server_args(args_mode, ...) 生成 args，plugin_id = "polaris.builtin"
    // 外部：遍历 self.external_servers，同名校验（内置优先），plugin_id = 插件 ID
    // 两者都过滤 disabled_server_names
}
```

**内置 MCP binary 解析**（`resolve_mcp_executable_path`）按优先级查找：
1. bundled resource 目录（`bin/polaris-todo-mcp.exe`）
2. 环境变量覆盖（`POLARIS_TODO_MCP_PATH`）
3. dev 目录（`src-tauri/target/debug/polaris-todo-mcp.exe`）
4. release 目录（`src-tauri/target/release/...`）

#### `commands/chat.rs` —— SimpleAI 分支

```rust
EngineId::SimpleAI => {
    let mut servers = service.resolved_simple_ai_servers(work_dir, &disabled_servers);
    // aiToolAccess 门控：内置（plugin_id="polaris.builtin"）总放行；外部检查 aiToolAccess
    servers.retain(|s| {
        if s.plugin_id == "polaris.builtin" { return true; }
        plugins.iter().find(|p| p.id == s.plugin_id)
            .map(|p| p.permissions.ai_tool_access.unwrap_or(false))
            .unwrap_or(false)
    });
    Ok(PreparedMcpConfig { simple_ai_mcp_servers: Some(servers), .. })
}
```

**门控策略**（决策 §12-7）：只对 SimpleAI 路径过滤 `aiToolAccess`，CLI 引擎行为不变。

### 3.5 工具注册表接入

`ToolRegistry` 持有 `mcp_pool: Option<Arc<McpClientPool>>`：

```rust
pub(super) async fn dispatch(&self, name, args, ctx) -> ToolOutcome {
    match self.tools.iter().find(|t| t.name() == name) {
        Some(tool) => tool.execute(args, ctx).await,          // 内置工具优先
        None => {
            if let Some(pool) = &self.mcp_pool {
                if McpClientPool::parse_tool_name(name).is_some() {
                    return pool.call(name, args).await;        // mcp__ 前缀路由
                }
            }
            ToolOutcome::fail(format!("Unknown tool: {}", name))
        }
    }
}

pub(super) fn specs(&self) -> Vec<Value> {
    let mut specs: Vec<Value> = self.tools.iter().map(|t| t.spec()).collect();
    if let Some(pool) = &self.mcp_pool {
        specs.extend(pool.tool_specs().iter().cloned());       // 含 MCP 工具
    }
    specs
}
```

**生命周期**：会话启动时 `McpClientPool::from_servers(servers).await`，spawn 全部 server + `tools/list`；多轮 tool_call 复用；会话结束 drop（kill 子进程）。

---

## 4. Skill 实现详解

### 4.1 Progressive Disclosure 机制

对齐 Claude Code 的 skill：模型先看 skill 索引（name + description），按需 `read_skill(name)` 读全文。避免全量注入撑爆上下文。

### 4.2 文件约定

```
<工作区>/.polaris/skills/<skill-name>/SKILL.md
```

格式：

```markdown
---
name: react-test
description: Generate React Testing Library tests for a component
---

# 详细指令（read_skill 时才加载）
...完整 skill 内容...
```

### 4.3 实现分层

#### `simple_ai/skill.rs` —— 发现与索引

```rust
pub(crate) fn discover_skills(work_dir: &str) -> Vec<SkillEntry> {
    // 扫 .polaris/skills/*/SKILL.md（一级子目录），解析 frontmatter + body
}

pub(crate) fn build_skill_index_message(skills: &[SkillEntry]) -> Option<Value> {
    // 生成 user 消息：# Available skills\n- name: ...\n  description: ...
    // 提示模型用 read_skill 工具读全文
}
```

#### `tools/skill.rs` —— `ReadSkillTool`

```rust
async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
    let name = args["name"].as_str();
    match ctx.skills.get(name) {
        Some(skill) => ToolOutcome::ok(truncate_chars(&skill.full_text, 16_384)),
        None => ToolOutcome::fail(format!("Skill '{}' not found. Available: ...", name)),
    }
}
```

### 4.4 注入流程（`mod.rs start_session`）

```rust
let skills_list = skill::discover_skills(&work_dir);
let skills_map: HashMap<String, SkillEntry> = skills_list.iter().map(|s| (s.name.clone(), s.clone())).collect();

// 构建初始消息
let mut messages = vec![system];
messages.extend(build_context_messages(&work_dir));
if let Some(idx) = skill::build_skill_index_message(&skills_list) {
    messages.push(idx);                          // ← 索引注入
}
messages.extend(history);
messages.push(user_message);

// skills_map 传给 chat_loop → ToolContext.skills（供 read_skill 查询）
```

**关键**：索引注入仅首轮（`start_session`）；`continue_session` 不重复注入（已在历史中），但仍传 `skills_map` 供 `read_skill`。

---

## 5. Agent Preset 实现详解

### 5.1 文件约定

```
<工作区>/.polaris/agents/<agent-name>.md
```

格式：

```markdown
---
name: coder
description: A focused coding agent
tools: bash, read_file, apply_patch        # 白名单（已解析，过滤待启用）
---

You are a focused coding agent. ...（body = system prompt）
```

### 5.2 实现

#### `simple_ai/agent.rs`

```rust
pub(crate) fn load_agent(work_dir: &str, name: &str) -> Option<AgentDefinition> {
    // 读 .polaris/agents/<name>.md，解析 frontmatter + body
}

pub(crate) struct AgentDefinition {
    pub name: String,
    pub description: String,
    pub tools: Vec<String>,           // 白名单
    pub system_prompt: String,        // body
}
```

#### `mod.rs start_session` —— system prompt 覆盖

```rust
let system_prompt = if let Some(custom) = &options.system_prompt {
    custom.clone()                    // 用户显式传入：完全覆盖（决策 §12-3）
} else if let Some(agent_name) = &options.agent {
    match agent::load_agent(&work_dir, agent_name) {
        Some(agent) => agent.system_prompt,        // agent body 覆盖 persona
        None => build_system_prompt(),             // 未找到回退默认
    }
} else {
    build_system_prompt()
};
```

### 5.3 限制

- **前端选择器未适配**：`cliInfoStore.agents` 当前来自 `claude agents` CLI，SimpleAI 模式下选不到。需新增 `read_agents` 命令 + 前端改造（待办）。
- **tools 白名单过滤未启用**：`AgentDefinition.tools` 已解析但 `registry.specs()` 仍全量（待办）。

---

## 6. Subagent 实现详解

### 6.1 dispatch_agent 工具

`tools/agent.rs` 的 `DispatchAgentTool`：模型调用后 spawn 子 SimpleAI 会话。

```rust
async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
    // 1. 检查深度：ctx.subagent_depth >= SUBAGENT_MAX_DEPTH(3) 则拒绝
    // 2. load_agent(ctx.work_dir, agent_name) 读 agent 定义
    // 3. 构造子 messages：[system=agent.prompt, user=task]（不继承父历史）
    // 4. 调 run_chat_loop(depth + 1) 跑子会话
    // 5. 取最后 assistant 文本返回（截断 8k）
}
```

### 6.2 关键设计

- **独立 context**：子会话 messages 只含 system + task，不继承父历史（隔离）。
- **复用父资源**：profile / mcp_servers / skills 复用（输入参数级）；MCP client 进程当前重新 spawn（待办：共享 `Arc<McpClientPool>`）。
- **深度限制**：`SUBAGENT_MAX_DEPTH = 3`，防递归失控。
- **禁用开关**：`SIMPLE_AI_DISABLE_SUBAGENT=1` 时 `registry.without_tool("dispatch_agent")` 移除。

### 6.3 ToolContext 扩展

为支持 subagent，`ToolContext` 新增字段：

```rust
pub(crate) struct ToolContext<'a> {
    // ... 原有字段
    pub skills: &'a HashMap<String, SkillEntry>,
    pub profile: &'a ModelProfile,              // 子会话复用
    pub mcp_servers: &'a [ResolvedExternalMcpServer],  // 子会话复用
    pub subagent_depth: u32,                    // 递归深度
}
```

`run_chat_loop` 加 `depth: u32` 参数，顶层传 0，`dispatch_agent` 调用时传 `ctx.subagent_depth + 1`。

---

## 7. 健壮性实现详解

### 7.1 Retry 指数退避（`simple_ai/retry.rs`）

```rust
pub(super) async fn send_with_retry(req: RequestBuilder, max_attempts: u32, base_ms: u64) -> Result<Response> {
    // 可重试：429 / 5xx / 网络错误（reqwest::Error）
    // 不可重试：400 / 401 / 403 等其他 4xx（立即返回）
    // 退避：Retry-After 头（秒）优先；否则 base * 2^(attempt-1)
    // 超时：30s/请求
}
```

**决策函数**（纯函数，单测覆盖）：
- `is_retryable_status(status)` —— 429 / 500-599
- `backoff_delay(attempt, base_ms)` —— 指数退避
- `parse_retry_after(value)` —— 解析秒数

配置：`SIMPLE_AI_RETRY_MAX`（默认 3）/ `SIMPLE_AI_RETRY_BASE_MS`（默认 500）。

### 7.2 Token Usage（`simple_ai_protocol.rs`）

`StreamState` 新增 `usage: Option<Usage>` 字段，三协议流末解析：

| 协议 | 解析位置 |
|---|---|
| OpenAIChat | 末包 `usage{prompt_tokens, completion_tokens, total_tokens}`（需请求 `stream_options.include_usage`） |
| Anthropic | `message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`（分两次累积） |
| Responses | `response.completed.response.usage` |

```rust
pub fn finish_usage(&self) -> Option<Usage> { self.usage }
```

`chat_loop` 流末取 usage，累计到 `UsageAccumulator`（供 compact 触发）。

### 7.3 上下文压缩（`simple_ai/compact.rs`）

**触发**：`UsageAccumulator.total_input >= context_window * 0.75`。

```rust
pub(super) async fn compact_history(messages: &mut Vec<Value>, profile, event_callback, session_id) -> Result<()> {
    // 1. select_compact_range：选取 [1, end) 区间（system 之后、最近 user 之前），
    //    回退到 tool 配对边界（不切断 assistant.tool_calls → tool）
    // 2. 序列化区间为文本，发非流式摘要请求（stream:false，复用 build_request_body）
    // 3. 用 summary 替换区间为单条 user 消息
    // 4. 兜底：压缩失败 → fallback_drop_oldest（移除最早完整 turn）
}
```

**三协议响应解析**（`extract_summary_text`）：OpenAIChat `choices[0].message.content` / Anthropic `content[].text` 拼接 / Responses `output[].content[].text`。

配置：`SIMPLE_AI_CONTEXT_WINDOW`（默认 128000）。

---

## 8. 扩展指南

### 8.1 添加新的内置工具

1. 新建 `simple_ai/tools/<name>.rs`，实现 `Tool` trait：

```rust
pub(super) struct MyTool;

#[async_trait::async_trait]
impl Tool for MyTool {
    fn name(&self) -> &'static str { "my_tool" }
    fn spec(&self) -> Value { json!({ "type": "function", "function": { "name": "my_tool", ... } }) }
    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
        // 实现
        ToolOutcome::ok("result")
    }
}
```

2. 在 `tools/mod.rs` 注册：
   - `mod <name>;`
   - `use <name>::MyTool;`
   - `with_builtins()` 的 `vec![...]` 加 `Box::new(MyTool)`

3. 若需要访问 `ToolContext` 的新字段，扩展 `ToolContext` struct。

### 8.2 添加新的 Skill

只需创建文件，无需改代码：

```bash
mkdir -p .polaris/skills/my-skill
cat > .polaris/skills/my-skill/SKILL.md << 'EOF'
---
name: my-skill
description: What this skill does
---

# 详细指令
...
EOF
```

会话启动时自动扫描注入索引。

### 8.3 添加新的 Agent

只需创建文件：

```bash
mkdir -p .polaris/agents
cat > .polaris/agents/my-agent.md << 'EOF'
---
name: my-agent
description: What this agent specializes in
tools: bash, read_file
---

You are a specialized agent for ...
EOF
```

通过 `options.agent = "my-agent"` 触发（前端选择器适配后；或 API 直传）。

### 8.4 添加新的插件 MCP

1. 创建插件目录（用户级 `<config_dir>/plugins/<id>/` 或项目级 `<workspace>/.polaris/plugins/<id>/`）
2. 写 `plugin.json`：

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "contributes": {
    "mcpServers": [{
      "id": "my-mcp",
      "transport": "stdio",
      "command": "node",
      "argsTemplate": ["{{pluginDir}}/mcp/server.cjs"]
    }]
  },
  "permissions": { "aiToolAccess": true }
}
```

3. 实现 MCP server（任意语言，遵循 JSON-RPC 2.0 + 换行分隔），提供 `initialize` / `tools/list` / `tools/call`

**关键**：`permissions.aiToolAccess: true` 是 SimpleAI 消费插件 MCP 的门控（内置 MCP 无需此字段，总放行）。

### 8.5 让内置 MCP 暴露给 SimpleAI

内置 MCP（todo/req/scheduler/prd-preview/computer/ask）已自动桥接（`resolved_simple_ai_servers`）。新增内置 MCP 时：

1. `mcp_config_service.rs` 的 `builtin_mcp_contribution_registry()` 注册：
```rust
registry.register_plugin_server(
    "polaris.myplugin",
    PluginMcpServerContribution::builtin(
        "polaris-myplugin", "polaris-myplugin-mcp",
        "bin/polaris-myplugin-mcp", "polaris-myplugin-mcp",
        "src-tauri/target/debug/polaris-myplugin-mcp",
        "POLARIS_MYPLUGIN_MCP_PATH",
        McpServerArgsMode::ConfigDirAndWorkspace,
        false,
    ),
);
```
2. `builtin_plugin_mcp_manifests()` 加对应条目
3. 实现 MCP server（`src/bin/polaris_myplugin_mcp.rs` + `services/myplugin_mcp_server.rs`）

`resolved_simple_ai_servers` 自动发现并桥接，无需额外改动。

---

## 9. 配置参考

Profile 的 `custom_env` 字段（设置 → 模型供应商 → 编辑 Profile → 自定义环境变量）：

| 键 | 默认 | 作用 |
|---|---|---|
| `SIMPLE_AI_TIMEOUT_SECS` | 300 | 请求总超时（秒） |
| `SIMPLE_AI_STREAM_IDLE_SECS` | 120 | 流空闲超时（秒） |
| `SIMPLE_AI_MAX_TOOL_ROUNDS` | 0=不限 | 工具调用轮次上限 |
| `SIMPLE_AI_RETRY_MAX` | 3 | 重试次数（含首次；设 1 = 不重试） |
| `SIMPLE_AI_RETRY_BASE_MS` | 500 | 退避基数（毫秒） |
| `SIMPLE_AI_CONTEXT_WINDOW` | 128000 | 上下文窗口（达 75% 触发 compact） |
| `SIMPLE_AI_DISABLE_SUBAGENT` | 0 | 1 = 移除 dispatch_agent 工具 |

---

## 10. 验证清单

### 10.1 编译验证

```bash
cd src-tauri
cargo check --lib              # 库编译
cargo test --lib --no-run      # 单测编译
```

> ⚠️ 本机受 Tauri 原生 DLL 限制无法运行测试（`STATUS_ENTRYPOINT_NOT_FOUND`），单测逻辑随 CI 执行。

### 10.2 功能验证

1. **基本对话**：切 SimpleAI，发消息，确认流式输出
2. **retry**：临时改错 baseUrl，看日志「请求失败 503，500ms 后重试」
3. **skill**：建 `.polaris/skills/demo/SKILL.md`，发「按 demo skill 处理 X」，看模型调 `read_skill`
4. **内置 MCP**：发「创建一个待办」，看模型调 `mcp__polaris-todo__create_todo`
5. **插件 MCP**：装 bb-browser，发「用浏览器搜索 Rust async」，看模型调 `mcp__bb-browser__site_google_search`
6. **compact**：长对话累积，看日志「触发上下文压缩」+ 前端「正在压缩上下文…」
7. **subagent**：建 `.polaris/agents/coder.md`，发「用 coder agent 调研 src/main.tsx」，看模型调 `dispatch_agent`

### 10.3 日志关键词

```
[SimpleAI] MCP pool 就绪：N 个 server 连接，M 个工具
[SimpleAI] token usage: input=..., output=..., total=... (累计 input=...)
[SimpleAI] 触发上下文压缩（累计 input=...，window=...）
[SimpleAI] 上下文已压缩：N 条消息 → 1 条 summary
[SimpleAI] 请求失败 429，500ms 后重试 (attempt 1/3)
[SimpleAI] 使用 agent 'coder' 的 system prompt
[SimpleAI] dispatching sub-agent 'coder' (depth 1)
```

---

## 11. 关键文件索引

| 文件 | 职责 |
|---|---|
| `src-tauri/src/ai/engine/simple_ai/mod.rs` | 引擎入口 + 会话管理 + skill/agent 装配 |
| `src-tauri/src/ai/engine/simple_ai/chat_loop.rs` | 对话循环 + retry/compact/usage/mcp/dispatch 接入 |
| `src-tauri/src/ai/engine/simple_ai/tools/mod.rs` | Tool trait + ToolRegistry + ToolContext |
| `src-tauri/src/ai/engine/simple_ai/mcp/{types,client,mod}.rs` | MCP 客户端 |
| `src-tauri/src/ai/engine/simple_ai/skill.rs` | Skill 发现与索引 |
| `src-tauri/src/ai/engine/simple_ai/agent.rs` | Agent preset 发现 |
| `src-tauri/src/ai/engine/simple_ai/tools/skill.rs` | read_skill 工具 |
| `src-tauri/src/ai/engine/simple_ai/tools/agent.rs` | dispatch_agent 工具 |
| `src-tauri/src/ai/engine/simple_ai/retry.rs` | HTTP 重试 |
| `src-tauri/src/ai/engine/simple_ai/compact.rs` | 上下文压缩 |
| `src-tauri/src/ai/engine/simple_ai_protocol.rs` | 三协议适配 + Usage 解析 |
| `src-tauri/src/ai/engine/simple_ai/context.rs` | 环境上下文 + 项目指令 |
| `src-tauri/src/ai/engine/simple_ai/prompt.rs` | Persona 构建 |
| `src-tauri/src/services/mcp_config_service.rs` | MCP 配置聚合 + `resolved_simple_ai_servers` |
| `src-tauri/src/commands/chat.rs` | SimpleAI 分支 MCP 解析 + aiToolAccess 门控 |
| `src-tauri/src/ai/traits.rs` | `SessionOptions`（含 `mcp_servers` 字段） |
