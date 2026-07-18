# SimpleAI 能力跃升实施方案（对标 Codex / Claude Code + Skill / Agent / 插件）

> 状态：**分析梳理 + 全阶段实施完成（2026-07-04）**
> 范围：在不引入外部 CLI 依赖的前提下，把 SimpleAI 从「轻量备用引擎」升级为「具备 codex/claude-code 级 agent 能力、支持 skill、支持 subagent、能消费当前项目插件 MCP 工具」的内置引擎。
> 验证：本机 `cargo check --lib` + `cargo test --lib --no-run` 全通过，零新增 warning（受 [[rust-lib-test-env-limit]] 限制，单测逻辑由 CI 执行）。
> 前置文档：`docs/simple-ai-codex-refactor-plan.md`（Phase 0/1/2 + A/B/C 已完成）。

---

## 1. 背景与目标

SimpleAI 已完成对照 codex 的四维度重构（基本对话 / 工具 / 身份 / 项目指令），但仍与 codex / Claude Code 存在三类硬差距：

1. **插件工具完全不可达** —— Polaris 的所有功能（todo / requirements / scheduler / computer / ask / prd-preview）与第三方插件（如 `bb-browser`）都以 **stdio MCP server** 形式贡献工具，由 `WorkspaceMcpConfigService` 写入 `.polaris/claude/mcp.json` 供 Claude CLI / codex CLI 消费。SimpleAI 在 `commands/chat.rs:443` 显式「不使用 MCP」，因此它只能用 9 个内置工具，碰不到插件生态。
2. **无 Skill / Agent 机制** —— `.claude/skills/` 为空、`cliInfoStore` 的 `skills` 字段无后端 `get_skills` 支撑、`--agent` 参数被 SimpleAI 完全忽略（`SessionOptions.agent` 仅 CLI 引擎消费）。
3. **Phase 3 健壮性未做** —— 无 usage 统计、无指数退避重试、无上下文压缩，长任务会单调撑爆窗口。

**目标**：补齐这三类差距，使 SimpleAI 在「用户配置任意 OpenAI 兼容 API」的前提下，达到与 codex / Claude Code 接近的 agent 体验，并复用 Polaris 既有的插件 / MCP / skill / agent 基础设施。

---

## 2. 现状验证（事实清单，已逐项核对源码）

| # | 事实 | 源码锚点 | 影响 |
|---|---|---|---|
| F1 | Tool trait 同步：`fn execute(&self, args, ctx) -> ToolOutcome`，9 内置工具全同步 | `simple_ai/tools/mod.rs:67` | bash 用 `Command::output()` 阻塞；MCP 工具是异步 IO，trait 必须先异步化 |
| F2 | Polaris **无 Rust MCP client**；6 个 MCP server 全是手写 stdio JSON-RPC | `services/{todo,requirements,scheduler,computer,ask,prd_preview}_mcp_server.rs` | SimpleAI 要消费插件工具，必须自研 client |
| F3 | MCP stdio 帧格式 = **换行分隔 JSON-RPC 2.0**（`read_line`），非 LSP `Content-Length` | `todo_mcp_server.rs:64-82` | client 镜像该格式即可，无新依赖 |
| F4 | 插件 manifest：`contributes.mcpServers[{id,transport:"stdio",command,argsTemplate:["{{pluginDir}}/..."]}]` + `permissions.aiToolAccess` | `models/plugin.rs` `PluginMcpServerManifestContribution` / `PluginManifestPermissions` | 接入路径已存在，只需扩展解析 |
| F5 | `resolve_external_plugin_mcp_servers` 已能产出 `ResolvedExternalMcpServer{plugin_id,server_name,command,args}`，但**只检查 `enabled && mcp_enabled`，不检查 `aiToolAccess`** | `mcp_config_service.rs:627-697` | 需扩展门控，只把 `aiToolAccess:true` 的插件暴露给 AI |
| F6 | `prepare_mcp_config_with_paths` 对 SimpleAI 返回空 `PreparedMcpConfig` | `commands/chat.rs:443-449` | 接入点：此处为 SimpleAI 解析 MCP server 列表注入引擎 |
| F7 | `SessionOptions` 已有 `mcp_config_path / agent / allowed_tools / codex_config_args` 字段，SimpleAI 全忽略 | `ai/traits.rs:106-149` | 字段已就位，SimpleAI 需新增消费逻辑 |
| F8 | Skill：`.claude/skills/` 存在但空；`cliInfoStore.skills` 字段无后端 `get_skills` | `stores/cliInfoStore.ts:62` / 无对应 backend | skill 系统需从 0 建 |
| F9 | Agent：`claude agents` CLI 输出 → `cliInfoStore` → `--agent` 传 Claude CLI；codex 无 subagent | `services/cli_info_service.rs:66` / `engine/claude.rs:367` | SimpleAI 的 agent 机制需自建（不能依赖 `claude agents`） |
| F10 | Custom Command：前端 `commandStore` 调 `read_commands` 读 `.claude/commands/*.md`（YAML frontmatter + content），客户端展开后作为消息发送，引擎无感 | `commands/file_explorer.rs:484` / `stores/commandStore.ts:54` | skill 若走同一通路则零后端改动；若走 system prompt 注入则需新通路 |
| F11 | `Cargo.toml` 已有：`tokio`(full) / `async-trait` / `serde_json` / `reqwest` / `walkdir` / `futures-util` / `glob`；**无 `serde_yaml`、无 `rmcp`** | `src-tauri/Cargo.toml` | MCP client 自研不引依赖；skill frontmatter 用现有行解析或加 `serde_yaml` |
| F12 | Phase 3（usage/retry/compact）未做；`max_tool_rounds` 默认 0=不限 | `chat_loop.rs:43` | 长任务无 compact 会撑爆窗口 |
| F13 | `apply_patch / update_plan / glob / computer(Win)` 已实现 | `tools/{apply_patch,plan,search,computer}.rs` | 工具底座已够强，重点是「打开工具边界」接入 MCP |

---

## 3. 差距分析（SimpleAI vs Codex vs Claude Code）

