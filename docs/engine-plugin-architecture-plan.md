# 引擎插件架构规划 —— 独立引擎插件 + 插件面板

> 目标：构建一个完整的独立引擎插件（含 engine-v1 适配器 + 插件面板），支持对话、续聊、配置、历史查询，验证 PluginProcessEngine 路径可用于真实引擎。
> 原则：不动原生引擎，但在主仓库补基建缺口。

---

## 1. 现状缺口（关键发现）

### 1.1 PluginProcessEngine 参数透传不足

`memory` 中记录的 `build_start_params` 增强**实际上未落地**。当前代码：

```rust
// src-tauri/src/ai/engine/plugin_process_engine.rs:311-315
let start_params = serde_json::json!({
    "session_id": current_session_id,
    "message": initial_prompt.unwrap_or_default(),
});
```

**只传了 2 个字段**，缺少真实的引擎插件所需的全部参数：

| 缺失字段 | 来源 | 用途 |
|---------|------|------|
| `work_dir` | `SessionOptions.work_dir` | 工作目录 |
| `model` | `SessionOptions.model` | 模型选择 |
| `system_prompt` | `SessionOptions.system_prompt` | 系统提示词 |
| `append_system_prompt` | `SessionOptions.append_system_prompt` | 追加提示词 |
| `env_overrides` | `SessionOptions.env_overrides` | 环境变量(API key/URL) |
| `mcp_servers` | `SessionOptions.mcp_servers` | MCP 工具列表 |
| `provider_config` | `SessionOptions.pi_provider_config` | Provider 端点配置 |
| `permission_mode` | `SessionOptions.permission_mode` | 权限模式 |
| `additional_dirs` | `SessionOptions.additional_dirs` | 额外目录 |
| `agent` | `SessionOptions.agent` | Agent 选择 |
| `effort` | `SessionOptions.effort` | 努力级别 |

### 1.2 continue_session 续聊令牌传递方式不当

当前通过 `env_overrides` 传递 `POLARIS_RESUME_TOKEN`，适配器从环境变量而非结构化 params 读取。应改为 JSON params 字段。

### 1.3 已就绪的基础设施

| 组件 | 行数 | 状态 |
|------|------|------|
| `PluginProcessEngine`（engine-v1 运行器） | 801 行 | ✅ 已落地（需补参数透传） |
| `PluginEngineConfig.adapter` + 分流 | traits.rs + registry.rs | ✅ 已落地 |
| `register_plugin_engine` Tauri command | commands/plugin_engine.rs | ✅ 已落地 |
| Web IPC 同源 | web/api/ipc.rs:1965 | ✅ 已落地 |
| 引擎元数据 Store | src/stores/engineMetadataStore.ts | ✅ 已落地 |

---

## 2. 架构设计

### 2.1 整体架构

```
┌─ Polaris 主仓库 ──────────────────────────────────────┐
│                                                        │
│  PluginProcessEngine (增强)                             │
│    ├─ build_start_params: 透传完整 SessionOptions      │
│    └─ continue_session: resume_token 走结构化 params    │
│                                                        │
│  EngineTestPanel (内置插件面板)                          │
│    ├─ 引擎列表/状态显示                                 │
│    ├─ 对话测试区: 输入 → 启动会话 → 实时事件流           │
│    ├─ 续聊测试区: 选择历史会话 → 发送消息 → 看续聊结果    │
│    ├─ 配置区: model / work_dir / 权限模式 等             │
│    └─ 历史记录区: 浏览插件引擎的会话历史                  │
│                                                        │
└───────────────┬────────────────────────────────────────┘
                │ stdin/stdout JSONL (engine-v1)
                ▼
┌─ Polaris-plugin ───────────────────────────────────────┐
│                                                        │
│  plugins/engine-test/                                   │
│    ├─ plugin.json           ← 引擎+面板声明               │
│    ├─ engine.mjs            ← engine-v1 适配器进程       │
│    ├─ panel.js              ← 独立面板（可选，备用）       │
│    └─ update.json                                      │
│                                                        │
└────────────────────────────────────────────────────────┘
```

### 2.2 engine-v1 协议增强

