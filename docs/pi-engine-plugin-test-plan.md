# Pi 引擎插件面板测试验证 —— 分析规划

> 聚焦：仅分析 Pi 如何通过引擎插件 + 面板验证 engine-v1 路径。
> 排除：codex/dsh 外迁、其他引擎。

---

## 1. Pi 引擎现状

### 1.1 主仓库 Rust 端

| 文件 | 行数 | 说明 |
|------|------|------|
| `src-tauri/src/ai/engine/pi.rs` | 1147 | PiEngine impl：`AIEngine` trait、CLI 探测、`--mode rpc` 协议、stdin/stdout JSONL 通信 |
| `src-tauri/src/ai/engine/pi_parser.rs` | 790 | PiRpcLine 解析器、事件翻译（pi RPC → AIEvent）、tool 名归一化 |
| `src-tauri/src/ai/engine/mod.rs` | - | `pub use pi::PiEngine`、`pub(crate) mod pi_parser` |

### 1.2 注册点
- `lib.rs:546` Ta起路径：`engine_registry.register(ai::PiEngine::new(config.clone()))`
- `lib.rs:1249` Web 路径：同上

### 1.3 特化分支
- `chat.rs:442`：`EngineId::Pi => "pi"`（profile 引擎名映射）
- `chat.rs:658`：`EngineId::Pi =>` pi_provider_config 写入 + pi_model 传递
- `launcher.rs:177`：`EngineId::Pi | EngineId::Custom(_) =>` MCP 注入（Pi 与 Custom 共享分支）
- `registry.rs:354`：测试 Mock 名映射

### 1.4 关键特殊性：pi_parser 是共享基础设施

`pi_parser` **不是 Pi 专有**——`PluginEngineRunner`(PluginEngine 的 PiRpc 模式) 也依赖它：

| 调用点 | 文件 | 用途 |
|--------|------|------|
| `build_prompt_command` | `plugin_engine.rs:801` | 构造 stdin 命令帧 |
| `PiRpcLine::parse_line` | `plugin_engine.rs:868` | 解析 stdout 事件行 |
| `pi_line_to_ai_events` | `plugin_engine.rs:883` | 翻译为 AIEvent |
| `build_abort_command` | `plugin_engine.rs:1214` | 构造中断命令 |

这意味着 `pi_parser` **不能随 PiEngine 移除**——PluginEngineRunner 的 PiRpc 模式依赖它。

### 1.5 外部插件仓库

| 插件 | 文件 | 说明 |
|------|------|------|
| `omp-engine-adapter` | `engine.js` (2976 字节) | engine-v1 mock 演示适配器，不调真实 CLI |
| `omp-engine` | 仅 `plugin.json` + `zip` | 无适配器，走 PluginEngineRunner(PiRpc) |

**Pi 没有 engine-v1 适配器插件**——只有 OMP 有，且是 mock。

### 1.6 Pi 无前端引擎类

与 codex 不同（`src/engines/codex/engine.ts` + `session.ts`），Pi 没有 `src/engines/pi/` 目录。`engine-bootstrap.ts:29` 的 `ENGINE_FACTORIES` 中只有 `claude-code` 和 `codex`，Pi 不在其中。

---

## 2. Pi 插件面板测试范围

### 2.1 要验证的路径

```
EngineTestPanel (面板)
  → 显示 Pi 引擎状态（已注册、可用/不可用）
  → 配置参数（model / work_dir/ provider 端点）
  → 触发测试对话
      → 走原生 PiEngine 路径（当前）：invoke('start_chat', {engine: 'pi', ...})
      → 走插件引擎路径（未来）：register_plugin_engine → PluginProcessEngine → engine-v1 适配器
  → 实时显示事件流
  → 续聊测试
  → 历史记录浏览
```

### 2.2 面板功能

