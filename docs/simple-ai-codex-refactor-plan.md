# SimpleAI 引擎重构规划（对照 OpenAI Codex）

> 状态：**Phase 0 + 1 + 2 已实施（2026-06-07）**；Phase 3 待续。
> 验证：本机 `cargo check --lib` 通过、单测编译通过；本机 Tauri DLL 限制无法运行测试，单测随 CI 执行。详见 §11 实施记录。
> 范围：基本对话 · 工具使用 · AI 身份定位 · 项目指令注入（不含权限/sandbox/审批）
> 参考源码：`temp/codex/codex-rs`（openai/codex 浅克隆）

## 1. 背景与目标

`SimpleAI` 是 Polaris 内置的轻量 AI 引擎，直连用户在「模型供应商」配置的 OpenAI 兼容 API，作为 Claude Code CLI 未安装时的备用方案（`src-tauri/src/ai/engine/simple_ai.rs`）。

**现状评估**：

| 维度 | 现状 | 评价 |
|---|---|---|
| 基本对话 | `run_chat_loop`（`simple_ai.rs:574`）流式 SSE，三协议适配（OpenAIChat/Anthropic/Responses，见 `simple_ai_protocol.rs`），会话回写/中断/续接完整 | 已完善 |
| 工具使用 | 6 工具（bash/read_file/write_file/list_directory/edit_file/search_files，`simple_ai.rs:36`），`match name` 串行分发，最多 40 轮 | 基础够用、偏弱 |
| AI 身份 | `build_system_prompt`（`simple_ai.rs:534`）仅一段话 + OS/shell + 工具清单 | 最薄弱 |
| 项目指令 | 仅 `append_system_prompt` 透传工作区信息，无 AGENTS.md/CLAUDE.md 加载 | 缺失 |

**目标**：在**不引入 codex 依赖**的前提下原地重构，借鉴 codex-rs 的 agent 设计，补齐工具、身份、健壮性、项目指令四个维度。

## 2. Codex 关键设计提炼（对照来源）

- **身份/Prompt**（`core/prompt_with_apply_patch_instructions.md`、`core/gpt_5_codex_prompt.md`）：分层结构 —— 角色人格 → AGENTS.md 规范 → 响应风格（preamble/进度更新）→ 规划（update_plan 时机 + 高/低质量计划示例）→ 任务执行（keep going、根因修复、最小改动）→ 验证哲学 → 最终回复格式 → 工具指南。
- **AGENTS.md 注入**（`core/src/agents_md.rs`）：以 `.git` 等 marker 定位 project root，收集 root→cwd 路径上所有 `AGENTS.md` 按序拼接；字节预算（`project_doc_max_bytes`）截断；`AGENTS.override.md` 优先；global（CODEX_HOME）+ project 用 `--- project-doc ---` 分隔。包装为 user 消息：`# AGENTS.md instructions for <dir>\n\n<INSTRUCTIONS>\n…</INSTRUCTIONS>`（`core/src/context/user_instructions.rs`）。
- **环境上下文**（`core/src/context/environment_context.rs`）：XML 片段作为 user 消息注入，字段含 `<cwd>/<shell>/<current_date>/<timezone>/<network>/<filesystem>`；turn 间做 diff，仅变化时重发，shell 仅首轮注入。
- **update_plan 工具**（`core/src/tools/handlers/plan_spec.rs`）：参数 `explanation?` + `plan[]{step: string, status: pending|in_progress|completed}`，约束「至多一个 in_progress」。
- **apply_patch**（`core/prompt_with_apply_patch_instructions.md:280` 起）：自定义 diff 信封格式（见 §5.2）。
- **工具架构**（`core/src/tools/registry.rs`、`router.rs`、`parallel.rs`）：`ToolRegistry` + `ToolHandler::handle()` + `dispatch_any()`，每工具一个 handler 文件；支持并行。
- **上下文压缩**（`core/src/compact.rs`、`prompts/templates/compact/prompt.md`）：达阈值时用「交接摘要」prompt 把历史总结为 summary 替换历史；兜底「超窗口则移除最老项」。
- **token 窗口**（`core/src/state/auto_compact_window.rs`）：以 server 观测的 input_tokens 为基线追踪增长，驱动自动压缩。

## 3. 目标模块结构

当前 `simple_ai.rs`（1213 行）+ `simple_ai_protocol.rs`。重构为子模块（`simple_ai_protocol.rs` 保留）：