**start_session 请求（增强后）**：
```json
{
  "id": 1,
  "method": "start_session",
  "params": {
    "session_id": "uuid-v4",
    "message": "hello",
    "work_dir": "D:/workspace",
    "model": "deepseek-v4-flash",
    "system_prompt": "你是...",
    "append_system_prompt": "工作区信息...",
    "env_overrides": {"API_KEY": "xxx"},
    "permission_mode": "auto",
    "additional_dirs": ["D:/other"],
    "mcp_servers": [
      {"server_name": "fs", "command": "polaris_fs_mcp", "args": []}
    ]
  }
}
```

**continue_session 请求（增强后）**：
```json
{
  "id": 1,
  "method": "continue_session",
  "params": {
    "session_id": "uuid-v4",
    "message": "继续",
    "resume_token": "/path/to/session.jsonl",
    "work_dir": "D:/workspace",
    "model": "deepseek-v4-flash"
  }
}
```

**事件帧（不变）**：
```json
{"event":"ai_event","type":"assistant_message","session_id":"s1","content":"hi","is_delta":true}
{"event":"ai_event","type":"tool_call_start","session_id":"s1","tool":"bash","args":{"cmd":"ls"},"call_id":"c1"}
{"event":"ai_event","type":"tool_call_end","session_id":"s1","tool":"bash","success":true,"result":"output","call_id":"c1"}
{"event":"ai_event","type":"usage","session_id":"s1","input_tokens":100,"output_tokens":50}
{"event":"ai_event","type":"error","session_id":"s1","error":"engine failed"}
{"event":"ai_event","type":"session_end","session_id":"s1","reason":"completed"}
```

**响应帧（不变）**：
```json
{"id":1,"result":{"session_id":"s1","resume_token":"/path/to/session.jsonl"}}
{"id":1,"error":{"code":-1,"message":"engine not found"}}
```

---

## 3. 改动清单

### 3.1 主仓库 Rust 侧（核心增强）

| 文件 | 改动 | 说明 |
|------|------|------|
| `src-tauri/src/ai/engine/plugin_process_engine.rs` | 新增 `build_start_params()` 方法 | 将 `SessionOptions` 映射为完整 JSON params |
| 同上 | 修改 `start_session` 调用 `build_start_params` | 传完整参数给适配器 |
| 同上 | 修改 `continue_session` 调用 `build_start_params` | resume_token 走结构化 params，不再用 env_overrides |
| 同上 | 修改 `spawn_event_reader` 签名 | 接收 `is_continue` + `resume_token` 参数 |
| 同上 | 新增 `parse_start_params` 反序列化测试 | 验证所有字段序列化/反序列化正确 |

### 3.2 主仓库 TS 侧（插件面板）

| 文件 | 改动 | 说明 |
|------|------|------|
| `src/plugins/engine-test/manifest.ts` | **新建** | 内置插件声明 |
| `src/plugins/engine-test/EngineTestPanel.tsx` | **新建** | 面板组件（引擎列表 + 对话测试 + 续聊 + 配置 + 历史） |
| 修改 `src/plugin-system/builtinPlugins.ts` | 注册 manifest + panel loader | 懒加载面板 |
| 修改 `src/components/Layout/toolSwitcherData.tsx` | 加面板描述 | 可选 |

### 3.3 外部插件仓库

| 文件 | 改动 | 说明 |
|------|------|------|
| `plugins/engine-test/plugin.json` | **新建** | 引擎 + 面板声明 |
| `plugins/engine-test/engine.mjs` | **新建** | engine-v1 适配器，模拟/真实引擎 |

---

## 4. 面板功能设计

### 4.1 布局

