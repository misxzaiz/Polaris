# 现状分析：已实现 vs 未实现（深度修订版）

**分析日期**: 2026-04-15
**版本**: v2.0 — 基于源码逐行对照

---

## 一、Polaris 现有实现完整清单

### 1.1 AI 引擎配置 — `AIEngineTab.tsx` (112行)

**实现程度**: ★★☆☆☆

| 功能 | 状态 | 代码位置 | 说明 |
|------|------|---------|------|
| 引擎选择 | ✅ | L17 FIXED_ENGINE_OPTIONS | 仅 `claude-code` 一个选项，硬编码 |
| CLI 路径配置 | ✅ | ClaudePathSelector 组件 | 支持 3 种路径模式 |
| 版本号显示 | ✅ | healthStatus.claudeVersion | 从后端获取 |
| 认证状态 | ❌ | - | 完全未实现 |
| Agent 管理 | ❌ | - | 不在此 Tab 中 |
| 模型管理 | ❌ | - | 不在此 Tab 中 |

---

### 1.2 会话配置 — `SessionConfigSelector.tsx` (355行) + `sessionConfig.ts`

**实现程度**: ★★★☆☆

| 功能 | 状态 | 代码位置 | 问题 |
|------|------|---------|------|
| Agent 选择 | ⚠️ | PRESET_AGENTS (4个) | 硬编码，与实际 8 个不匹配 |
| Model 选择 | ⚠️ | PRESET_MODELS (3个) | 硬编码，缺 max effort |
| Effort 级别 | ⚠️ | EFFORT_OPTIONS (3级) | 硬编码，CLI 支持 4 级 (含 max) |
| Permission 模式 | ✅ | PERMISSION_MODE_OPTIONS (6种) | 硬编码，但与 CLI 一致 |
| 配置持久化 | ✅ | sessionConfigStore + localStorage | 正常工作 |
| 响应式布局 | ✅ | ChatStatusBar 断点适配 | 550px 切换 |

**硬编码 vs 实际对比（关键错误）**:

```
SessionConfigSelector 硬编码:
  Agent: "" (通用), "Explore", "Plan", "code-reviewer"  ← code-reviewer 不存在!

claude agents 实际输出:
  Built-in: Explore, general-purpose, Plan, statusline-setup
  Plugin: pua:cto-p10, pua:senior-engineer-p7, pua:tech-lead-p9, superpowers:code-reviewer

差异:
  1. "code-reviewer" → 实际应为 "superpowers:code-reviewer"
  2. 缺少 statusline-setup
  3. 缺少 4 个 Plugin agents
  4. 空字符串 "" 对应 "general-purpose"，名称不匹配
```

---

### 1.3 自动模式 — `AutoModeTab.tsx` (555行)

**实现程度**: ★★★★☆

| 功能 | 状态 | 代码位置 | 说明 |
|------|------|---------|------|
| Allow 规则展示 | ✅ | useAutoModeStore | 从 CLI 获取 |
| Soft-deny 规则展示 | ✅ | 同上 | 从 CLI 获取 |
| 自定义规则 CRUD | ✅ | addCustomRule/removeCustomRule | 直接操作 settings |
| JSON 高级编辑 | ✅ | 编辑模式切换 | 原始 JSON |
| 搜索过滤 | ✅ | 搜索框 | 规则文本搜索 |
| AI 规则审查 | ❌ | - | `claude auto-mode critique` 未接入 |
| 规则冲突检测 | ❌ | - | 未实现 |
| 环境信息展示 | ❌ | - | `environment` 字段未展示 |

---

### 1.4 插件管理 — `PluginTab.tsx` (920行)

**实现程度**: ★★★★☆