| 区域 | 功能 | 数据来源 |
|------|------|---------|
| 引擎列表 | 显示所有已注册引擎，区分原生/插件/engine-v1 | `engineMetadataStore` |
| 配置区 | model / work_dir / provider / 权限模式 | 本地输入 |
| 对话测试 | 输入 → 发送 → 实时事件流 | `invoke('start_chat')` + `onEvent` 回调 |
| 续聊测试 | 选历史会话 → 续聊 | 已完成会话列表 |
| 历史记录 | 浏览 Pi 引擎的会话历史 | `dialog_list_meta` |
| 状态栏 | 连接状态、耗时、token 用量 | 实时 |

### 2.3 Pi 引擎事件流（面板展示）

| AIEvent 类型 | 面板显示 | 颜色 |
|-------------|---------|------|
| `CliInit` | `CLI_INIT · 适配器启动中...` | 蓝 |
| `SessionStart` | `SESSION_START · 引擎: pi · 会话: xxx` | 绿 |
| `Thinking` | `THINKING · 正在思考...` | 紫 |
| `Token` | `TOKEN · 流式文本增量` | 蓝 |
| `AssistantMessage` | `ASSISTANT · 完整消息` | 绿 |
| `ToolCallStart` | `TOOL_CALL · bash · {"cmd":"ls"}` | 黄 |
| `ToolCallEnd` | `TOOL_RESULT · ✓ bash · (输出 N 行)` | 黄 |
| `Usage` | `USAGE · 输入:158 · 输出:342 · 缓存:+12` | 蓝 |
| `Error` | `ERROR · 错误信息` | 红 |
| `SessionEnd` | `SESSION_END · reason: completed` | 灰 |

---

## 3. 实施步骤

### Step 1: Rust 核心增强（build_start_params 参数透传）

**位置**：`src-tauri/src/ai/engine/plugin_process_engine.rs`

当前 `start_session` 只传 `session_id` + `message`，需补全：

```rust
// 新增 build_start_params 方法
fn build_start_params(options: &SessionOptions, session_id: &str, message: &str,
    is_continue: bool, resume_token: Option<&str>) -> serde_json::Value {
    json!({
        "session_id": session_id,
        "message": message,
        "work_dir": options.work_dir,
        "model": options.model,
        "system_prompt": options.system_prompt,
        "append_system_prompt": options.append_system_prompt,
        "env_overrides": options.env_overrides,
        "permission_mode": options.permission_mode,
        "additional_dirs": options.additional_dirs,
        "mcp_servers": options.mcp_servers.iter().map(|s| json!({
            "server_name": s.server_name,
            "command": s.command,
            "args": s.args,
        })).collect::<Vec<_>>(),
        "resume_token": resume_token,
        "is_continue": is_continue,
    })
}
```

- 改造 `start_session` 调用 `build_start_params`  
- 改造 `continue_session` 调用 `build_start_params`，`resume_token` 走 params 字段
- 改造 `spawn_event_reader` 签名，传递 `is_continue` 标志
- `cargo check --lib` 验证

**改动量**：~1 个新方法 + 修改 3 处调用点，约 50 行

### Step 2: 测试适配器（engine-v1 mock）

**位置**：`Polaris-plugin/plugins/pi-test/engine.mjs`

基于现有 `omp-engine-adapter/engine.js` 的 mock 模式，但适配为 Pi 场景：

```js
// 接收 start_session:
// { id, method: "start_session", params: { session_id, message, model, work_dir, ... } }
// → 回传 assistant_message (echo) + session_end
// → 验证 params 中包含: model, work_dir, system_prompt, env_overrides

// 接收 continue_session:
// { id, method: "continue_session", params: { session_id, message, resume_token, ... } }
// → 验证 resume_token 恢复
// → 回传 assistant_message + session_end

// 接收 interrupt:
// → 回传 { id, result: { interrupted: true } }
```

适配器还负责：
- 日志输出到 stderr（PluginProcessEngine 会记录）
- 验证接收到的 params 完整（打印到 stderr 供调试）
- 模拟 `assistant_chunk` 流式输出（像真实 Pi 的 text_delta 事件）

**改动量**：~120 行，适配器 demo 已有现成样板