```
src-tauri/src/ai/engine/simple_ai/
├── mod.rs           # SimpleAIEngine（AIEngine impl）+ 会话表 + profile 解析
├── session.rs       # SimpleAISession（messages/abort/usage 状态）
├── chat_loop.rs     # run_chat_loop（请求 → 流式 → 工具循环 → retry/compact 触发）
├── prompt.rs        # 分层系统提示词构建
├── context.rs       # environment_context + AGENTS.md/CLAUDE.md 发现与注入
├── compact.rs       # 上下文压缩（摘要替换）
├── usage.rs         # 三协议 token usage 解析与累计
└── tools/
    ├── mod.rs       # Tool trait + ToolRegistry + dispatch + 统一截断
    ├── bash.rs
    ├── fs.rs        # read_file / write_file / list_directory / edit_file
    ├── search.rs    # search_files（内容）+ glob（文件名）
    ├── apply_patch.rs   # 补丁解析 + 应用
    └── plan.rs      # update_plan
```

`simple_ai_protocol.rs` 仅增量修改：新增 usage 解析（§6.1）。apply_patch/update_plan/glob 均为普通 OpenAI function tool，复用现有 `tools_for_protocol` 三协议转换，无需特殊处理。

## 4. 维度一：AI 身份与系统提示词

**问题**：现 prompt 几乎不含 agent 行为约束，模型容易浅尝辄止、不规划、不验证。

**方案**：在 `prompt.rs` 实现分层构建（保留 `options.system_prompt` 的完全覆盖语义）。结构借鉴 codex，但精简到适配「轻量内置助手」，并去掉权限/审批相关段落。

**新 system prompt 草稿（英文 base；模型对英文系统指令更敏感，末尾要求按用户语言回复）**：

```text
You are Polaris Assistant, a capable AI coding agent built into the Polaris
desktop app. You run against a user-configured model provider and can use tools
to read, search, and edit files and run shell commands to resolve tasks end to end.

# How you work
- Autonomy: keep working until the user's request is fully resolved before
  yielding. Do not guess or fabricate—use tools to verify facts and outcomes.
- Communication: be concise, direct, and friendly. Before a group of tool calls,
  send one short sentence on what you're about to do. Avoid filler.
- Planning: for non-trivial, multi-step work, use the `update_plan` tool to lay
  out 3–6 verifiable steps and keep exactly one step in_progress. Skip planning
  for simple, single-step requests.
- Editing: prefer `apply_patch` for file edits; fix root causes; keep changes
  minimal and consistent with existing style; don't add license headers or
  gratuitous comments.
- Tools: prefer dedicated tools (`search_files`, `glob`, `read_file`,
  `apply_patch`) over shell equivalents—they behave identically across platforms.
- Verification: when the project can be built or tested, verify your change;
  start narrow (the code you touched), then broaden.

# Final answer
- Lead with the outcome; reference file paths (clickable), not full dumps.
- Reply in the user's language. Keep it scannable and brief by default.
```

- **环境信息不写死在 persona**，改由 `environment_context`（§7）动态注入，避免 prompt 僵化。
- Windows/cmd.exe 的 shell 提示从现 `build_system_prompt` 迁移到 `environment_context` 的 `<shell>` + 一条工具指南。
- `append_system_prompt`（工作区信息）逻辑保留。

## 5. 维度二：工具能力扩展

### 5.1 架构重构（注册表 + Trait）

把 `execute_tool` 的 `match name`（`simple_ai.rs:462`）升级为注册表：

```rust
pub struct ToolContext<'a> { pub work_dir: &'a str, /* 预留 abort/usage 等 */ }

pub trait Tool: Send + Sync {
    fn name(&self) -> &'static str;
    fn spec(&self) -> serde_json::Value;          // OpenAI function schema
    fn execute(&self, args: &Value, ctx: &ToolContext) -> ToolOutcome;
}

pub struct ToolRegistry { tools: Vec<Box<dyn Tool>> }
impl ToolRegistry {
    pub fn specs(&self) -> Vec<Value>;            // 替代 builtin_tools()
    pub fn dispatch(&self, name: &str, args: &Value, ctx: &ToolContext) -> ToolOutcome;
}
```

收益：新增工具不再改动 `chat_loop`；`ToolOutcome`（`simple_ai.rs:173`）与统一截断 `truncate_chars` 复用。并行执行先不做（OpenAI 串行 tool_calls 更稳），`Tool` 签名预留无状态以便后续并行。

### 5.2 新增工具

**`apply_patch`**（核心升级，替代 `edit_file` 的单点替换上限）—— 移植 codex 补丁信封格式：