| 能力 | Codex | Claude Code | SimpleAI 现状 | 本方案目标 |
|---|---|---|---|---|
| 内置工具 | bash + apply_patch + update_plan + view_image 等 | bash + Edit + Read + Glob + Grep + Task 等 | 9 个内置工具 ✅ | 保持 |
| MCP 工具消费 | 经 `-c mcp_servers.*` 注入 CLI | 经 `.mcp.json` 注入 CLI | ❌ 无 client | ✅ 自研 stdio client |
| 插件 MCP | 同上 | 同上 | ❌ 完全不可达 | ✅ 复用 `resolve_external_plugin_mcp_servers` |
| Skill | ❌ 无 | ✅ progressive disclosure（SKILL.md 索引 + 按需读全文） | ❌ 无 | ✅ 索引 + `read_skill` 工具 |
| Subagent | ❌ 无 | ✅ Task 工具 spawn 子会话 | ❌ 无 | ✅ `dispatch_agent` 工具（分阶段） |
| Agent preset | ❌ | ✅ `--agent` 选 `.claude/agents/*.md` | ❌ 忽略 `options.agent` | ✅ 读 agent 定义覆盖 system prompt |
| Slash command | ❌ | ✅ `.claude/commands/*.md` | ✅ 前端展开（引擎无感） | 保持 |
| usage 统计 | ✅ | ✅ | ❌ | ✅ Phase 3 |
| retry 退避 | ✅ | ✅ | ❌ | ✅ Phase 3 |
| 上下文压缩 | ✅ `compact.rs` | ✅ | ❌ | ✅ Phase 3 |
| 项目指令 | ✅ AGENTS.md | ✅ CLAUDE.md | ✅ 两者都读 | 保持 |
| 环境上下文 | ✅ XML | ✅ | ✅ | 保持 |

**核心洞察**：codex 与 Claude Code 的 MCP / skill / agent 之所以「能用」，是因为它们各自在 CLI 内部实现了 client。SimpleAI 没有 CLI 外壳，必须**在 Rust 进程内自研 MCP client**，这是整个方案的咽喉。

---

## 4. 架构总览

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
        │  persona +     │    │  (异步工具循环 +     │    │  env_context +   │
        │  skill 索引 +  │    │   Phase 3 retry/     │    │  AGENTS/CLAUDE + │
        │  agent overlay │    │   compact)           │    │  agent 定义注入  │
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
    │ 内置工具      │         │  McpToolAdapter     │      │  DispatchAgentTool  │
    │ (bash/fs/     │         │  (持有 McpClientPool)│      │  (spawn 子会话)     │
    │  search/      │         │  每个工具名          │      │                     │
    │  apply_patch/ │         │  mcp__{srv}__{tool}  │      │                     │
    │  plan/computer)│        └──────────┬──────────┘      └─────────────────────┘
    └───────────────┘                    │
                              ┌──────────▼──────────┐
                              │  mcp/ (新模块)       │
                              │  McpClient (stdio)  │
                              │  McpClientPool      │
                              │  JSON-RPC 帧层      │
                              └──────────┬──────────┘
                                         │ spawn + stdin/stdout
                          ┌──────────────┼──────────────────────┐
                          │              │                      │
                   ┌──────▼───┐   ┌──────▼─────┐         ┌──────▼──────┐
                   │ 内置 MCP │   │ 插件 MCP   │         │ 用户 .mcp   │
                   │ todo/    │   │ bb-browser │         │ .polaris/   │
                   │ req/...  │   │ demo/...   │         │ claude/mcp  │
                   └──────────┘   └────────────┘         └─────────────┘
