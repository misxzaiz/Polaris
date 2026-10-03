# SimpleAI bash 工具与 cap.bash 整合规划

> 状态：规划（调研完成，未实现）
> 前置：cap.bash 已实现并提交（e8c6fa8e）
> 范围：仅规划。实现另行 PR。

## 1. 背景与目标

cap.bash 是宿主级 shell 命令执行能力（后台任务 + 会话解耦 + 进程树管理），
已提交为 `e8c6fa8e`。SimpleAI 仍自带硬编码同步 `bash` 工具（`tools/bash.rs`）。

本规划回答：**cap.bash 是否应替换 SimpleAI 的内置 bash 工具，以及如何整合。**

结论：**不是 1:1 替换，而是双轨整合**（见 §3 结论）。

## 2. 现状调研结论

### 2.1 两条命令执行链路已并存

| 维度 | SimpleAI `bash` 工具（tools/bash.rs） | cap.bash（BashCapability） |
|---|---|---|
| 执行模型 | 同步阻塞，单次拿全 stdout/stderr | 后台异步，run 立即返回 taskId，日志流式增量 |
| 生命周期 | 绑定会话，随工具调用结束 | 宿主级 TaskManager 单例，不随会话销毁 |
| 中断 | abort_rx 轮询 kill 子进程（200ms 级） | kill 动作杀进程树（taskkill /T /F） |
| 超时 | `SIMPLE_AI_BASH_TIMEOUT_SECS`（默认 600s） | `timeoutMs`（默认 600s） |
| 输出 | 截断至 32_768 字符返回 | 日志 ring buffer（500 行 × 4096 字符，≤4MB） |
| 覆盖机制 | `builtin_tool_virtual_server` → toolProvider 可覆盖（`polaris-bash` 虚拟 server） | 独立 capability，无覆盖机制 |
| 可达路径 | 内置 ToolRegistry 直接执行 | `mcp__polaris-bus__bus_dispatch` → 白名单 cap.bash |

**cap.bash 已被 SimpleAI 可达**：`polaris-bus` 是内置 MCP server（`builtin_mcp_contribution_registry`
注册 BUS_PLUGIN_ID），SimpleAI 在 `enable_mcp_tools=true` 时经 `resolved_simple_ai_servers`
拿到它，从而可调用 `mcp__polaris-bus__bus_dispatch`（白名单 `["cap.todo","cap.http","cap.bash"]`）。

### 2.2 语义差异决定不可 1:1 替换

- BashTool 是**同步**工具：模型一次调用拿完整结果，靠结果驱动下一步；abort 感知用户中断。
- cap.bash 是**异步任务**：run 返回 taskId 后模型须自行 status/log/wait 轮询；
  任务归宿主，可跨会话存活（这正是它的设计意图——长任务与会话解耦）。

直接删掉 BashTool 会让所有依赖同步语义的对话（构建、脚本、常规命令）被迫改成
多轮异步轮询，体验与工具 schema 复杂度显著劣化，且丢失 abort 联动与 127/shell hint。

### 2.3 已有的覆盖 seam 不应绕过

`ToolRegistry::dispatch` 已实现 toolProvider 覆盖：插件声明 `capability:"shell"`
时注入改名 `polaris-bash` 的 server，内置 bash 优先路由到插件 MCP（`builtin_tool_virtual_server`）。
这是 Capability Seam（P1）的既定形态，cap.bash 不应与它抢路由。

### 2.4 现状空白

- SimpleAI 的**系统提示词**未介绍 cap.bash（模型默认不知道可经 bus_dispatch 调用异步任务）。
- 前端无 cap.bash 任务面板/进度可视化（src/ 下无消费方）。
- `enable_mcp_tools` 默认 false（ai_chat_core.rs `unwrap_or(false)`），普通对话默认无 MCP 工具。

## 3. 结论：双轨整合方案

