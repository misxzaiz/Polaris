# Claude Code CLI 能力对齐分析

> 梳理 Claude Code CLI 当前能力与 Polaris 实际集成的差距，识别可整合的"升级"内容。

| 项 | 值 |
|---|---|
| 分析日期 | 2026-06-06 |
| 本机 CLI 版本 | 2.1.160 |
| 官方最新版本 | 2.1.166（2026-06-06） |
| 分析范围 | `claude --help` 全量 flag/子命令 × Polaris 后端调用现状 |
| 结论 | 集成扎实，存在 4 项高价值未整合能力，其中 P0-1 直接影响聊天体验 |

---

## 一、结论速览

- 本机 CLI **2.1.160**，官方最新 **2.1.166**，落后 6 个补丁版；其中 2.1.161/162/163 均为 `-p`/stream-json/SDK 模式的关键修复，建议优先升级到 ≥2.1.163。
- Polaris 后端固定基底 `claude --print --verbose --output-format stream-json --input-format stream-json --permission-mode bypassPermissions`，按需追加 14 个 flag。
- **头号发现**：Polaris 对 Claude 引擎当前**没有真正的逐字增量流式**——缺 `--include-partial-messages`，且解析层认的 `text_delta` 事件 Claude 不发。每轮回复为整段 `assistant` 消息一次性渲染（详见 P0-1 与配套实施文档 `p0-1-incremental-streaming.md`）。
- 代码中存在 2 处过时认知需修正（`--effort` 已官方化；`text_delta`/`tool_start`/`tool_end` 扁平事件对 Claude 引擎为死代码）。

---

## 二、现状盘点：Polaris 已整合的能力

| 类别 | 已用 flag / 能力 | 构造位置 |
|---|---|---|
| 基底（无条件） | `--print` `--verbose` `--output-format stream-json` `--input-format stream-json` `--permission-mode` | `claude.rs` `build_command` |
| 会话 | `--resume` `--fork-session` | `claude.rs:330-334 / 430-434` |
| 上下文 | `--add-dir` `--append-system-prompt` `--system-prompt` | `claude.rs:339-355 / 439-455` |
| 模型/MCP/Agent | `--model` `--mcp-config` `--agent` `--effort` `--settings`(端点 overlay) | `claude.rs:359-389 / 459-489` |
| 权限 | `--allowedTools`(权限重试) | `claude.rs:396-398 / 496-498` |
| 环境变量 | `ANTHROPIC_MODEL/BASE_URL/AUTH_TOKEN/...` `CLAUDE_CODE_GIT_BASH_PATH` | `configure_command` `claude.rs:522-546` |
| 探测 | `claude --version` / `agents` / `auth status` | `cli_info_service.rs` |

设计亮点：消息走 stdin（规避 Windows `lpCommandLine` 32K 限制）、`--resume` 多轮、init 事件读真实 session_id。

---

## 三、可整合的"升级"内容（按优先级）

### P0 — 高价值且契合现有架构

| 编号 | 能力 | 价值 | 状态 |
|---|---|---|---|
| P0-1 | `--include-partial-messages` 真增量流式 | 打字机体验，提升最大 | **实施中**（见 `p0-1-incremental-streaming.md`） |
| P0-2 | `--session-id <uuid>` 指定会话 ID | 消除"临时 ID→真实 ID"映射，简化架构 | 待办 |
| P0-3 | `--strict-mcp-config` | MCP 集合 100% 由 Polaris 掌控，避免外部 `.mcp.json` 混入 | 待办（一行级改动） |
| P0-4 | `--fallback-model` | 主模型过载自动回退（仅 `--print` 生效，Polaris 满足；2.1.166 增强） | 待办 |

**P0-1 详解**：基底已含 `--print` + `stream-json`，满足该 flag 全部前置条件，但 `build_command` 未传它。Claude 原生 stream-json 在不加该 flag 时只发完整 `assistant` 消息；加之后发 `stream_event` 包 `content_block_delta`（非 `text_delta` 扁平事件）。因此 `event_parser.rs:121` 的 `TextDelta` 分支对 Claude 为死代码，用户看到"思考中…→整段回复"，无打字机效果。

**P0-2 详解**：当前首轮生成临时 UUID（`claude.rs:941`）→ 监听 init 的 `session_id` → `update_session_id_shared` 映射 → 回调前端。改用 `--session-id <new_v4>` 后整条映射可删除，续轮照常 `--resume`。附带收益：新版 stdio MCP 子进程会收到 `CLAUDE_CODE_SESSION_ID`，固定 ID 后内置 MCP（todo/需求/调度）能稳定按会话关联。