```

四个支柱：
- **支柱 A**：Tool trait 异步化（解锁 MCP 与 subagent 的异步 IO）
- **支柱 B**：MCP client + 插件接入（打开工具边界）
- **支柱 C**：Skill / Agent / Command 注入（身份与能力扩展）
- **支柱 D**：Phase 3 健壮性（usage / retry / compact）

---

## 5. 关键决策对比（多轮验证）

### 决策 1：Tool trait 异步化路径

| 方案 | 描述 | 优点 | 缺点 | 改动量 |
|---|---|---|---|---|
| A. 双轨制 | 新增 `AsyncTool` trait，registry 同时持有两类，dispatch 按类型路由 | 现有 9 工具零改动 | 双轨增加复杂度，dispatch 分叉 | 中 |
| B. 全量 async | `Tool::execute` 改 `async fn`（用 `async_trait`，项目已用） | 单轨干净，与 chat_loop 已是 async 对齐 | 9 工具签名全改；同步阻塞工具（bash）需 `spawn_blocking` 包裹 | 中 |
| C. spawn_blocking 包同步 | 保留同步 trait，dispatch 时 `tokio::spawn_blocking` | 改动最小 | MCP 长连接无法表达（spawn_blocking 是短任务）；语义错配 | 小但错 |

**✅ 推荐 B**。理由：
1. 项目已用 `async_trait`（`integrations/feishu/adapter.rs:524`、`qqbot/adapter.rs:502`），无新依赖。
2. chat_loop 本就是 async，单轨最自然。
3. bash 等同步阻塞工具用 `tokio::task::spawn_blocking` 包裹（已是 tokio full features）。
4. 避免 dispatch 分叉带来的长期维护成本。

### 决策 2：MCP 客户端实现

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 自研 stdio JSON-RPC client | 镜像现有 6 个手写 server 的帧层，~250 行 | 与项目风格一致，零新依赖，完全可控 | 需自己实现 initialize/tools-list/tools-call 三方法 + 超时 |
| B. 引入 `rmcp` 官方 SDK | 用 `rmcp::ServiceExt` | 协议合规性自动保证 | 与项目「手写 JSON-RPC」风格不符；新增重依赖；rmcp 对帧格式有自己要求（可能与现有 server 的换行格式有差异需验证） |
| C. 复用现有 server 反向逻辑 | 把 server 的 `handle_request` 翻转 | 复用代码 | server 是被 spawn 的被动方，client 是主动方，逻辑不可复用 |

**✅ 推荐 A**。理由：
1. 现有 6 个 MCP server 全手写 JSON-RPC，client 镜像该风格，对称易懂。
2. 帧格式已验证（F3）：换行分隔 JSON，`read_line` 即可。
3. MCP 协议表面只用到 `initialize` / `notifications/initialized` / `tools/list` / `tools/call` 四个方法，~250 行可控。
4. 无新依赖，符合 SimpleAI「轻量」定位。

### 决策 3：MCP 工具注入与生命周期

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 会话级长连接 | 会话启动时 spawn 所有已启用 MCP server，`tools/list` 一次，多轮复用，会话结束 kill | 开销最低；工具列表稳定 | 启动慢；server 故障影响会话 |
| B. 每次 tool_call spawn | 用时才 spawn，调完 kill | 隔离性好 | spawn 开销大（node 启动 ~200ms） |
| C. 懒加载 + 缓存 | 首次 tool_call 才 spawn，之后复用 | 兼顾启动速度与开销 | 复杂度高 |

**✅ 推荐 A，但延迟到首次工具调用时初始化**。即：会话启动时只解析配置得到 `Vec<ResolvedExternalMcpServer>`，不立即 spawn；首次 chat_loop 进入工具循环前才 spawn 全部 + `tools/list`。这样：
- 启动不阻塞（用户首轮文本生成期间并行 spawn）。
- 工具列表在首轮工具调用前就绪。
- 会话结束统一 kill（drop 时 Child 自动 kill）。

### 决策 4：MCP 工具命名与冲突

- 命名：`mcp__{server_name}__{tool_name}`（仿 Claude Code），确保与内置工具不冲突。
- dispatch：`ToolRegistry::dispatch` 先匹配内置工具名，未命中则解析 `mcp__` 前缀路由到对应 `McpClient`。
- 冲突：同名 server 出现在内置与外部插件时，内置优先（`external_plugin_mcp_server_does_not_override_builtin_server` 测试已确立此语义，`mcp_config_service.rs:1518`）。

**✅ 推荐此方案**，与现有冲突策略一致。

### 决策 5：Skill 机制

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. Progressive disclosure | system prompt 注入 skill 索引（name+description），新增 `read_skill(name)` 工具按需读全文 | 对齐 Claude Code 真实机制；省 token | 模型可能不主动读 |
| B. Slash command 式展开 | `/skill-name` 触发即把 SKILL.md 全文注入 user 消息 | 简单；复用 commandStore 通路 | 不是真正的 skill；无法被模型自主调用 |
| C. 全量注入 | 所有 skill 全文塞 system prompt | 模型一定能看到 | 撑爆上下文 |

**✅ 推荐 A**。理由：用户要求「达到 claudecode 效果」，Claude Code 的 skill 就是 progressive disclosure。方案 A 是唯一对齐的实现。

### 决策 6：Agent 机制

| 方案 | 描述 | 优点 | 缺点 |
|---|---|---|---|
| A. 真 subagent | `dispatch_agent` 工具，模型调用后 spawn 子 SimpleAI 会话（独立 context + agent 定义作为 system prompt），完成后返回结果摘要 | 对齐 Claude Code Task 工具；真并行/隔离 | 工程量大（递归 spawn、事件隔离、结果聚合） |
| B. Agent preset | `options.agent` 读 `.claude/agents/{name}.md` 覆盖 system prompt | 简单；复用现有字段 | 不是 subagent，只是换身份 |
| C. 不做 | 维持现状 | 零工作 | 不满足需求 |

**✅ 推荐 B 先行 + A 后续**。即：
- **Phase 4**：先做 B（agent preset），让 `options.agent` 生效——读 `.claude/agents/{name}.md`（frontmatter: name/description/tools，body: system prompt），覆盖/追加到 system prompt。零新增工具，快速见效。
- **Phase 5**：做 A（`dispatch_agent` 工具），spawn 子会话。这是 Claude Code Task 工具的等价物，工程量大，单独阶段。

### 决策 7：插件 `aiToolAccess` 门控

现状（F5）：`resolve_external_plugin_mcp_servers` 只检查 `enabled && mcp_enabled`，不检查 `aiToolAccess`。

**✅ 推荐扩展**：在 `is_plugin_mcp_enabled` 增加 `permissions.ai_tool_access == Some(true)` 判定。理由：`aiToolAccess` 是插件作者声明的「是否允许 AI 调用本插件工具」开关，SimpleAI 作为 AI 引擎必须尊重。内置 MCP（todo/req/...）默认无此字段，按「enabled」处理。

---

## 6. 详细方案

### 6.1 支柱 A：Tool trait 异步化

**改动文件**：`simple_ai/tools/mod.rs` + 9 个工具文件 + `chat_loop.rs`

**新 trait**：

```rust
use async_trait::async_trait;

#[async_trait]
pub(crate) trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn spec(&self) -> Value;
    async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome;
}
```

**ToolContext 异步化**：`event_callback` 已是 `Arc<dyn Fn>`，无需改；`plan_started` 已是 `AtomicBool`，无需改。`ToolContext` 保持引用语义，async trait 用 `'_` 生命周期。

**bash 同步阻塞包裹**：

```rust
async fn execute(&self, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
    let command = args["command"].as_str().unwrap_or("").to_string();
    let workdir = args["workdir"].as_str().map(String::from);
    let default_dir = ctx.work_dir.to_string();
    tokio::task::spawn_blocking(move || run_bash(&command, workdir.as_deref(), &default_dir))
        .await
        .unwrap_or_else(|e| ToolOutcome::fail(format!("bash panicked: {e}")))
}
```

**registry.dispatch 改 async**：

```rust
pub(super) async fn dispatch(&self, name: &str, args: &Value, ctx: &ToolContext<'_>) -> ToolOutcome {
    match self.tools.iter().find(|t| t.name() == name) {
        Some(tool) => tool.execute(args, ctx).await,
        None => match parse_mcp_prefix(name) {
            Some((srv, tool)) => self.mcp_pool.call(srv, tool, args).await,
            None => ToolOutcome::fail(format!("Unknown tool: {}", name)),
        },
    }
}
```