| 功能 | 状态 | 代码位置 | 说明 |
|------|------|---------|------|
| 插件列表展示 | ✅ | usePluginStore | 已安装 + 可用 |
| 分类导航 | ✅ | 6 种分类 (all/agent/lsp/mcp/tool/ui) | 关键词分类 |
| 虚拟滚动 | ✅ | Virtuoso | 性能优化 |
| 安装/卸载 | ✅ | 含确认弹窗 | scope 选择 |
| 启用/禁用 | ✅ | | scope 选择 |
| 更新 | ✅ | | |
| 搜索过滤 | ✅ | | |
| 市场管理 | ✅ | CRUD 完整 | |
| MCP 服务器展示 | ⚠️ | McpServerCard 组件 | 仅展示，无操作 |
| 批量操作 | ❌ | - | |
| 更新日志 | ❌ | - | |

---

### 1.5 后端 Rust 命令模块

| 模块 | 功能 | CLI 调用 | 状态 |
|------|------|---------|------|
| `commands/chat.rs` (1143行) | 会话管理 | --agent/--model/--effort/--permission-mode | ✅ 完整 |
| `commands/plugin.rs` | 插件管理 | claude plugin * | ✅ 完整 |
| `commands/auto_mode.rs` | 自动模式 | claude auto-mode * | ✅ 完整 |
| `commands/claude_settings.rs` | CLI 设置 | 读写 settings.json | ✅ 完整 |
| `commands/cli_info.rs` | CLI 信息查询 | claude agents/auth status | ❌ **不存在** |
| `commands/mcp.rs` | MCP 管理 | claude mcp * | ❌ **不存在** |

### 1.6 CLI 参数传递链路验证

```
前端 UI → sessionConfigStore → conversationStore → invoke("start_chat"/"continue_chat")
  ↓
chat.rs: ChatRequestOptions → SessionOptions::builder()
  ↓
claude.rs: 构建 CLI 参数 → --agent/--model/--effort/--permission-mode
  ↓
子进程执行 claude CLI
```

**关键细节**:
- `claude.rs` L291-318: 如果 permission_mode 为空，默认 `--permission-mode bypassPermissions`
- `allowed_tools` 已在 `ChatRequestOptions` 中定义，已在 CLI 参数构建中使用
- `--effort` 选项前端只暴露了 3 级 (low/medium/high)，CLI 实际支持 4 级 (含 max)

---

## 二、未实现功能清单（按优先级排序）

### P0 — 核心缺失（直接影响用户功能正确性）

| # | 功能 | CLI 来源 | 影响 | 实现难度 |
|---|------|---------|------|---------|
| 1 | **动态 Agent 列表** | `claude agents` 或 stream-json init | Agent ID 不匹配会导致命令失败 | 中 |
| 2 | **动态 Model 列表** | 从 Agent 默认模型提取 | 无法使用新模型 | 低 |
| 3 | **Effort 增加 max 级别** | `--effort max` | 功能缺失 | 极低 |
| 4 | **认证状态展示** | `claude auth status` | 用户不知道登录状态 | 低 |
| 5 | **MCP 服务器独立管理** | `claude mcp add/remove/get` | 只能命令行操作 | 高 |

### P1 — 重要增强

| # | 功能 | CLI 来源 | 影响 | 实现难度 |
|---|------|---------|------|---------|
| 6 | 工具白/黑名单 | `--allowedTools`/`--disallowedTools` | 无法精细权限控制 | 中 |
| 7 | MCP 连接状态实时监控 | stream-json init `mcp_servers` | 不知道 MCP 是否可用 | 低 |
| 8 | Skills 列表展示 | stream-json init `skills` | 不知道有哪些技能 | 低 |
| 9 | 预算控制 | `--max-budget-usd` | 无法限制花费 | 低 |
| 10 | 会话命名 | `--name` | 历史列表难识别 | 低 |

### P2 — 锦上添花

| # | 功能 | CLI 来源 | 影响 | 实现难度 |
|---|------|---------|------|---------|
| 11 | Worktree 管理 | `--worktree` | 无可视化 | 中 |
| 12 | JSON Schema 输出 | `--json-schema` | 高级用途 | 中 |
| 13 | 自定义 Agent 创建 | `--agents <json>` | 可视化创建 Agent | 高 |
| 14 | 调试模式切换 | `--debug` | 调试不便 | 低 |
| 15 | Chrome 集成控制 | `--chrome`/`--no-chrome` | 开关不便 | 低 |
| 16 | AI 规则审查 | `claude auto-mode critique` | 规则质量保障 | 中 |
| 17 | 环境信息展示 | `auto-mode config environment` | 信任边界理解 | 低 |

