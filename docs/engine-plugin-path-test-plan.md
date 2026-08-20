# Codex/DSH 引擎外迁：插件引擎路径验证规划

> 目标：不拆原生引擎，先验证 PluginProcessEngine + engine-v1 协议路径完整可用，通过面板测试确认后可安全外迁。
> 约束：原生 codex/dsh 引擎保持不动，lib.rs 注册行不动，EngineId::Codex 不动。

---

## 现状评估

### ✅ 已就绪（无需再建）

| 组件 | 位置 | 状态 |
|------|------|------|
| PluginProcessEngine（engine-v1 协议运行器） | `src-tauri/src/ai/engine/plugin_process_engine.rs` | 801 行，已落地 |
| 适配器声明类型 `PluginEngineAdapterDecl` | `src-tauri/src/ai/traits.rs` + `src/plugin-system/types.ts` | 已落地 |
| 注册分流（有 adapter → PluginProcessEngine） | `src-tauri/src/ai/registry.rs:125` | 已落地 |
| Tauri command `register_plugin_engine` | `src-tauri/src/commands/plugin_engine.rs` | 已落地 |
| Web IPC `dispatch_register_plugin_engine` | `src-tauri/src/web/api/ipc.rs:1965` | 已落地 |
| TS 端 `registerSingleEngine` | `src/plugin-system/registry.ts:187` | 已落地 |
| 内置插件注册模式（manifest + panelRegistry） | `src/plugin-system/builtinPlugins.ts` | 有 agent-gallery / ask 等样板 |
| 面板懒加载 + PluginPanelHost | `src/components/Plugins/PluginPanelHost.tsx` | 已落地 |
| 侧边栏 activityBar 视图注册 | `src/plugin-system/types.ts` + `toolSwitcherData.tsx` | 已落地 |
| 引擎元数据 Store | `src/stores/engineMetadataStore.ts` | 已落地，从后端动态拉取 |

### ❌ 缺失（本规划要补的）

| 缺失项 | 说明 |
|--------|------|
| 一个可运行的 engine-v1 测试适配器 | 用于验证 PluginProcessEngine 完整路径（spawn → JSONRPC 通信 → 事件回传 → session_end） |
| 一个测试面板 UI | 触发注册、显示引擎状态、跑测试 |
| 端到端联调验证 | 确认从 TS → invoke → Rust → spawn 适配器 → 读事件流 → 回调 全链路无断裂 |

---

## 规划

### Phase 1: 测试适配器（`engine-test-adapter.mjs`）

在 `Polaris-plugin/plugins/engine-test/` 下新建一个极简的 engine-v1 适配器，用于验证协议路径。

**功能**：接收 engine-v1 请求，模拟引擎行为回传事件。

```
start_session → 回传 assistant_message + session_end
continue_session → 同上（带 resume_token 读取）
interrupt → 中断
```

**不需要真的调 dsh/codex CLI**，纯模拟，目的是验证：
1. PluginProcessEngine 能成功 spawn 适配器进程
2. stdin/stdout JSONRPC 通信正常
3. 事件帧能被正确解析为 AIEvent
4. session_end 后进程清理正常

**适配器同时作为 engine-v1 协议参考实现**，供后续 codex/dsh 适配器开发参考。

### Phase 2: 内置测试面板（`engine-test` plugin）

在 Polaris 主仓库 `src/plugins/engine-test/` 下新建一个内置插件，含：

**manifest.ts** - 插件声明
- id: `polaris.engine-test`
- builtin: true
- contributes.views: 一个 activityBar 面板

**EngineTestPanel.tsx** - 面板组件
- **引擎列表区**：从 `engineMetadataStore` 读取所有已注册引擎，显示 id / name / 可用状态
  - 区分原生引擎（codex/dsh/pi/claude/simple-ai）和插件引擎（Custom）
  - 对插件引擎显示其 adapter 信息（engine-v1 / pi-rpc）
- **插件引擎注册测试区**：一个输入框 + 按钮
  - 输入外部插件引擎的 `plugin.json` 路径（或直接粘贴 JSON）
  - 调用 `invoke('register_plugin_engine', {engine: ...})` 注册
  - 显示注册结果
- **引擎启动测试区**：选择一个引擎 → 输入测试消息 → 启动测试会话
  - 对原生引擎：调 `start_chat` 验证可用
  - 对插件引擎：验证 PluginProcessEngine 路径
- **测试适配器专用区**：一个按钮「启动 engine-v1 协议测试」
  - 后台注册 `engine-test` 适配器
  - spawn 适配器进程
  - 发送 start_session 请求
  - 在面板中实时显示事件流回传
  - 检查 session_end 是否收到

**注册到 builtinPlugins.ts**
- 导入 manifest
- 注册 panel loader（懒加载面板组件）

### Phase 3: 端到端验证

1. 构建测试适配器 → 放到 Polaris-plugin
2. 启动 Polaris → 面板显示
3. 通过面板注册测试适配器引擎 → 验证 `register_plugin_engine` 走 PluginProcessEngine 路径
4. 启动测试会话 → 验证事件流回传
5. 验证已存在的 dsh-engine 外部插件（`Polaris-plugin/plugins/dsh-engine/`）也可通过面板注册和测试

---

## 文件清单

### 主仓库新增（~5 个文件）

| 文件 | 说明 |
|------|------|
| `src/plugins/engine-test/manifest.ts` | 内置插件声明 |
| `src/plugins/engine-test/EngineTestPanel.tsx` | 面板组件 |
| `src/plugins/engine-test/index.ts` | 导出（可选） |
| 修改 `src/plugin-system/builtinPlugins.ts` | 注册 manifest + panel loader |
| 修改 `src/components/Layout/toolSwitcherData.tsx` | 加面板描述（可选，不设也能运行） |

### 外部仓库新增（~1 个文件）

| 文件 | 说明 |
|------|------|
| `Polaris-plugin/plugins/engine-test/engine-test-adapter.mjs` | engine-v1 测试适配器（Node.js） |

---

## 测试适配器 engine-v1 协议参考

适配器入口文件 `engine-test-adapter.mjs`，实现最小协议：

```js
// 接收到 start_session 请求：
// {"id":1,"method":"start_session","params":{"session_id":"...","message":"..."}}
// 回应：
// {"event":"ai_event","type":"assistant_message","session_id":"...","content":"echo: ...","is_delta":false}
// {"event":"ai_event","type":"session_end","session_id":"..."}
// {"id":1,"result":{"session_id":"...","resume_token":"..."}}
```

完整协议定义见 `docs/engine-adapter-process-analysis.md` § 确认的协议。

---

## 不做的事

- ❌ 不删除 `codex.rs` / `dsh.rs` 原生引擎
- ❌ 不改 `lib.rs` 注册行
- ❌ 不改 `EngineId::Codex` 变体
- ❌ 不改 `launcher.rs` / `chat.rs` 特化分支
- ❌ 不实现完整的 codex/dsh 外部插件（那是验证通过后的下一步）
- ❌ 不改 `history_codex.rs` / `codex_chat.rs`

---

## 验证标准

1. `cargo check --lib` 0 error
2. `tsc` 0 error
3. 面板在 activityBar 中可见，可点击打开
4. 面板显示所有已注册引擎列表
5. 测试适配器注册成功（register_plugin_engine 返回 Ok）
6. 测试会话启动 → 事件流回显 → session_end 收到
7. dsh-engine 外部插件同理可注册和测试