**chat_loop 工具执行段**（`chat_loop.rs:278`）改为 `let outcome = registry.dispatch(tool_name, &args, &ctx).await;`。

**影响范围**：
- 9 个工具文件 `execute` 签名全改（机械改动）。
- `registry_exposes_all_builtins` 等单测改 async（`#[tokio::test]`）。
- 无行为变化（除 bash 不再阻塞 runtime——bash 仍阻塞该工具调用，但不阻塞其他 async 任务）。

### 6.2 支柱 B：MCP 客户端 + 插件接入

#### 6.2.1 新模块 `simple_ai/mcp/`

```
simple_ai/mcp/
├── mod.rs          # McpClient + McpClientPool
├── client.rs       # stdio JSON-RPC client（spawn 子进程 + 帧层）
└── types.rs        # McpTool / McpCallResult / JSON-RPC envelope
```

**`McpClient`**（单 server 连接）：

```rust
pub(crate) struct McpClient {
    server_name: String,
    child: tokio::process::Child,
    stdin: tokio::io::BufWriter<tokio::process::ChildStdin>,
    stdout: tokio::io::BufReader<tokio::process::ChildStdout>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
}

impl McpClient {
    pub async fn spawn(server: &ResolvedExternalMcpServer) -> Result<Self> {
        // 1. tokio::process::Command::new(command).args(args).stdin(piped).stdout(piped).stderr(piped)
        // 2. 发 initialize {protocolVersion:"2025-06-18", capabilities:{}, clientInfo:{...}}
        //    读取 server 返回的 protocolVersion，若为旧版（2024-11-05）则按旧版握手降级
        //    （tools/list / tools/call 在两版本下语义一致，仅握手字段不同）
        // 3. 等 initialize result
        // 4. 发 notifications/initialized
        // 5. 启动 stdout reader task：逐行 read_line → 解析 JSON-RPC → 按 id 路由到 pending oneshot
        // 6. 调 tools/list，缓存工具列表
    }

    pub async fn list_tools(&self) -> Result<Vec<McpTool>> { ... }
    pub async fn call_tool(&self, name: &str, args: &Value) -> Result<McpCallResult> { ... }
}

impl Drop for McpClient {
    fn drop(&mut self) { let _ = self.child.start_kill(); }
}
```

**帧格式**（镜像 `todo_mcp_server.rs:64-82`）：每行一条 JSON-RPC，`read_line` 分隔。请求带 `id`，响应按 `id` 路由；通知（无 `id`）只 log 不回。

**`McpClientPool`**（会话级）：

```rust
pub(crate) struct McpClientPool {
    clients: HashMap<String, Arc<McpClient>>,  // server_name → client
    tool_index: HashMap<String, (String, String)>,  // "mcp__srv__tool" → (server_name, tool_name)
}

impl McpClientPool {
    pub async fn from_servers(servers: Vec<ResolvedExternalMcpServer>) -> Self {
        // 并发 spawn 所有 client（futures::future::join_all）
        // 逐个 list_tools，构建 tool_index
        // 失败的 server 跳过 + log（不阻断会话）
    }

    pub fn tool_specs(&self) -> Vec<Value> {
        // 把每个 McpTool 转成 OpenAI function spec，name = mcp__srv__tool
    }

    pub async fn call(&self, mcp_name: &str, args: &Value) -> ToolOutcome {
        // 解析 tool_index → (server, tool) → client.call_tool → 转 ToolOutcome
    }
}
```

**`McpTool → OpenAI function spec` 转换**：MCP 的 `inputSchema` 就是 JSON Schema，直接包成 `{"type":"function","function":{"name":"mcp__srv__tool","description":...,"parameters":inputSchema}}`。

**`McpCallResult → ToolOutcome` 转换**：`result.content[]` 取 `{type:"text", text}` 拼接；`isError:true` → `ToolOutcome::fail`。

#### 6.2.2 接入点改动

**`commands/chat.rs:443`**（SimpleAI 分支）：

```rust
EngineId::SimpleAI => {
    // 旧：直接返回空。
    // 新：解析已启用的 MCP server 列表，传给引擎。
    let (service, disabled) = resolve_workspace_mcp_runtime_service(...)?;
    let (_, plugins) = load_plugin_mcp_runtime_state(&config_dir, Path::new(work_dir));
    let states = ...;
    let external = resolve_external_plugin_mcp_servers(&config_dir, Path::new(work_dir), &plugins, &states);
    // 过滤 aiToolAccess + disabled
    let external: Vec<_> = external.into_iter()
        .filter(|s| !disabled.contains(&s.server_name))
        .collect();
    // 把 server 列表序列化进 env_overrides（复用 __simple_ai_profile_id 模式）
    Ok(PreparedMcpConfig {
        claude_config_path: None,
        codex_config_args: Vec::new(),
        simple_ai_mcp_servers: Some(external),  // ← 新字段
    })
}
```

`PreparedMcpConfig` 新增 `simple_ai_mcp_servers: Option<Vec<ResolvedExternalMcpServer>>`，`SessionOptions` 新增对应字段（或复用 `env_overrides` 序列化，避免改 trait 签名）。

**`simple_ai/mod.rs` `start_session`**：从 options 取出 server 列表，传给 chat_loop；chat_loop 在工具循环前 `McpClientPool::from_servers(servers).await`，把 `pool.tool_specs()` 并入 `registry.specs()`，`pool` 注入 registry。

#### 6.2.3 `aiToolAccess` 门控

**`mcp_config_service.rs:699` `is_plugin_mcp_enabled`**：

```rust
fn is_plugin_mcp_enabled(plugin: &DiscoveredPluginManifest, state: Option<&PluginState>) -> bool {
    let base = match state {
        Some(s) => s.enabled && s.mcp_enabled,
        None => plugin.enabled_by_default,
    };
    base && plugin.permissions.ai_tool_access.unwrap_or(false)  // ← 新增
}
```

注意：此函数当前也被 codex/claude 路径用到。需确认是否要影响它们——倾向**只对 SimpleAI 路径额外过滤**，避免改变 CLI 引擎现有行为。即：`is_plugin_mcp_enabled` 保持原语义，新增 `is_plugin_ai_tool_accessible` 在 SimpleAI 分支叠加过滤。

