# Polaris 重构 · 第七步：完全重构 —— 单一入口收敛（消灭多份代码）

> 状态：✅ 阶段 A（C2 AI 聊天全量上总线）已实施（2026-09-12）；阶段 B-E 待启动
> 日期：2026-09-12
> **授权**：用户明确——支持完全重构，避免存在多份代码，**无需考虑旧数据兼容问题**。
> 即：不留 deprecated 双轨、不做兼容 shim、旧通道直接删除、前端直接切换。
> 原则仍是：一块块替换，但**每块以"删除"收尾**，不允许长期双通道。


---

## ⏩ 阶段 A 实施进展（2026-09-12）

### ✅ A1 抽核
- `commands/chat.rs`（3518 行）删除，业务核迁入：
  - `services/ai_chat_core.rs`（2650 行）：start/continue/interrupt inner + Profile failover
    全家桶 + 附件处理 + 问答/plan 簿记 + send_input + route_failover_tests（随核迁移）
  - `services/ai_history_core.rs`（674 行）：会话历史（统一分页 + Claude 会话树/fork 推断）
- 壳命令：`commands/session_history.rs`（5 个，签名不变，前端历史 UI 零改动）、
  `commands/provider_diagnostics.rs`（6 个诊断读取，平台壳白名单）
- 全部核函数传输无关（&AppState + ChatCallbacks/AppPaths）；web/api/session.rs 的
  web 辅助（build_web_callbacks/run_claude_blocking 等）收敛至 session.rs 本地

### ✅ A2 cap.ai.chat 完整化
- `Arc<AppState>` 持有（clone_for_web 共享业务字段），装配点注册（桌面 setup + 独立 Web，幂等）
- 同步动作 12 个 + start/continue 同步形态（返回值承载引擎 sessionId —— 前端
  conversationId 语义保持）；流式动作 start/continue 经 dispatch_stream（程序化消费方通道）
- 同步 dispatch 对流式表目标自动回退 invoke（混合型能力）
- 桌面 chat-event 中继：lib.rs 订阅广播通道 → Tauri emit + session_end 桌面通知
  （承接旧 window.emit 双发语义）

### ✅ A3 前端切换
- `services/aiChatDispatch.ts` 新助手（dispatch/dispatch_stream 双通道）
- 切换点：chatService（12 函数）/ createConversationStore（start/continue/interrupt）/
  dispatchTaskService（start/continue/interrupt）/ engines/claude-code + codex session /
  SchedulerPanel / dynamic-island / PlanModeBlockRenderer / AskQuestionCard
- EventRouter / conversationStore 渲染链 **零改动**（chat-event 线格式不变）