### Step 3: 内置面板（EngineTestPanel）

**位置**：`src/plugins/engine-test/`（新建目录）

#### 3.1 manifest.ts

```typescript
export const engineTestPluginManifest: PolarisPluginManifest = {
  id: 'polaris.engine-test',
  name: '引擎测试',
  version: '0.1.0',
  description: 'AI 引擎插件路径验证面板：测试 PluginProcessEngine + engine-v1 协议',
  builtin: true,
  enabledByDefault: true,
  contributes: {
    views: [{
      id: 'engineTest.panel',
      area: 'activityBar',
      panelType: 'engineTest',
      icon: 'Activity',
      labelKey: 'labels.engineTestPanel',
      labelDefault: '引擎测试',
      order: 55,
    }],
  },
  permissions: {},
}
```

#### 3.2 EngineTestPanel.tsx 组件结构

```
EngineTestPanel
├── EngineListSection
│   ├── 引擎列表（从 engineMetadataStore 读取）
│   ├── 区分原生/插件/engine-v1 标识
│   └── 选中引擎后显示详情
├── ConfigSection
│   ├── 模型选择（输入框）
│   ├── 工作目录（输入框）
│   ├── 权限模式（下拉: auto/bypassPermissions/dontAsk/plan）
│   ├── System Prompt（文本域）
│   └── 引擎 ID（只读）
├── ChatSection
│   ├── 消息输入框 + 发送/中断/续聊 按钮
│   ├── 事件流显示区（实时逐行显示 AIEvent）
│   └── 自动滚动到底部
├── HistorySection
│   ├── 会话历史列表（从 dialog_list_meta 获取）
│   └── 点击选中后回填到续聊区
└── StatusBar
    ├── 连接状态指示器
    ├── 耗时统计
    ├── Token 用量
    └── Tool 调用计数
```

#### 3.3 事件流接收机制

**关键问题**：如何让面板接收后端 `start_chat` 的事件流？

当前 `start_chat` 的事件回调走的是 `event_callback` → `onEvent` IPC（WebSocket 或 Tauri event），只有**聊天页面**订阅了。面板需要额外的事件通道。

**方案 A（推荐）**：面板直接调用 `invoke('start_chat')`，通过 `onEvent` IPC 事件监听。面板在 mount 时订阅 `onEvent`，unmount 时取消订阅。

```typescript
// 伪代码
useEffect(() => {
  const unsub = onEvent((event) => {
    if (event.session_id === currentSessionId) {
      addEventToStream(event)
    }
  })
  return unsub
}, [currentSessionId])

async function sendMessage() {
  const sessionId = await invoke('start_chat', {
    engine: selectedEngine,
    message: input,
    workDir: config.workDir,
    model: config.model,
    // ...
  })
  setCurrentSessionId(sessionId)
}
```

**方案 B**：面板不调 `start_chat`，直接调 `register_plugin_engine` → 然后用 `plugin_process_engine` 的底层接口测试（仅验证注册路径）。

**方案 A 风险**：`onEvent` 可能被聊天页面独占，面板可能收不到事件。需要确认 `start_chat` 的 `event_callback` 是否广播到所有订阅者。

**改动量**：~350 行（面板组件）+ 30 行（manifest + 注册）

### Step 4: 注册到 builtinPlugins.ts

**位置**：`src/plugin-system/builtinPlugins.ts`

```typescript
import { engineTestPluginManifest } from '@/plugins/engine-test/manifest'
// ...
pluginRegistry.register(engineTestPluginManifest)

pluginPanelRegistry.register('engineTest', 'polaris.engine-test', () =>
  import('@/plugins/engine-test/EngineTestPanel').then((m) => ({ default: m.EngineTestPanel })),
)
```

**改动量**：~6 行

### Step 5: 端到端验证