### 6.3 支柱 C：Skill / Agent / Command

#### 6.3.1 Skill 系统（progressive disclosure）

**发现**：扫描 `work_dir/.polaris/skills/*/SKILL.md`（与 Polaris 自身的 `.polaris/` 约定一致）。每个 SKILL.md：
- frontmatter（YAML）：`name` / `description`
- body：skill 全文（按需读）

**注入**：在 `context.rs` 新增 `build_skill_index(work_dir) -> String`，返回形如：

```text
# Available skills
- name: pdf-extract
  description: Extract text and tables from PDF files
- name: react-test
  description: Generate React Testing Library tests
```

作为 user 消息注入（与 environment_context 同级）。**只注入索引，不注入全文**。

**`read_skill` 工具**（新工具，`tools/skill.rs`）：

```rust
struct ReadSkillTool { skills: Arc<HashMap<String, SkillEntry>> }
async fn execute(&self, args, ctx) -> ToolOutcome {
    let name = args["name"].as_str()?;
    let entry = self.skills.get(name)?;
    ToolOutcome::ok(entry.full_text)  // 返回 SKILL.md 全文
}
```

`SkillEntry { name, description, full_text, file_path }` 在会话启动时一次性加载到内存（skill 通常 <10 个，全文不进 prompt，按需读）。

**frontmatter 解析**：现有 `parse_command_file`（`file_explorer.rs:528`）是手写行解析，只支持 `description:` / `params:`。skill 复用该解析器即可（skill 只需 name/description）。如需更复杂字段，后续加 `serde_yaml`。

#### 6.3.2 Agent preset（`options.agent`）

**发现**：扫描 `work_dir/.claude/agents/{name}.md`。每个 agent 文件：
- frontmatter：`name` / `description` / `tools`（可选，工具白名单）
- body：system prompt 覆盖

**注入**（`mod.rs` `start_session`）：

```rust
let system_prompt = if let Some(custom) = &options.system_prompt {
    custom.clone()
} else if let Some(agent_name) = &options.agent {
    // 读 .claude/agents/{agent_name}.md，body 作为 system prompt
    load_agent_definition(work_dir, agent_name)?.body
} else {
    build_system_prompt()
};
```

`tools` 字段（白名单）→ 注入 `allowed_tools` 语义：只把指定工具 + MCP 工具暴露给模型（实现为 registry 过滤 specs）。

**前端**：`cliInfoStore.agents` 当前来自 `claude agents` CLI。SimpleAI 模式下，前端改为读 `.claude/agents/*.md`（新增后端 `read_agents` 命令，仿 `read_commands`）。agent 选择器无感切换。

#### 6.3.3 Subagent（`dispatch_agent` 工具，Phase 5）

```rust
struct DispatchAgentTool { engine: Arc<SimpleAIEngine> }
async fn execute(&self, args, ctx) -> ToolOutcome {
    let agent_name = args["agent"].as_str()?;
    let task = args["task"].as_str()?;
    // 1. 读 agent 定义 → 子 system prompt
    // 2. 新建子会话（独立 messages，不共享父历史）
    // 3. 复用父会话的 profile + MCP pool + work_dir
    // 4. run_chat_loop（子会话）直到完成
    // 5. 取最后一条 assistant 文本作为结果返回给父会话
    // 6. 子会话的工具事件转发给前端（带 subagent 前缀，避免与父会话混淆）
}
```

**关键约束**：
- 子会话不继承父历史（隔离 context）。
- 子会话复用父 MCP pool（避免重复 spawn）。
- 子会话深度限制（默认 3 层，防无限递归）。
- 子会话事件用 `ToolCallStart/End` 呈现（前端已有 subagent 渲染？需核查 `PlanModeBlockRenderer` 等是否支持嵌套）。
- **默认注册**：`dispatch_agent` 默认加入工具列表（决策 §12-4 拍板），可用 `custom_env` 的 `SIMPLE_AI_DISABLE_SUBAGENT=1` 关闭。

### 6.4 支柱 D：Phase 3 健壮性

#### 6.4.1 usage 统计

**`simple_ai_protocol.rs` `StreamState`** 增加 usage 解析：
- OpenAIChat：末包 `usage{prompt_tokens,completion_tokens,total_tokens}`（请求带 `stream_options:{include_usage:true}`）。
- Anthropic：`message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`。
- Responses：`response.completed.response.usage`。

**新事件 `UsageEvent`**（`models/ai_event.rs`）：`{input_tokens, output_tokens, total_tokens}`。前端可显示 token 计数。

#### 6.4.2 retry 指数退避

**`chat_loop.rs` HTTP 请求段**（`chat_loop.rs:135`）：

```rust
let response = retry_with_backoff(
    || async {
        let req = build_request(...)?;
        req.send().await
    },
    3,      // max_attempts
    500,    // base_ms
).await?;
```

- 可重试：429 / 5xx / 网络错误。
- 不可重试：400 / 401 / 403（立即返回）。
- 尊重 `Retry-After` 头。
- 流中断不重试（流已部分发送，重连会重复）。

#### 6.4.3 上下文压缩

**新模块 `simple_ai/compact.rs`**：
- 触发：累计 input tokens 超阈值（默认模型窗口 75%，保守默认 128k → 96k）。
- 动作：把 system 之后、最近 user 之前的历史，连同「交接摘要」prompt 发一次非流式请求，得 summary，替换被压缩区间。
- 兜底：summary 仍超窗口 → 移除最老历史项重试。
- 前端提示：`Progress("正在压缩上下文…")`。

**窗口大小来源**：`ModelProfile` 无 context_window 字段。先用保守默认 128k；后续可在 `custom_env` 加 `SIMPLE_AI_CONTEXT_WINDOW`（复用 `read_env_u64` 模式）。

---

## 7. 接入点与改动清单