```
┌─ EngineTestPanel ──────────────────────────────────┐
│                                                      │
│  ┌─ 引擎列表 ──────────────────────────────────────┐ │
│  │  ▲ claude-code (available) - 原生 Rust          │ │
│  │  ▲ codex (available) - 原生 Rust                │ │
│  │  ● dsh (available) - 原生 Rust                  │ │
│  │  ● engine-test (available) - 插件(engine-v1)    │ │
│  │  ○ omp (unavailable) - 插件(pi-rpc)            │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ 配置 ──────────────────────────────────────────┐ │
│  │  引擎: [engine-test ▼]                           │ │
│  │  模型: [deepseek-v4-flash        ]               │ │
│  │  工作目录: [D:/workspace          ]               │ │
│  │  权限模式: [auto ▼]                             │ │
│  │  System Prompt: [                         ]     │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ 对话测试 ──────────────────────────────────────┐ │
│  │  [输入消息...                         ] [发送]   │ │
│  │  ┌─ 事件流 ────────────────────────────────────┐ │ │
│  │  │ [10:23:45] → CliInit                        │ │ │
│  │  │ [10:23:46] → assistant_message: "你好！"     │ │ │
│  │  │ [10:23:50] → session_end (reason: completed)│ │ │
│  │  └────────────────────────────────────────────┘ │ │
│  │  状态: ● 已连接 | 耗时: 5.2s | Token: 100/50   │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ 续聊测试 ──────────────────────────────────────┐ │
│  │  历史会话: [session-xxx ▼]                      │ │
│  │  [输入续聊消息...                    ] [继续]    │ │
│  └────────────────────────────────────────────────┘ │
│                                                      │
│  ┌─ 历史记录 ──────────────────────────────────────┐ │
│  │  ├─ 2026-08-20 10:23    42条  "你好"            │ │
│  │  ├─ 2026-08-20 09:15    128条 "帮我写个脚本"    │ │
│  │  └─ ...                                         │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

### 4.2 面板交互流程

**对话测试**：
1. 用户选择引擎、配置参数
2. 输入消息 → 点击发送
3. 面板调 `invoke('start_chat', {engine, message, ...})`
4. 后端走 PluginProcessEngine → spawn 适配器 → 发 start_session
5. 适配器处理 → 回传事件帧
6. 事件回调通过 `onEvent` 流回面板
7. 面板实时显示事件流（assistant_message, tool_call, usage, error）
8. session_end 后显示摘要

**续聊测试**：
1. 面板显示完成对话的会话列表
2. 选择一个会话 → 输入续聊消息
3. 调 `invoke('continue_chat', {session_id, message})`
4. 后端从 resume_tokens 读取续聊令牌
5. 发 continue_session → 适配器用 resume_token 恢复会话

**注意**：当前前端 `start_chat` / `continue_chat` 的 event 回调机制可能不支持面板直接接收事件流，需要确认前端 `chat.ts` 命令的 `event_callback` 是否可桥接到面板。如果不可，可能需要额外 IPC 通道（如 WebSocket 轮询或事件流端点）。

---

## 5. 适配器设计

### 5.1 适配器接口

```js
// engine.mjs — engine-v1 协议适配器
// 启动：被 PluginProcessEngine spawn，stdin/stdout JSONL 通信
// 生命周期：一轮对话 = 一个适配器进程

// 接收 start_session:
// { id, method: "start_session", params: { session_id, message, work_dir, model, ... } }
// → 执行引擎 CLI
// → 逐行回传事件帧
// → 最后回传 { id, result: { session_id, resume_token } }

// 接收 continue_session:
// { id, method: "continue_session", params: { session_id, message, resume_token, ... } }
// → 从 resume_token 恢复会话
// → 执行引擎 CLI
// → 逐行回传事件帧
// → 最后回传 { id, result: { session_id, resume_token } }

// 接收 interrupt:
// { id, method: "interrupt", params: {} }
// → kill 引擎进程
// → 回传 { id, result: { interrupted: true } }
```

### 5.2 适配器职责

- **进程管理**：spawn 引擎 CLI，管理子进程生命周期
- **事件翻译**：引擎 CLI 输出 → engine-v1 AIEvent 帧
- **续聊令牌**：会话结束后持久化续聊 token，回传 path
- **错误处理**：进程崩溃、超时 → error 事件帧
- **MCP 桥接**：接收 `mcp_servers` 参数，按引擎 CLI 能力桥接

### 5.3 适配器实现路径

```
Phase 1: 模拟适配器（纯 echo，不调真实 CLI）
  start_session → 回传 assistant_message("echo: " + message) + session_end
  continue_session → 同上
  interrupt → 无操作