| 测试项 | 方法 | 预期 |
|--------|------|------|
| 面板可见 | 点击 activityBar 图标 | 面板打开，显示 6 个引擎 |
| Pi 引擎显示 | 查看引擎列表 | Pi 出现在列表中，标为 native |
| 配置编辑 | 修改 model / work_dir | 发送后参数传至后端 |
| 原生 Pi 对话 | 选 Pi → 输入消息 → 发送 | 事件流实时显示 |
| 续聊 | 完成对话 → 选历史 → 续聊 | 收到新回复 |
| 中断 | 发送中 → 点击中断 | session_end 收到 |
| 插件引擎注册 | 注册测试适配器 | register_plugin_engine 返回 Ok |
| 插件引擎对话 | 选测试适配器 → 发送 | 收到 mock 回复 |
| 历史记录 | 浏览 Pi 引擎历史 | 会话列表显示 |

---

## 4. 文件清单

| 仓库 | 文件 | 操作 | 说明 |
|------|------|------|------|
| 主仓库 | `src-tauri/src/ai/engine/plugin_process_engine.rs` | 修改 | 新增 `build_start_params`，透传完整 SessionOptions |
| 主仓库 | `src/plugins/engine-test/manifest.ts` | 新建 | 内置插件声明 |
| 主仓库 | `src/plugins/engine-test/EngineTestPanel.tsx` | 新建 | 引擎测试面板组件 |
| 主仓库 | `src/plugin-system/builtinPlugins.ts` | 修改 | 注册 manifest + panel loader |
| 主仓库 | `src/components/Layout/toolSwitcherData.tsx` | 修改 | 可选，加面板描述 |
| 主仓库 | `src/locales/zh-CN/menu.json` | 修改 | 可选，加面板 label |
| 主仓库 | `src/locales/en-US/menu.json` | 修改 | 可选，加面板 label |
| 外部仓库 | `plugins/pi-test/engine.mjs` | 新建 | engine-v1 mock 适配器 |
| 外部仓库 | `plugins/pi-test/plugin.json` | 新建 | 插件声明（含 adapter） |

---

## 5. 不做的事

- ❌ 不删 `pi.rs` / `pi_parser.rs` 原生引擎
- ❌ 不改 `lib.rs` Pi 注册行
- ❌ 不改 `EngineId::Pi` 变体
- ❌ 不改 `chat.rs` / `launcher.rs` 的 Pi 特化分支
- ❌ 不改 `pi_parser`（它是共享基础设施，不可移除）
- ❌ 不实现完整的 Pi 引擎外部插件（仅 mock 适配器验证路径）

---

## 6. 验证标准

| 标准 | 验证方法 |
|------|---------|
| `cargo check --lib` 0 error | 编译通过 |
| `tsc --noEmit` 0 error | 类型检查通过 |
| 面板在 activityBar 可见 | 点击图标，面板打开 |
| 引擎列表显示 Pi | Pi 出现在列表中，标为 native, available |
| 配置参数可编辑 | 修改 model/work_dir，发送后后端记录 |
| 原生 Pi 对话事件流 | start → thinking → token → assistant → session_end |
| 续聊测试 | 完成 → 续聊 → 新回复 |
| 中断测试 | 发送中 → 中断 → session_end |
| 插件引擎注册 | `register_plugin_engine` 返回 Ok |
| 插件引擎对话 | 测试适配器收到完整 params |
| 事件流实时显示 | 每行事件逐行出现，不等待完成 |

---

## 7. 风险

1. **事件流通道**：面板能否通过 `onEvent` IPC 接收 `start_chat` 的事件流是关键依赖。如果被聊天页面独占，需改用独立事件通道（如 `window.addEventListener('polaris:ai-event', ...)` 或通过 `useChatStore` 订阅）。
2. **`build_start_params` 向后兼容**：现有 `omp-engine-adapter` 等适配器忽略不识别的 params 字段，新增字段不会破坏已有适配器。
3. **本机测试**：`cargo test --lib` 不能跑（[[rust-lib-test-env-limit]]），协议测试需 CI 执行。
4. **Pi 引擎不可用**：如果用户未安装 `pi` CLI，面板显示 Pi 为 unavailable。这不影响面板其他功能。