| 文件 | 改动 | 支柱 |
|---|---|---|
| `simple_ai/tools/mod.rs` | Tool trait 改 async；registry.dispatch 改 async；新增 mcp_pool 字段 | A/B |
| `simple_ai/tools/{bash,fs,search,apply_patch,plan,computer}.rs` | execute 签名改 async（bash 用 spawn_blocking） | A |
| `simple_ai/chat_loop.rs` | dispatch await；MCP pool 初始化；retry；compact 触发 | A/B/D |
| `simple_ai/mcp/{mod,client,types}.rs` | **新建** MCP client | B |
| `simple_ai/context.rs` | 新增 build_skill_index；agent 定义发现 | C |
| `simple_ai/prompt.rs` | persona 补 skill/agent 说明（仅描述已实现工具，避免幻觉） | C |
| `simple_ai/compact.rs` | **新建** 上下文压缩 | D |
| `simple_ai/usage.rs` | **新建** usage 累计 | D |
| `simple_ai/session.rs` | Session 增加 mcp_pool / skill_index / usage 字段 | B/C/D |
| `simple_ai/mod.rs` | start_session 装配 skill/agent/mcp；continue_session 复用 pool | B/C |
| `simple_ai/tools/skill.rs` | **新建** read_skill 工具 | C |
| `simple_ai/tools/agent.rs` | **新建** dispatch_agent 工具（Phase 5） | C |
| `simple_ai_protocol.rs` | StreamState 加 usage 解析；build_request_body 加 stream_options | D |
| `commands/chat.rs` | SimpleAI 分支解析 MCP server 列表注入 options | B |
| `services/mcp_config_service.rs` | 新增 is_plugin_ai_tool_accessible 过滤 | B |
| `models/ai_event.rs` | 新增 UsageEvent | D |
| `commands/file_explorer.rs` | 新增 read_agents / read_skills 命令（仿 read_commands） | C |
| `ai/traits.rs` | SessionOptions 新增 simple_ai_mcp_servers 字段（或复用 env_overrides） | B |
| `stores/cliInfoStore.ts` | SimpleAI 模式下 agents/skills 改读本地文件 | C |

---

## 8. 分阶段实施

| 阶段 | 内容 | 验证 | 风险 | 依赖 |
|---|---|---|---|---|
| **Phase 3** | usage + retry + compact | 单测：三协议 usage 解析、退避、压缩替换；`cargo check --lib` | 中（三协议 usage 差异、压缩边界） | 无 |
| **Phase 4a** | Tool trait 异步化（机械改动，行为不变） | 现有单测全过（改 async）；`cargo check --lib` | 低 | 无 |
| **Phase 4b** | MCP client 自研 + 插件接入 + aiToolAccess 门控 | 单测：帧层 round-trip（mock server）、tool_spec 转换、命名路由；联调 bb-browser 插件 | 中高（MCP 协议合规性、子进程生命周期） | 4a |
| **Phase 4c** | Skill 索引 + read_skill 工具 | 单测：skill 发现、frontmatter 解析、索引注入；手测模型按需读 skill | 低 | 4a |
| **Phase 4d** | Agent preset（options.agent 读 .claude/agents） | 单测：agent 发现、system prompt 覆盖；手测切换 agent | 低 | 4c |
| **Phase 5** | dispatch_agent 工具（真 subagent） | 单测：子会话隔离、深度限制；联调嵌套调用 | 高（递归、事件隔离、死锁） | 4b/4d |

**建议顺序**：3 → 4a → 4b → 4c → 4d → 5。理由：
- Phase 3 独立，先做消除长任务风险。
- 4a 是 4b/4c/4d/5 的共同前置。
- 4b 是最大价值（打开插件生态），优先。
- 4c/4d 低风险快速见效。
- 5 工程量最大，单独阶段。

---

## 9. 风险与回退

| 风险 | 影响 | 缓解 | 回退 |
|---|---|---|---|
| MCP client 协议不合规（server 拒连） | 插件工具不可用 | 镜像现有 server 帧格式；单测 mock server 覆盖 initialize/tools-list/tools-call | client 失败的 server 跳过，不阻断会话 |
| Tool trait async 改造引入死锁 | 全引擎卡死 | bash 用 spawn_blocking；不持锁等 async | 回滚到同步 trait + spawn_blocking 包裹（决策 1 方案 C） |
| MCP server spawn 失败（路径/权限） | 部分工具缺失 | 复用现有 `resolve_mcp_executable_path` 路径解析；失败 log + 跳过 | 内置工具仍可用 |
| 子进程泄漏（会话结束未 kill） | 资源泄漏 | `McpClient::drop` 调 `start_kill`；会话结束显式 drop pool | — |
| compact 误删历史 | 上下文丢失 | 单测覆盖压缩区间；保留被压缩消息的 raw 副本（localStorage 兜底，复用 messageCompactor 模式） | compact 默认关闭，custom_env 开启 |
| subagent 递归失控 | 资源耗尽 | 深度限制 3 层；子会话复用父 MCP pool | dispatch_agent 工具不注册 |
| aiToolAccess 门控改变 CLI 引擎行为 | codex/claude 行为变化 | 只在 SimpleAI 路径过滤，不改 `is_plugin_mcp_enabled` 原语义 | 移除过滤 |
| Phase 3 retry 重试导致费用增加 | 成本 | 仅 429/5xx/网络错误重试；3 次上限；尊重 Retry-After | custom_env 关闭 retry |

---

## 10. 验证策略

### 10.1 编译验证（本机可执行）
- `cargo check --lib` —— 每阶段基线，零新增 warning（现有 3 个预存无关 warning：ws.rs/ipc.rs）。
- `cargo test --lib --no-run` —— 单测代码编译正确。

### 10.2 单测验证（CI 执行，本机受 [[rust-lib-test-env-limit]] 限制）
- **Phase 3**：三协议 usage 解析（喂构造的 SSE chunk）、退避次数/间隔、压缩区间替换。
- **4a**：现有 9 工具单测改 async 全过。
- **4b**：MCP 帧层 round-trip（mock stdin/stdout）、tool_spec 转换、`mcp__srv__tool` 命名路由、aiToolAccess 过滤。
- **4c**：skill 发现（tempdir 造 SKILL.md）、frontmatter 解析、索引生成。
- **4d**：agent 定义发现、system prompt 覆盖。
- **5**：子会话隔离、深度限制。

