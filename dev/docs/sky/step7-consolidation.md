# Polaris 重构 · 第七步：完全重构 —— 单一入口收敛（消灭多份代码）

> 状态：规划定稿（阶段 A 实施中）
> 日期：2026-09-12
> **授权**：用户明确——支持完全重构，避免存在多份代码，**无需考虑旧数据兼容问题**。
> 即：不留 deprecated 双轨、不做兼容 shim、旧通道直接删除、前端直接切换。
> 原则仍是：一块块替换，但**每块以"删除"收尾**，不允许长期双通道。

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