**P0-3 详解**：当前用 `--mcp-config` 传自生成配置，但 CLI 仍叠加 `~/.claude` 与项目 `.mcp.json` 的 server，导致禁用列表不彻底、可能重复加载。有 `--mcp-config` 时追加 `--strict-mcp-config` 即可彻底受控。

### P1 — 产品增强

| 能力 | 价值 | 落点 |
|---|---|---|
| `ultrareview`(子命令) | 云端多 agent 代码审查 | GitPanel "AI 审查当前分支/PR" |
| init 富数据未解析 | 低成本 | init 事件已含 `slash_commands`/`plugins`/`output_style`/`permissionMode`/`fast_mode_state`/`memory_paths`，`parse_init_event`(`event_parser.rs:201`) 仅取 6 项 |
| `--include-hook-events` | hooks 可视化 | stream-json 适用；当前 hook 事件被静默忽略(`event_parser.rs:192`) |
| `--disallowedTools` | 工具黑名单 | 与现有 `--allowedTools` 互补 |
| `--tools` | 内置工具集开关 | `"Bash,Edit,Read"` 粒度控制 |
| `--max-budget-usd` | 成本上限 | 仅 `--print` 生效；第三方端点/API Key 友好 |
| `--json-schema` | 结构化输出 | Todo/需求"AI 提取"场景 |
| `--prompt-suggestions` | 下一步建议 | print 模式每轮后发 `prompt_suggestion`，做快捷气泡 |
| `--agents <json>` | 临时自定义 agent | 无需落盘 `.claude/agents`（注意与单数 `--agent` 不同） |
| `-n, --name` | 会话命名同步 | `/resume` picker / 终端标题 |

### P2 — 诊断与边缘（按需）

`--debug-file`（一键收集排障日志）、`doctor`/`update|upgrade`（设置页"健康检查/更新 CLI"）、`--setting-sources`（控制加载 user/project/local）、`--exclude-dynamic-system-prompt-sections`（跨会话 prompt-cache 复用，与 `--system-prompt` 互斥）、`--bare`（极简快速模式）、`--from-pr`（从 PR 恢复，配合 GitPanel）、`--plugin-dir`/`--plugin-url`（插件加载）。

**确认不适用/冲突**：`--ide`/`--tmux`/`--worktree`/`--remote-control`/`--chrome`（GUI 自身已覆盖或交互式专用）、`--no-session-persistence`（与 `--resume` 冲突）、`-c/--continue`（`--resume` 更精确）。

---

## 四、需修正的认知偏差

1. **`--effort` 已是官方 flag**：`claude.rs` 注释疑其为"非标准/第三方端点专用"，但 2.1.160 `--help` 实证它是官方参数（`low/medium/high/xhigh/max`），且 Opus 4.8 主打 high-effort 默认。可放心保留，并考虑在 UI 暴露 `xhigh/max` 档。
2. **`text_delta`/`tool_start`/`tool_end` 扁平事件对 Claude 引擎为死代码**：Claude 把 `tool_use` 放在 `assistant` 消息的 content blocks 内，不发独立 `tool_start/end`；增量需 `stream_event` 包 `content_block_delta`。这些分支应为 Codex 引擎共用——P0-1 实施时一并理清。

---

## 五、CLI 版本健康度：2.1.160 → 建议 ≥2.1.163

| 版本 | 与 Polaris 相关的修复 |
|---|---|
| 2.1.163 | 修复 `claude -p` 在后台命令不退出时永久 hang |
| 2.1.162 | 修复 stream-json/SDK 会话开头 Esc 中断被静默丢弃 |
| 2.1.161 | 修复后台子 agent 输出污染 `-p` stdout |
| 2.1.166 | `--fallback-model` 增强 + `fallbackModel` setting（对应 P0-4） |
| 2.1.163 | 新增 `requiredMinimumVersion/Maximum` 托管设置——Polaris 可借此做最低 CLI 版本校验 |

---

## 六、落地建议（最小改动路径）

1. **升级 CLI 到 ≥2.1.163**（零代码，立即收益）。
2. **P0-3 `--strict-mcp-config`**：一行级，风险最低。
3. **P0-1 真增量流式**：体验提升最大（本轮实施，见配套文档）。
4. **P0-4 `--fallback-model`** + **P0-2 `--session-id`**：稳定性与架构简化，可分批。

---

## 参考

- [Claude Code changelog](https://code.claude.com/docs/en/changelog)
- [anthropics/claude-code releases](https://github.com/anthropics/claude-code/releases)
- 本机实证：`claude --help` / `claude --version`（2.1.160）、`stream-json` init 事件输出
- 源码证据：`src-tauri/src/ai/engine/claude.rs`、`event_parser.rs`、`models/events.rs`、`commands/chat.rs`