### 10.3 联调验证（手测）
- **4b**：用 `bb-browser` 插件（`.polaris/plugins/bb-browser`，`node {{pluginDir}}/mcp/server.cjs`）实测 SimpleAI 能调用 `browser_snapshot` / `site_google_search` 等工具。
- **4c**：在 `.claude/skills/test/SKILL.md` 造一个 skill，让模型自主 `read_skill`。
- **4d**：在 `.claude/agents/coder.md` 造 agent，切换后 persona 变化。
- **5**：让父会话 `dispatch_agent` 委派子任务，观察子会话事件流。

### 10.4 多轮对比验证（用户要求）
对每个关键决策（决策 1-7）的 A/B/C 方案，文档第 5 节已给出对比表 + 推荐理由。实施时若推荐方案受阻，按对比表的「回退」列切换备选方案，无需重新设计。

---

## 11. 与既有约束的对齐

- **[[dual-engineid-sync]]**：本次不新增引擎，`EngineId::SimpleAI` 已存在，无影响。
- **[[rust-lib-test-env-limit]]**：本机 `cargo test --lib` 无法启动（Tauri 原生 DLL），统一以 `cargo check --lib` + `cargo test --lib --no-run` 验证，单测逻辑由 CI 执行。
- **[[web-only-tauri-command-gate]]**：新增的 `read_agents` / `read_skills` 命令需加 `#[cfg_attr(feature="tauri-app", tauri::command)]`，web 打包不报错。
- **[[simple-ai-codex-refactor]]**：本方案是其后继，Phase 0/1/2 + A/B/C 已完成的成果（分层 persona / context 注入 / apply_patch / update_plan / glob / history 裁剪 / 超时可配）全部复用，不重写。
- **[[manualchunks-circular-dep]]**：新增模块均在 `simple_ai/` 内部，不跨 chunk，无循环依赖风险。
- **[[hydrate-localstorage-parse-cache]]**：compact 的被压缩消息兜底复用 messageCompactor 的 localStorage 模式，不新引入缓存层。

---

## 12. 已确认决策（2026-07-04 拍板）

1. **MCP client 协议版本**：用最新 `2025-06-18`。⚠️ 现有 6 个内置 MCP server 按 `2024-11-05` 实现，client 必须在 `initialize` 握手时读取 server 返回的 `protocolVersion` 并降级兼容（若 server 返回旧版本，按旧版本走；`tools/list` / `tools/call` 在两版本下语义一致，仅握手字段不同）。
2. **Skill 文件位置**：`work_dir/.polaris/skills/*/SKILL.md`（与 Polaris 自身的 `.polaris/` 约定一致，不复用 Claude Code 的 `.claude/skills/`）。frontmatter 字段：`name` / `description`。
3. **Agent preset 与 `options.system_prompt` 优先级**：用户显式传 `system_prompt` 时**完全覆盖**（与现有 `start_session` 语义一致），agent 定义仅在未传 `system_prompt` 时生效。
4. **dispatch_agent 默认注册**：默认开启，深度限制 3 层防递归失控。可用 `custom_env` 的 `SIMPLE_AI_DISABLE_SUBAGENT=1` 关闭。
5. **context_window 来源**：`custom_env` 的 `SIMPLE_AI_CONTEXT_WINDOW`（默认 128000），不改 `ModelProfile` 结构（与 `SIMPLE_AI_TIMEOUT_SECS` 模式一致）。
6. **MCP server 列表传递方式**：`SessionOptions` 新增 `mcp_servers: Vec<ResolvedExternalMcpServer>` 字段（类型已 `Serialize`），不复用 `env_overrides` 序列化，避免 env 滥用。
7. **`is_plugin_ai_tool_accessible` 影响范围**：只对 SimpleAI 路径过滤（新增独立函数 `is_plugin_ai_tool_accessible`，不改 `is_plugin_mcp_enabled` 原语义），CLI 引擎行为不变。

---

## 13. 结论

本方案的核心价值在于**打通 SimpleAI 与 Polaris 插件生态的最后一公里**：通过自研 stdio MCP client（~250 行，零新依赖），让内置轻量引擎能消费所有内置 MCP server 与第三方插件工具，再辅以 skill（progressive disclosure）、agent preset、subagent 三层身份/能力扩展，以及 Phase 3 健壮性补全，使 SimpleAI 在「用户配置任意 OpenAI 兼容 API」的场景下，达到与 codex / Claude Code 接近的 agent 体验。

实施顺序遵循「先消除风险（Phase 3）→ 解锁能力（4a 异步化）→ 最大价值（4b MCP 接入）→ 快速见效（4c/4d skill/agent）→ 高阶能力（5 subagent）」的路径，每阶段独立可验证，可随时止步于任意阶段而不影响已完成成果。

---

## 14. 实施记录（2026-07-04 完成）

全部 8 个阶段已实施，`cargo check --lib` + `cargo test --lib --no-run` 通过，零新增 warning。