---

## 三、架构问题深度分析

### 3.1 数据源矛盾

| 数据 | 当前来源 | 应有来源 | 差距 |
|------|---------|---------|------|
| Agent 列表 | PRESET_AGENTS 硬编码 | `claude agents` 动态 | 4 个 vs 8 个，ID 不匹配 |
| Model 列表 | PRESET_MODELS 硬编码 | Agent 默认模型 + 已知列表 | 3 个，无法感知新模型 |
| Effort 级别 | EFFORT_OPTIONS 硬编码 | CLI 帮助文档 | 缺 max |
| Permission 模式 | PERMISSION_MODE_OPTIONS 硬编码 | CLI 帮助文档 | 一致，无问题 |
| MCP 服务器 | plugin.mcpServers 展示 | `claude mcp list` + init 事件 | 无状态、无操作 |
| 认证状态 | 无 | `claude auth status` | 完全缺失 |
| 可用工具 | 无 | stream-json init `tools[]` | 完全缺失 |

### 3.2 MCP 管理架构问题

```
MCP 服务器有两种来源:
  1. 插件管理的: plugin:figma:figma, plugin:playwright:playwright, plugin:supabase:supabase
     → 无法通过 claude mcp get/remove 操作
     → 只能通过插件的启用/禁用控制
     → 在 plugin list --json 中有 mcpServers 字段

  2. 用户手动添加的: chrome-devtools
     → 可以通过 claude mcp get/remove 操作
     → 有完整的 scope/command/args 信息

可视化必须区分这两种来源，提供不同的操作:
  - 插件 MCP → 链接到插件管理，启用/禁用插件
  - 用户 MCP → 直接 add/remove/edit 操作
```

### 3.3 stream-json 数据利用现状

Polaris 后端已经在使用 `stream-json` 格式接收 CLI 输出（`claude.rs` 中的 stream 处理），但 **init 事件中的丰富数据完全没有被解析和暴露给前端**。

当前只解析了:
- `assistant` 事件 (AI 回复)
- `result` 事件 (最终结果)

未解析:
- `init` 事件 (agents, tools, mcp_servers, skills, plugins, model, version)
- `hook_started` / `hook_response` 事件 (调试信息)

---

## 四、代码级修复建议

### 4.1 立即可修（零架构变更）

| 修复 | 文件 | 改动 |
|------|------|------|
| 修正 code-reviewer ID | `sessionConfig.ts` L113 | `"code-reviewer"` → `"superpowers:code-reviewer"` |
| 增加 statusline-setup Agent | `sessionConfig.ts` | 在 PRESET_AGENTS 中新增条目 |
| 增加 max effort | `sessionConfig.ts` L163-179 | 增加 `{ id: 'max', ... }` |
| 增加 Plugin agents | `sessionConfig.ts` | 新增 4 个插件 Agent 条目 |

### 4.2 Phase 1 架构改进

| 改进 | 涉及文件 | 改动 |
|------|---------|------|
| 新增 cli_info 后端模块 | `src-tauri/src/commands/cli_info.rs` (新建) | 封装 agents/auth status 调用 |
| 新增 cliInfoStore | `src/stores/cliInfoStore.ts` (新建) | 缓存 CLI 动态数据 |
| SessionConfig 动态化 | `sessionConfigStore.ts` | 从 cliInfoStore 读取 |
| 解析 init 事件 | `claude.rs` + 前端 store | 新增 init 事件处理 |

### 4.3 Phase 2 新增功能

| 功能 | 新增文件 | 说明 |
|------|---------|------|
| MCP 管理 Tab | `MCPTab.tsx` + `mcpStore.ts` + `mcp.rs` | 完整 MCP CRUD |
| 工具权限面板 | `ToolPermissionPanel.tsx` | 利用 init.tools[] 数据 |
| 认证状态 | `AuthStatusBadge.tsx` | 在 AIEngineTab 中展示 |