```
*** Begin Patch
*** Add File: <path>        # 后续每行以 + 开头
*** Delete File: <path>
*** Update File: <path>
[*** Move to: <new path>]   # 可选重命名
@@ [上下文锚点]
 context
-old
+new
*** End Patch
```

实现 `parse_patch()`（解析为 `Vec<FileOp>`）+ `apply_patch()`（按 op 增删改、唯一锚点定位）。相比 `edit_file`：单次可改多文件、新建、删除、重命名，且带上下文行更鲁棒。`edit_file` 保留（小改场景仍方便）。

**`update_plan`**（计划工具）—— schema 完全照搬 codex（§2）：

```json
{"explanation": "string?",
 "plan": [{"step": "string", "status": "pending|in_progress|completed"}]}
```

执行副作用：发出计划事件给前端（事件映射见 §8 待确认决策）。工具本身返回 `ok("plan updated")`。

**`glob`**（按文件名查找）—— 补 `search_files` 只搜内容的空白。参数 `pattern`（如 `**/*.rs`）+ 可选 `path`，复用 `walkdir` + 跳过依赖目录，结果数量截断。

### 5.3 工具清单（重构后）

| 工具 | 来源 | 说明 |
|---|---|---|
| bash / read_file / write_file / list_directory / edit_file / search_files | 现有 | 行为不变，迁移到 `tools/` |
| `apply_patch` | 新增 | 多文件补丁，模型首选编辑方式 |
| `update_plan` | 新增 | 计划/进度，复用前端 Plan 事件 |
| `glob` | 新增 | 按文件名 pattern 查找 |

## 6. 维度三：对话循环健壮性

### 6.1 Token usage 统计

- 在 `simple_ai_protocol.rs` 的 `StreamState` 增加 usage 解析：
  - OpenAIChat：末包 `usage{prompt_tokens,completion_tokens,total_tokens}`（需请求带 `stream_options:{include_usage:true}`）。
  - Anthropic：`message_start.message.usage.input_tokens` + `message_delta.usage.output_tokens`。
  - Responses：`response.completed.response.usage`。
- `usage.rs` 累计每轮 usage；通过事件上报前端（**需新增 `UsageEvent`**，§8）。

### 6.2 上下文压缩

- 触发：累计 input tokens 估算超过阈值（默认按模型上下文窗口 ~75%，窗口大小可配置/给保守默认如 128k）。
- 动作（`compact.rs`）：把 system 之后、最近一条 user 之前的历史，连同一段「交接摘要」指令（照搬 `prompts/templates/compact/prompt.md` 语义）单独发一次非流式请求，得到 summary，替换被压缩区间为单条 summary 消息。
- 兜底：压缩请求若仍超窗口 → 移除最老历史项后重试（参考 `compact.rs:255`）。
- 前端提示：压缩期间发 `Progress("正在压缩上下文…")`。

### 6.3 失败重试

- 现状：HTTP 非 2xx 直接 `Err`（`simple_ai.rs:651`）。
- 方案：对 `429 / 5xx / 网络错误`做指数退避重试（默认 3 次，base 500ms，尊重 `Retry-After` 头）。`400/401/403` 等不可重试错误立即返回。重试仅在「整轮请求发起阶段」，流中断单独处理（可选：重连或终止当前轮）。

### 6.4 超时

- 现状固定 300s（`simple_ai.rs:621`）→ 提为常量/可配置（首字节超时与总超时分离更佳，先做总超时可配）。

### 6.5 中断

- 保留现有 `watch::channel` 中断机制（`simple_ai.rs:602`、`672`），无需改动。

## 7. 维度四：项目指令注入

在 `context.rs` 实现，复刻 codex 设计并适配 Polaris：

- **发现**：从 `work_dir` 向上找 project root（marker `.git`），收集 root→cwd 路径上的指令文件，按序拼接；总字节预算（如 32KB）截断。
- **文件名**：`AGENTS.md` + **`CLAUDE.md`**（Polaris 自身用 CLAUDE.md，建议同时支持；优先级与去重需定，见 §8）。
- **包装**：作为 user 消息，`# Project instructions for <dir>\n\n<INSTRUCTIONS>\n{text}\n</INSTRUCTIONS>`。
- **environment_context**：首轮注入 user 消息，精简 XML：
  ```xml
  <environment_context>
    <cwd>...</cwd>
    <shell>cmd.exe | sh</shell>
    <os>Windows | macOS | Linux</os>
    <current_date>YYYY-MM-DD</current_date>
  </environment_context>
  ```