| 阶段 | 状态 | 关键产出 |
|---|---|---|
| **4a** Tool trait 异步化 | ✅ | `Tool::execute` 改 `async_trait`；9 工具签名改造（bash/computer 用 `spawn_blocking`，其余直接 async）；`ToolRegistry::dispatch` 改 async；现有单测改 `#[tokio::test]`。顺手修 2 个预存测试编译错误（`mcp_config_service` 缺 `services` 字段、`integration_tests` AppState 缺 `plugin_service_manager`）。 |
| **3.2** retry 指数退避 | ✅ | 新建 `retry.rs`：`is_retryable_status`/`backoff_delay`/`parse_retry_after` 纯函数 + `send_with_retry`（429/5xx/网络错误重试，尊重 `Retry-After`，默认 3 次 base 500ms，`SIMPLE_AI_RETRY_MAX`/`SIMPLE_AI_RETRY_BASE_MS` 可覆盖）。chat_loop HTTP 请求改走 `send_with_retry`。 |
| **3.1** usage 三协议解析 | ✅ | `simple_ai_protocol.rs` 加 `Usage` 结构 + `StreamState.usage` 字段 + 三协议解析（OpenAIChat 末包 + `stream_options.include_usage`；Anthropic `message_start`/`message_delta` 分两次累积；Responses `response.completed`）+ `finish_usage()`。chat_loop 流末取 usage 累计 + 日志。 |
| **3.3** compact 上下文压缩 | ✅ | 新建 `compact.rs`：`UsageAccumulator`（累计 input，`should_compact` 达窗口 75% 触发）+ `select_compact_range`（不切断 tool 配对）+ `compact_history`（发非流式摘要请求替换历史区间，三协议响应解析 `extract_summary_text`）+ `fallback_drop_oldest`（移除最早完整 turn）。`SIMPLE_AI_CONTEXT_WINDOW` 默认 128k 可配。 |
| **4b** MCP client + 插件接入 | ✅ | 新建 `mcp/{types,client,mod}.rs`：`McpClient`（spawn 子进程 + initialize 握手 2025-06-18 降级 + tools/list + tools/call + stdout reader task 按 id 路由 + Drop kill）+ `McpClientPool`（`from_servers` 并发 spawn + `tool_specs` 缓存 + `call` 按 `mcp__{srv}__{tool}` 路由 + `parse_tool_name`）。`ToolRegistry` 加 `mcp_pool` 字段 + `with_mcp` builder + dispatch 路由 + specs 扩展。`SessionOptions` 加 `mcp_servers` 字段。`chat.rs` SimpleAI 分支解析插件 MCP + `aiToolAccess` 门控（只暴露 `ai_tool_access:true` 的插件，决策 §12-7 只对 SimpleAI 过滤）。 |
| **4c** Skill progressive disclosure | ✅ | 新建 `skill.rs`：`SkillEntry` + `discover_skills`（扫 `.polaris/skills/<name>/SKILL.md`）+ `build_skill_index_message`（注入索引 user 消息）。新建 `tools/skill.rs`：`ReadSkillTool`（按需读全文，截断 16k）。`ToolContext` 加 `skills` 字段。persona 补 skill 说明。 |
| **4d** Agent preset | ✅ | 新建 `agent.rs`：`AgentDefinition` + `discover_agents` + `load_agent`（扫 `.polaris/agents/<name>.md`，frontmatter name/description/tools + body=system prompt）。`mod.rs start_session`：`options.agent` 指定时读 agent 定义覆盖 system prompt（用户显式传 `system_prompt` 时完全覆盖，决策 §12-3）。 |
| **5** dispatch_agent subagent | ✅ | 新建 `tools/agent.rs`：`DispatchAgentTool`（读 agent 定义 → 构造子 messages system+user → 调 `run_chat_loop` depth+1 → 取最后 assistant 文本返回，截断 8k）。`ToolContext` 加 `profile`/`mcp_servers`/`subagent_depth` 字段。`SUBAGENT_MAX_DEPTH=3` 防递归。`SIMPLE_AI_DISABLE_SUBAGENT=1` 经 `ToolRegistry::without_tool` 移除（决策 §12-4 默认开启）。`ModelProfile` 加 `Default` derive（测试用）。 |

### 新增/改动文件清单

**新建**：
- `src-tauri/src/ai/engine/simple_ai/retry.rs`（Phase 3.2）
- `src-tauri/src/ai/engine/simple_ai/compact.rs`（Phase 3.3）
- `src-tauri/src/ai/engine/simple_ai/skill.rs`（Phase 4c）
- `src-tauri/src/ai/engine/simple_ai/agent.rs`（Phase 4d）
- `src-tauri/src/ai/engine/simple_ai/mcp/types.rs`（Phase 4b）
- `src-tauri/src/ai/engine/simple_ai/mcp/client.rs`（Phase 4b）
- `src-tauri/src/ai/engine/simple_ai/mcp/mod.rs`（Phase 4b）
- `src-tauri/src/ai/engine/simple_ai/tools/skill.rs`（Phase 4c）
- `src-tauri/src/ai/engine/simple_ai/tools/agent.rs`（Phase 5）

**改动**：
- `simple_ai/tools/mod.rs`：Tool trait async + ToolContext 扩展（skills/profile/mcp_servers/subagent_depth）+ ToolRegistry（mcp_pool/with_mcp/without_tool）+ 注册 ReadSkillTool/DispatchAgentTool
- `simple_ai/tools/{bash,computer,fs,search,apply_patch,plan}.rs`：execute 改 async
- `simple_ai/chat_loop.rs`：retry/compact/usage/mcp_pool/skills/depth 接入
- `simple_ai/mod.rs`：mod 声明 + start_session/continue_session 装配（skills/mcp_servers/agent/depth）
- `simple_ai/prompt.rs`：persona 补 skill 说明
- `simple_ai_protocol.rs`：Usage + stream_options + 三协议 usage 解析
- `ai/traits.rs`：SessionOptions 加 mcp_servers + with_mcp_servers
- `commands/chat.rs`：PreparedMcpConfig 加 simple_ai_mcp_servers + SimpleAI 分支解析 + aiToolAccess 门控
- `models/config.rs`：ModelProfile 加 Default derive

### 已知后续待办（低优先级）

- **`read_agents` / `read_skills` 命令**：前端 agent/skill 选择器在 SimpleAI 模式下需读 `.polaris/agents` / `.polaris/skills`，当前后端核心已就绪，命令注册 + 前端 cliInfoStore 适配待补。
- **subagent 共享 MCP pool**：当前子会话重新 spawn MCP server（输入参数复用但进程独立），后续可传 `Arc<McpClientPool>` 共享避免重复 spawn。
- **subagent 父中断联动**：子会话当前用独立 abort_rx，父中断不联动子会话（TODO）。
- **MCP server env 传递**：`ResolvedExternalMcpServer` 不携带 env，插件 MCP 需 env（如 API_KEY）的场景待扩展。
- **专用 `UsageEvent`**：当前 usage 仅日志上报，前端展示需新增 `UsageEvent` 类型 + 前端 types 同步。
- **agent tools 白名单过滤**：`AgentDefinition.tools` 已解析但未启用过滤（registry.specs 仍全量），后续按白名单过滤。