Phase 2: 真实引擎适配器（调 dsh / codex CLI）
  dsh: 调用 dsh --profile headless <message>，读取 stdout，分割为事件
  codex: 调用 codex exec --json <message>，解析 JSONL 事件，翻译为 AIEvent 帧
```

---

## 6. 实施步骤

### Step 1: Rust 核心增强（PluginProcessEngine 参数透传）

**文件**：`src-tauri/src/ai/engine/plugin_process_engine.rs`

- 新增 `build_start_params(options: &SessionOptions, session_id: &str, message: &str, is_continue: bool, resume_token: Option<&str>) -> serde_json::Value`
- 改造 `start_session` 调用 `build_start_params`
- 改造 `continue_session` 调用 `build_start_params`，resume_token 走 params 字段
- 改造 `spawn_event_reader` 签名，传递 `is_continue` 标志
- `cargo check --lib` 验证

### Step 2: 测试适配器（外部仓库）

**文件**：`Polaris-plugin/plugins/engine-test/engine.mjs`

- 实现 engine-v1 协议主循环
- 实现 `start_session`：echo 模式回传
- 实现 `continue_session`：从 resume_token 恢复
- 实现 `interrupt`
- 日志输出到 stderr

### Step 3: 插件 manifest + 面板（主仓库）

**文件**：`src/plugins/engine-test/manifest.ts` + `EngineTestPanel.tsx`

- 内置插件 manifest，声明 activityBar 视图
- 面板组件：
  - 引擎列表区（从 engineMetadataStore 读取）
  - 对话测试区（输入 + 发送 + 事件流显示）
  - 续聊测试区（历史会话选择 + 续聊）
  - 配置区（model / work_dir / 权限模式）
  - 历史记录区（浏览会话历史）
- 注册到 `builtinPlugins.ts`
- `tsc` 验证

### Step 4: 端到端联调

- 启动 Polaris
- 面板显示引擎列表
- 测试对话流程（模拟适配器）
- 验证事件流回传
- 验证续聊
- 验证中断

### Step 5: 真实引擎适配器扩展

- 将 dsh-engine 的 `engine.mjs` 适配到 engine-v1 协议完整规格
- 将 codex 的 CLI 调用封装为 engine-v1 适配器
- 通过面板验证真实引擎

---

## 7. 不做的事

- ❌ 不删除 `codex.rs` / `dsh.rs` 原生引擎
- ❌ 不改 `lib.rs` 注册行
- ❌ 不改 `EngineId::Codex` 变体
- ❌ 不改 `launcher.rs` / `chat.rs` 特化分支
- ❌ 不改 `history_codex.rs` / `codex_chat.rs`
- ❌ 不改内置引擎选择器 UI（引擎列表自动包含插件引擎）
- ❌ 不实现完整的生产级引擎面板（以验证为主）

---

## 8. 验证标准

| 标准 | 方法 |
|------|------|
| cargo check 0 error | `cargo check --lib` |
| tsc 0 error | `tsc --noEmit` |
| 面板在 activityBar 可见 | 点击面板图标，面板打开 |
| 引擎列表显示所有引擎 | 原生 + 插件引擎均出现 |
| 配置参数可编辑 | 修改 model/work_dir，发送后适配器收到 |
| 对话测试完整事件流 | start → assistant_message → session_end |
| 续聊测试 | 完成会话 → 续聊 → 收到新回复 |
| 中断测试 | 发送中 → 中断 → 收到 session_end |
| 插件引擎注册 | register_plugin_engine 返回 Ok，引擎出现在列表中 |
| 事件流实时显示 | 面板逐行显示事件，不等待完成 |

---

## 9. 风险

1. **事件回调链路**：前端 `start_chat` 的 event 回调走的是后端 `event_callback` → `onEvent` IPC，面板能否直接接收事件流需确认。如果不可，需额外通道（如挂载到 `useChatStore` 或建独立的事件端点）。
2. **PluginProcessEngine 的 `start_params` 目前只传 2 个字段**：增强后需确保所有适配器兼容新的 params 结构（向后兼容：旧适配器忽略不识别的字段，新适配器读取新字段）。
3. **本机只能编译**：`cargo test --lib` 不能跑（[[rust-lib-test-env-limit]]），协议测试需 CI 执行。