- **组装顺序**（`start_session`）：
  `system(prompt.rs)` → `user(environment_context)` → `user(project instructions)` → `message_history` → `user(首轮消息)`。
  续接（`continue_session`）不重复注入 environment_context/项目指令（已在历史中）。

## 8. 待确认决策（需拍板）

1. **update_plan → 前端事件映射**：现有 `AIEvent` 已有重型 PlanMode 事件（`PlanContent` 含 stage→task 两层 + 审批流，`ai_event.rs:575`）。codex 的 plan 是扁平 step。三选一：
   - (A) 复用 `PlanContent`：用单个 stage 装所有 step（零新增类型，但语义略错配）；
   - (B) 新增轻量 `PlanUpdateEvent { steps: [{step,status}] }`（语义最贴合，需前后端各加一类型）；
   - (C) 暂用 `Progress` 文本呈现（最省，但无结构化 UI）。
   *倾向 B*，但取决于前端 PlanMode UI 现状（实施 Phase 2 时先核查前端消费方）。
2. **Token usage 事件**：无现成类型 → 新增 `UsageEvent { inputTokens, outputTokens, totalTokens }`（前后端同步）。确认是否需要前端展示，否则仅日志。
3. **AGENTS.md 与 CLAUDE.md 并存策略**：同目录两者都在时，拼接 / 取其一 / CLAUDE.md 优先？*倾向都拼接，AGENTS.md 在前*。
4. **Prompt 语言**：英文 base + 「按用户语言回复」（推荐）/ 纯中文 / 跟随全局设置。
5. **上下文窗口大小来源**：模型无法自报窗口 → 用保守默认（如 128k）还是 Profile 增配字段？

## 9. 分阶段实施

| 阶段 | 内容 | 验证 | 风险 |
|---|---|---|---|
| Phase 0 | 模块拆分 `simple_ai.rs → simple_ai/`，行为不变 | `cargo check --lib` + 现有单测全过 | 低（纯搬运） |
| Phase 1 | `prompt.rs` 重写 + `context.rs`（env + AGENTS.md/CLAUDE.md 注入） | 单测：发现/拼接/预算截断；手测对话身份 | 低 |
| Phase 2 | `tools/` 注册表 + `apply_patch` + `update_plan` + `glob` | 单测：补丁解析/应用、glob；联调工具调用 | 中（apply_patch 解析器 + 前端 plan 映射） |
| Phase 3 | `usage` + retry + compact | 单测：usage 解析（三协议）、压缩触发与替换、退避 | 中（三协议 usage 差异、压缩边界） |

> 注：本机 `cargo test --lib` 无法启动（Tauri 原生 DLL，见项目记忆），统一以 `cargo check --lib` 验证编译 + 纯函数单测覆盖逻辑。

## 10. 风险与对齐

- **双 EngineId 同步陷阱**（项目记忆）：本次不新增引擎，`EngineId::SimpleAI` 已存在，无影响。
- **`simple_ai_protocol.rs` 不破坏**：新增工具走既有 `tools_for_protocol`；仅增量加 usage 解析。
- **`apply_patch` 实现成本**：codex 格式语法清晰（prompt 已含完整 grammar），解析器约 150–250 行 + 充分单测可控。
- **compact 额外开销**：每次压缩多一次 API 调用；仅在超阈值时触发，低频。
- **会话语义保持**：现有 `start_session`/`continue_session` 的历史回写、运行标记、中断竞态处理（`simple_ai.rs:947` 注释）必须保留。

## 11. 实施记录

### Phase 0（完成 · 模块拆分，纯搬运）

- `simple_ai.rs`（1213 行）拆分为 `src-tauri/src/ai/engine/simple_ai/` 目录：
  `mod.rs`（引擎 + AIEngine impl + profile 解析）、`session.rs`、`prompt.rs`、`chat_loop.rs`、`tools.rs`。
- 逐函数精确搬运，行为不变；原 `simple_ai.rs` 已删除。`engine/mod.rs` 无需改动（`mod simple_ai;` 自动解析到目录）。
- 子模块经绝对路径 `crate::ai::engine::simple_ai_protocol` 访问协议层（私有 mod 对后代可见）。
- 现有单测（`apply_string_edit` / `truncate_chars` / `execute_edit_file` / `execute_search_files` 系列）一并迁移到 `tools.rs`。

### Phase 1（完成 · 身份 + 项目指令注入）