```
SimpleAI 命令执行双轨
├─ 同步轨（保留现状）：bash 工具，ToolRegistry 内置，toolProvider 可覆盖
│   适用：构建/脚本/短命令，需同步结果驱动下一步，需 abort 联动
└─ 异步轨（cap.bash，经 polaris-bus bus_dispatch 暴露给模型）
    适用：长任务（分钟级+）、需跨会话存活、需按 taskId 轮询/终止
```

### 3.1 建议实施项（按优先级）

1. **P0 提示词引导**：在 SimpleAI 系统提示词（`prompt.rs`）追加 cap.bash 使用说明，
   告知模型：长任务用 `bus_dispatch`（target=cap.bash, action=run, async=true），
   短命令用 `bash` 工具。这是零代码风险的接入点。
2. **P1 会话 workdir 注入**：cap.bash `run` 缺省 workdir 用进程当前目录；SimpleAI 调用
   时应显式传 `workdir`（= 会话 work_dir）。可考虑在 `prompt.rs` 的引导中写明
   "cap.bash 默认 workdir 是宿主 cwd，需显式传参" 或经提示词要求模型带 workdir。
   （不改 cap.bash 契约，保持宿主级语义。）
3. **P2 前端任务可视化**：为 cap.bash 任务增加轻量进度面板（taskId → status/log），
   让"后台跑着、会话已结束还能看到结果"的用户价值落地。需先定任务事件通道
   （现有 EventAdapter/bus 是否有 cap.bash 事件推送，或经前端轮询 status）。
4. **P3（可暂缓/拒绝）删除同步 BashTool**：仅当异步轨覆盖全部用户场景后才考虑。
   当前不建议——同步语义、abort 联动、覆盖 seam 都是硬需求。

### 3.2 明确不做

- 不让 cap.bash 顶替 `polaris-bash` 虚拟 server（toolProvider 覆盖机制不动）。
- 不把 BashTool 改成异步轮询（破坏同步语义与 tool schema）。
- 不新增第三个 shell 执行通道。

## 4. 风险与开放问题

- **模型是否会正确二选一**：需提示词引导 + 实测。若模型滥用异步轨（短命令也 async），
  会多一轮 wait 开销；可在引导中给判定标准（>1min 或需后台才 async）。
- **cap.bash 事件推送**：当前任务状态仅可轮询（status/log），无主动事件。
  前端面板若要做实时进度，需评估在 `read_lines_reader` 处加事件回调的改动量。
- **enable_mcp_tools 默认 false**：异步轨对普通会话不可见，除非用户开启 MCP。
  若 P1 后仍要普及，需评估将 polaris-bus 单列（不随 enable_mcp_tools 门控）的方案。

## 5. 验证清单（实现后）

- [ ] SimpleAI 提示词含 cap.bash 引导，模型能正确二选一（短命令→bash，长任务→cap.bash）
- [ ] 长任务（>10min 编译）经 cap.bash 后台跑，会话中断后任务仍存活、可查 log
- [ ] 同步 bash 工具行为零回归（构建/脚本/127 提示/abort 均不变）
- [ ] 插件 `capability:"shell"` 覆盖仍优先于内置 bash（seam 不回归）
- [ ] 前端任务面板（若做 P2）能实时展示 status 与增量 log

## 附：关键代码位置

| 文件 | 说明 |
|---|---|
| `src-tauri/src/ai/engine/simple_ai/tools/bash.rs` | 内置同步 bash 工具（保留） |
| `src-tauri/src/ai/engine/simple_ai/tools/mod.rs` | ToolRegistry dispatch + toolProvider 覆盖 seam |
| `src-tauri/src/ai/engine/simple_ai/prompt.rs` | 系统提示词（P0 引导注入点） |
| `src-tauri/src/services/router/bash_capability.rs` | cap.bash 宿主级能力 |
| `src-tauri/src/services/state.rs` | router 装配（BashCapability::new() 注册） |
| `src-tauri/src/services/bus_mcp_server.rs` | bus_dispatch 白名单（cap.bash 已入） |
| `src-tauri/src/services/mcp_config_service.rs` | polaris-bus 内置 server + builtin registry |
| `src-tauri/src/services/ai_chat_core.rs` | enable_mcp_tools 门控（默认 false） |