### ✅ A4 摘旧
- 删：`commands/chat.rs`、`web/api/chat.rs`、8 条 /api/chat/* 路由、lib.rs 约 20 个
  命令注册、httpTransport 7 条专用映射
- 残留 grep：`start_chat` 等旧命令字符串全库 **0 处**（仅历史注释）

### 验证状态
| 项 | 结果 |
|---|---|
| cargo check（lib/tests/web-only） | ✅ 全绿 |
| verify crate | ✅ 88 passed / 0 failed（含幂等注册更新） |
| tsc | ✅ 基线 42（零新增） |
| vitest | ✅ dispatchTask 12/12 + plugin-system/stores/services 通过 |
| E2E（9829，Profile 凭证真实引擎） | ✅ start 同步返回 sid → continue 模型回复"完成"经 chat-event 送达 → interrupt ok → get_pending_plans ok → 同步打流式目标防误用生效 → 隔离事件流 9 事件干净收尾 |
| 待办 | 配套可视化原型；24h 用户可见性回访（桌面聊天全功能） |


---

## ⏩ 阶段 B 实施：cap.context + cap.history（2026-09-12）

### ✅ B1 cap.context（上下文管理）
- `commands/context.rs`（539 行）删除 → `services/context_core.rs`（类型+ContextMemoryStore
  内存存储，与原命令层同源）+ `services/router/context_capability.rs`（9 个同步动作，
  含 3 个 IDE 上报动作）。
- state.rs context_store 改持 context_core 同源 Arc；前端 contextService 9 函数全部
  改走 dispatch；ipc.rs 孤立 stub 分支摘除；web/integration_tests.rs 导入修正。
- verify crate +6 单测（upsert/roundtrip/many+remove/query/clear/ide_report）。

### ✅ B2 cap.history（会话历史）
- 壳命令 `commands/session_history.rs`（5 个）摘除 → `services/router/history_capability.rs`
  （接 ai_history_core 业务核，block_in_place 驱动 async）。
- 前端切换：historyService（动态导入 2 处）/ claudeCodeHistoryService（3）/ codexHistoryService（1）
  → `services/aiHistoryDispatch.ts`；httpTransport 摘除 6 条 /api/sessions、/api/claude-sessions
  专用映射与 DELETE/GET 特殊分支及 GET_COMMANDS 条目。
- 摘旧：`web/api/session.rs` 删除（/api/sessions、/api/claude-sessions 共 5 条路由）——
  会话历史 web 端点全部由 cap.history dispatch 承接。

### 验证状态（2026-09-12）
| 项 | 结果 |
|---|---|
| cargo check（lib/tests/web-only） | ✅ 全绿 |
| verify crate | ✅ **94 passed / 0 failed** |
| tsc | ✅ 基线 42（零新增） |
| vitest | ✅ dispatchTask 12/12 + httpTransport 7/7（过时端点测试删除） |
| E2E | ✅ cap.context upsert/get_all/query/clear；cap.history list_sessions（5 条真实数据）+ list_claude_sessions（1009 个真实会话） |


---

## ⏩ 阶段 E 前置落地：bus MCP server（2026-09-12）

**背景**：AI 侧此前没有任何读写存储/转发的 MCP 工具——旧 polaris-todo MCP server
随第四步摘旧删除，"AI 写待办"实为 Claude 引擎内置 TodoWrite（与 Polaris 存储无关）。
本节把总线能力以 MCP 工具面开放给 AI（阶段 E 的"共享业务核"形态，提前部分落地）。

### 实现
- `services/bus_mcp_server.rs`（新）：`polaris-mcp bus [config_dir]` 独立 stdio 进程，
  进程内构建**与主应用同源**的轻量总线：
  - 同 DataRoot 的 SqliteStorage → `stores/todo.db` 与主应用**共享存储**（WAL + busy_timeout）
  - 同一 `TodoCapability` 业务核（单份逻辑双入口，这正是阶段 E 的目标形态）
  - `PolicyPermission`（Plugin 来源默认放行）+ 独立审计链
    `audit/dispatch-mcp.jsonl`（audit_sink 新增 `audit_file_path_named`——
    跨进程各自续链，避免与主应用 dispatch.jsonl 哈希链竞争）
- 工具面：**todo_list / todo_get / todo_create / todo_update / todo_complete /
  todo_delete**（精选显式工具，对 AI 友好）+ **bus_dispatch**（通用转发
  {target, payload}，白名单当前仅 cap.todo，按阶段 C 权限策略逐域放开）
- 来源标注：`Source::Plugin { caller: polaris-bus-mcp }`
- 注册：`polaris-mcp` 子命令 `bus`（config_dir 缺省回落 DataRoot.config_dir）+
  **todo 插件 manifest** `contributes.mcpServers += polaris-bus`
  （todo 插件 enabledByDefault=true → AI 会话自动挂载；{{appConfigDir}} 与
  主应用能力存储同根，由 mcp_config_service 解析注入）

### 验证（2026-09-12 stdio E2E）
| 步骤 | 结果 |
|---|---|
| initialize | ✅ polaris-bus-mcp / 2024-11-05 |
| tools/list | ✅ 7 个工具 |
| tools/call todo_create | ✅ 真实写入 |
| **存储共享** | ✅ 主应用 cap.todo list 可见 MCP 创建的待办（同一 todo.db） |
| bus_dispatch 白名单 | ✅ target=cap.context 被拒（isError + 提示） |
| 回归 | ✅ cargo check 四目标全绿；tsc 基线 42；plugin-system mcp.test 10/10 |

### 边界与后续
- context 等内存型能力不进 bus server（跨进程不共享内存——如需，走阶段 C 后的
  HTTP 转发而非内存直连）
- 审计链独立于主应用 dispatch.jsonl（跨进程哈希链竞争的显式取舍）
- 阶段 E 余项：其余域 MCP 工具化随对应域迁移逐个补齐；AI 会话内的工具启用
  粒度（mcpEnabled / 逐 server 开关）沿用插件机制

---

## 0. 承接与授权

前六步已建立：契约 → Storage → RouterBus（同步 + 流式）→ 权限/审计生产化 →
三个同步域闭环 + cap.ai.chat 薄包装。留下的尾巴正是"多份代码"：

1. **AI 聊天双通道**：`commands/chat.rs`（3518 行，完整簿记）vs `cap.ai.chat`（薄包装，
   300 行）——同一业务两份入口，薄包装缺簿记/审批/failover。
2. **命令层 263 个 `#[tauri::command]`**：绝大多数业务域仍是"命令层 + Web 桥分支"
   两份转发（`web/api/ipc.rs` 2692 行逐命令复刻）。
3. **Web 桥复刻**：ipc.rs 每个分支 = 对应命令层逻辑的 Web 版重写（维护双份、漂移风险）。
4. **MCP server 二进制**（polaris_mcp 9 server）与命令层直连同一批仓库/服务——
   同一业务第三个入口。

终态架构（本步的定义）：

```
前端 ──┐
Web  ──┼── 传输壳（Tauri invoke / HTTP）── 只剩：router_dispatch / router_dispatch_stream /
MCP  ──┘        router_list_caps / audit_* / 平台壳命令（窗口·终端·文件树等非业务域）

业务域 = RouterBus 上的 capability（唯一实现）
       = 同步域：SqliteStorage-backed CRUD
       = 流式域：cap.ai.chat 等
```

---

## 1. 关键判断

1. **收敛的正确姿势是"抽核 + 删壳"，不是"重写"**。chat.rs 等命令层里沉淀的是
   经过实战的簿记（pending_plans / dispatched_tasks / Profile failover / 会话状态），
   直接重写必然丢语义。正确路径：把业务核抽成 bus 无关的 service 模块（一份代码），
   capability 与（过渡期）命令层共调；前端切到总线后**删除命令层与 Web 桥分支**。
2. **无兼容授权把"摘旧"从风险项变成默认动作**：不做双写、不做导入、不留
   `deprecated` 标记；迁移块完成 = 旧命令 + Web 分支 + 前端旧调用点同时删除。
3. **平台壳命令不是业务域**，保留为命令（不进总线）：窗口/webview 管理、
   文件对话框、剪贴板、单实例、更新器、插件引擎注册（engine 装配属平台层）、
   契约面板辅助命令。file_explorer/git 亦是平台集成（VFS/子进程封装），
   是否入总线待阶段 D 单独裁决，默认保留。
4. **MCP server 收敛 = 与能力共享业务核**（同 crate 不同入口），不做跨进程 dispatch
   （MCP 是独立 stdio 进程，跨进程走 HTTP 反而引入对 core 存活的依赖）。阶段 E 处理。

---

## 2. 路线图（分阶段，每阶段以删除收尾）

### 阶段 A（本步核心）：C2 —— AI 聊天全量上总线

**目标**：`commands/chat.rs`（3518 行）+ `web/api/chat.rs`（542 行）删除，
cap.ai.chat 成为 AI 会话唯一入口。

- **A1 抽业务核**：`services/ai_chat_core.rs` —— 从 chat.rs 抽出与 Tauri 无关的
  业务函数（start/continue/interrupt 的 options 构建、事件信封、session 簿记、
  pending_plans 注册/审批、dispatched_tasks、ask/pending questions、Profile failover
  调用点）。AppState 依赖经参数注入（&AppState 本身就是 bus 无关的，可继续用）。
- **A2 cap.ai.chat 完整化**：动作扩为
  `start / continue / interrupt / send_input / approve_plan / reject_plan /
  respond_plugin_card / get_pending_plans / clear_pending_plans / dispatch_create_task...`
  （同步动作用 dispatch，流式动作用 dispatch_stream）；事件泵沿用 chat-event 同形
  信封（已验证）。
- **A3 前端切换**：`chatService.ts` / `engines/*/session.ts` / `dispatchTaskService.ts`
  / `httpTransport.ts` 的 start_chat / continue_chat / interrupt_chat / approve_plan /
  reject_plan 等全部改走 `router_dispatch_stream` / `router_dispatch`（target=cap.ai.chat）；
  WS 事件消费链（EventRouter / conversationStore）**零改动**（线格式不变）。
- **A4 摘旧**：删 chat.rs、web/api/chat.rs、ipc.rs 全部 chat 分支、lib.rs 注册、
  httpTransport 旧映射；grep 四层零残留；24h 用户可见性回访。

### 阶段 B：存储型域批量（playbook 流水线）

context(9) → history(5) → dialog(8) → requirement(7)，每块：capability（SqliteStorage
domain）→ 前端 service 切 dispatch → 删命令 + Web 分支。其中 dialog 是聊天持久化
（高价值高风险），放本批最后。

### 阶段 C：管理面域 + 权限收紧启用

config(15) / data_root(6) / pluginDiscovery(11) / pluginServiceManager(6) → 总线；
随后启用 PolicyPermission 首批收紧规则（`cap.config*` / `cap.data_root*` /
`cap.plugin_*` → remote deny）——远程会话从此摸不到管理面。

### 阶段 D：大域 + 平台壳终态

scheduler(48) / browser(3977 行) / lsp(16) / integration(20) / agent(10) 逐块上总线；
file_explorer / git / terminal 单独裁决（平台集成，倾向保留为壳命令）；
最终冻结"壳命令白名单"（预计 30-50 个）。

### 阶段 E：MCP server 共享业务核

polaris_mcp 各 server 改调 bus 侧同一业务核（同 crate 函数级复用），删除各自
直连仓库的重复逻辑；server 清单与能力清单对齐。

---

## 3. 边界

- ❌ 不做任何旧数据迁移/导入（prompt_snippet 的 legacy import 已完成使命，保留无害；
  新迁移块一律不做导入）
- ❌ 不重写业务逻辑（抽核搬移，语义逐行保持）
- ❌ 平台壳命令不进总线（窗口/文件对话框/剪贴板/更新器/单实例）
- ❌ 不做跨进程 MCP dispatch（共享业务核即可）
- ✅ 每阶段验收含"grep 旧通道标识零残留 + 24h 用户可见性回访"

## 4. 验收标准（阶段 A）

1. cargo check 三重 + verify crate 全绿（ai_chat_core 单测随核迁移）。
2. 现有聊天功能等价：发消息 / 流式渲染 / 中断 / plan 审批 / 工具权限 / 会话树 /
   dispatch 任务，全部经 cap.ai.chat 走通（9827 Web 实测）。
3. `grep` 全库 `start_chat|continue_chat|interrupt_chat|approve_plan|reject_chat`
   等旧命令标识仅剩历史注释；chat.rs / web/api/chat.rs 文件不存在。
4. 审计链完整（AI 调用全部经 dispatch 审计 + domain_audit）。

## 5. 影响面

| 维度 | 影响 | 说明 |
|---|---|---|
| 现有代码 | 🔴 高（本步是最大手术） | chat.rs 3518 行重定位 + 前端 4 处切换 + 摘旧 3 文件 |
| 前端 | 🟡 中 | transport/service 层切换；UI 渲染链零改动（线格式不变） |
| 风险 | 🟡 中 | 抽核保语义；每子步可编译可回退；无兼容授权使删除干脆 |
| 架构 | 🟢✅ 正向 | AI 域单入口，权限/审计/可观测全覆盖 |

## 6. 实施顺序

A1 → A2 → A3 → A4 严格串行（每子步三重编译全绿再进下一子步）；
阶段 B 起可与主线并行插块。