- **`prompt.rs` 重写**：分层 persona（角色 → How you work：autonomy/communication/planning/editing/tools/verification → final answer），英文 base + 「按用户语言回复」。环境信息移出 persona。
  - ⚠️ persona **仅描述现有 6 个工具**，未提 `apply_patch`/`update_plan`/`glob`（Phase 2 加入这些工具后再同步补充，避免诱导模型幻觉调用）。已加单测 `persona_does_not_reference_unimplemented_tools` 守护。
- **新增 `context.rs`**：
  - `environment_context`：`<cwd>/<os>/<shell>/<current_date>` XML 片段。
  - 项目指令发现：向上找 `.git` 定位 root → 收集 root→cwd 路径上的 `AGENTS.md` + `CLAUDE.md`（AGENTS 在前）→ 32KB 字节预算截断 → 包成一条 user 消息（Markdown 小标题分隔，未用 XML 包裹以兼容 MD 正文）。
  - 6 个单测覆盖：env 标签、无文件、单文件发现、AGENTS/CLAUDE 顺序、层级顺序、预算截断。
- **`mod.rs` 组装顺序**：`system → user(env_context) → user(项目指令) → history → user(首轮)`；`continue_session` 不重复注入（已在历史）。
- **对规划的必要补充（§7 隐患修复）**：`simple_ai_protocol.rs` 的 `build_anthropic_body` 增加「连续 user 消息合并」。
  - 原因：SimpleAI 默认线路协议为 **Anthropic**（`from_wire_api` 默认值），要求 user/assistant 严格交替；而首轮连续 3 条 user 会被 API 拒绝。
  - 处理：相邻 user 字符串拼接；若上一条 user content 已是数组（tool_result block）则追加 text block。加 2 个单测覆盖。
  - OpenAIChat / Responses 协议接受连续 user，无需改动。

### 验证

- `cargo check --lib` 通过（仅 3 个**预先存在**的无关 warning：`ws.rs` / `ipc.rs`）。
- `cargo test --lib --no-run` 通过（全部单测代码编译正确）。
- 本机运行测试报 `STATUS_ENTRYPOINT_NOT_FOUND (0xc0000139)`（Tauri 原生 DLL，与项目既知限制一致）→ 单测逻辑由 CI 验证。

### Phase 2（完成 · 工具注册表 + apply_patch/update_plan/glob）

- **架构**：`tools.rs` → `tools/` 目录。`tools/mod.rs` 定义 `Tool` trait + `ToolContext` + `ToolRegistry`（`with_builtins`/`specs`/`dispatch`），每工具一个文件，新增工具无需改 `chat_loop`。
- **迁移**：bash / read_file / write_file / list_directory / edit_file / search_files 行为不变，迁入 `tools/{bash,fs,search}.rs`。
- **新增工具**：
  - `apply_patch`（`tools/apply_patch.rs`）：codex V4A 信封格式 parse + apply，支持单次多文件 增/删/改/重命名 + 上下文锚点定位（行尾空白容错）。
  - `glob`（`tools/search.rs`）：自实现 glob matcher（`*`/`**`/`?`，'/' 敏感），不引入新依赖。
  - `update_plan`（`tools/plan.rs`）：扁平 step → 单 stage 的 `PlanContent` 事件。
- **§8.1 决策 = 方案 A（复用 `plan_content`）**。前端核查结论：审批 UI 仅在 `status==pending_approval && isActive` 出现（`PlanModeBlockRenderer.tsx:255`），`plan_approval_request` 是独立事件触发。故 update_plan 用 `status=Executing/Completed`、不发 approval 事件 → 复用现成计划面板、零前端改动、绝不卡 UI。
  - `appendPlanModeBlock` 非幂等（`createConversationStore.ts:568`）→ 每轮首次发 `plan_start` 建 block、后续只发 `plan_content`，由 `ToolContext::plan_started`（per `run_chat_loop` 的 `AtomicBool`）保证；`plan_id = {session_id}-plan`。
- **chat_loop**：去掉 `tools` 入参，内部 `ToolRegistry::with_builtins()` + `registry.specs()`，每次 dispatch 构造 `ToolContext`。
- **persona**：补充 apply_patch/update_plan/glob 使用指引（`prompt.rs`）。
- **验证**：`cargo check --lib` + `cargo test --lib --no-run` 通过（仅 3 个预存无关 warning）；新增单测覆盖 apply_patch 解析/应用/move、glob matcher、update_plan 事件序列、registry 聚合。

### 下一步（待续）

- **Phase 3**：`usage`（三协议 token 解析）+ retry（指数退避）+ compact（上下文压缩）。
```
