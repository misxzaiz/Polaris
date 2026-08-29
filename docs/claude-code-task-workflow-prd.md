# Claude Code Task / Agent / Workflow 交互适配 PRD

> 状态：待评审 ｜ 日期：2026-08-29 ｜ 交互原型见本目录同名 artifact

---

## 1. 背景与问题

Polaris 的 Claude Code 链路适配停留在 `TodoWrite`（全量替换模型）。当前实际跑的任务模型是
增量引用式（本机 939 个转录、16.9 万行实测）：

| 工具 | 实测调用 | 输入形状 | Polaris 现状 |
|---|---|---|---|
| `TaskUpdate` | 1389 | `{taskId, status}` | 无注册，灰块，缩写碰撞为 `T` |
| `TaskCreate` | 810 | `{subject, description, activeForm}` | 无注册，键信息栏为空 |
| `TaskOutput` | 204 | `{task_id, block, timeout}` | 忽略，无实时状态 |
| `Agent` | 142 | `{description, prompt, subagent_type}` | 普通工具块，子调用全平铺 |
| `TaskList` | 14 | `{}`（输出即任务板） | 无注册 |
| `Workflow` | — | SDK 内置 | 仅攻坚 schema 硬编码卡片 |

三个核心问题：

1. **任务状态被当作工具调用渲染** —— 10 任务的 run 产生约 1400 个独立工具块，
   `TOOL_COLLAPSE_CONFIG` 对它无效，是任务类消息的主要视觉噪音。
2. **子 agent 不可见** —— `agent_run` 块前端全链路已建成（事件类型 / store / 249 行渲染器），
   但 `AgentRunStartEvent::new` 在生产代码中零命中，是完整死代码。
3. **Workflow 适配是单点硬编码** —— 仅攻坚 schema 有专属卡片，其余 workflow 降级为通用块；
   且 `log()` 不实时到达，无运行中视图。

---

## 2. 目标

- 任务状态从「工具调用流」升级为「结构化任务板」，一个 run 只显示一个板。
- 子 agent 调用可展开为嵌套树，主/子调用归属可区分。
- Workflow 有统一的运行中 / 完成态视图，不为单个 workflow 硬编码卡片。

**非目标**：不改动引擎 spawn 逻辑、不引入新的 IPC 通道、不改变会话存储格式。

---

## 3. 交互设计

### 3.1 任务板（TaskBoard）

对应工具：`TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskStop`

**状态机**（store 级，以 `taskId` 为键，幂等合并）

```
TaskCreate  → upsert(id, {subject, activeForm, status: pending})
TaskUpdate  → patch(id, {status?, ...})      未知 id 则新建为 pending
TaskList    → 用输出快照校准看板（不覆盖已有更精确状态）
TaskStop    → patch(id, {status: stopped})
```

**折叠态**（默认）：单行。

```
┌ 4/5 完成 ━━━━━━━━━━━━━━━━━━━━━━━━ 80%   ↑
│ ● 12 项任务 · 1 进行中 · 1 阻塞        ▾
└──────────────────────────────────────────
```

- 进度条 = `completed / total`
- 显示：总数、进行中数、阻塞数（有则红色徽标）
- 进行中项标题常驻一行，用 `activeForm`（比 `subject` 更适合做进行中描述）

**展开态**：

| 列 | 内容 |
|---|---|
| 状态图标 | completed 绿勾 / in_progress 蓝转圈 / pending 灰圈 / blocked 红叹号 / stopped 灰叉 |
| 标题 | `in_progress` 用 `activeForm`，其余用 `subject` |
| 依赖 | `blockedBy` 非空时显示 `← 3`，悬停高亮被依赖项 |
| 更新次数 | 该行被 `TaskUpdate` 触过的次数，`> 2` 显示「频繁」 |

- 点击行 → 右侧详情抽屉：`subject` / `description` / `activeForm` / 状态 / 依赖链
- 同一 run 内多个任务板合并为**一个**板（按 run 聚合，非按消息）

**与 TodoWrite 的关系**：`TodoWriteRenderer` 泛化为 `StatusBoardRenderer`，
共享行组件与状态配置；`parseTodoInput` 与新增 `parseTaskCreate/Update` 统一产出
`BoardData {items, total, completed, inProgress, blocked}`。

### 3.2 Agent 运行块（AgentRun）

对应工具：`Agent` / `Task`（`Agent` 为现行命名，`Task` 为旧名保留兼容）

复用**已建成未接线**的 `AgentRunBlockRenderer`，接线点在 `EventParser`：

- `tool_use.name == "Agent"` → 发 `AgentRunStart{taskId, agentType=subagent_type, capabilities}`
- 对应 `tool_result` → 发 `AgentRunEnd{taskId, success, result}`
- 子 agent 内部的 tool_use 按 `parent_tool_use_id` 挂为 `toolCalls`

**折叠态**：

```
┌ ◈ general-purpose  ·  运行中  ·  14 工具 (9 完成)  ·  2m 31s  ▾
│   验证 parent_tool_use_id 字段回传
└──────────────────────────────────────────────────────────────
```

**展开态**：嵌套工具树，可递归折叠；主/子工具调用用左侧缩进 + 层级线区分。
头部显示 `subagent_type` 标签 + 耗时 + 工具统计（总数 / 完成 / 失败）。

### 3.3 Workflow 块（WorkflowCard）

**统一入口**：`block.name.toLowerCase() === 'workflow'`（当前为精确匹配，
`createConversationStore.ts:785` 原样赋值 name，SDK 回传 `Workflow` 会静默失效——必须修）。

**解析器注册表**替代硬编码，按输出 schema 自协商：

```
workflowResultParsers = [assaultParser, researchParser, defaultParser]
命中第一个能解析的；全部失败 → 降级通用工具块
```

**运行中态**（新增能力，当前完全缺失）：

```
Phase  ▸ 1/3 Scan ━━━━ 62%
Agents ┃  ├ scan-a  运行中  18.2k tok  42s
       ┃  ├ scan-b  完成    12.1k tok  28s
       ┃  └ scan-c  排队
Log    ┃  ▸ 发现 6 处注册表缺口
```

数据源需扩展 `parse_stream_event_chunk`：当前忽略 `input_json_delta`（`event_parser.rs:412`），
workflow 进度需消费 `phase()` / `agent()` / `log()` 的增量事件。

**完成态**：保留现 `AssaultResultCard` 的方法族 / 轮次时间线 / survivor / artifacts；
通用 workflow 显示 `summary` / `agentCount` / `totalTokens` / `totalToolCalls` / 产物列表。

---

## 4. 事件映射总表

| Claude Code 工具 / 事件 | Polaris Block | 状态 |
|---|---|---|
| `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskStop` | `task_board` | 新增 |
| `TodoWrite` | `task_board`（复用行组件） | 改造 |
| `Agent` / `Task` | `agent_run` | **接线已有代码** |
| 子调用（`parent_tool_use_id`） | `agent_run.toolCalls[]` | 新增 |
| `Workflow` 运行中 | `workflow_card{phase}` | 新增 |
| `Workflow` 完成态 | `workflow_card{result}` | 改造 |
| `TaskOutput`（实时状态轮询） | `agent_run.progressMessage` | 新增映射 |
| `backgroundSessionIds` ↔ SDK `task_id` | 命名空间映射层 | 新增 |

---

## 5. 验收标准

**A. 元数据**
- A1 `TaskCreate` 展开显示 `subject`，进行中显示 `activeForm`；不再为空
- A2 六个 T 开头工具缩写互不相同
- A3 zh-CN 下 `TaskCreate` 显示中文标签，非原始英文
- A4 `workflow` / `Workflow` 两种大小写都命中专属卡片

**B. Agent 嵌套**
- B1 `Agent` 调用渲染为 `agent_run` 块，非普通工具块
- B2 展开可见子 agent 嵌套工具调用，带耗时与完成数
- B3 子调用与主调用在视觉上可区分归属

**C. 任务板**
- C1 含 10 个任务的 run 只显示 1 个任务板（当前为约 1400 个工具块）
- C2 `TaskUpdate` 就地更新行状态，不新增块
- C3 折叠态显示正确完成率百分比
- C4 历史会话回放时任务板呈现最终态，不闪烁

**D. Workflow**
- D1 非攻坚 workflow（deep-research 等）不被误路由为攻坚卡片
- D2 运行中可见 phase 进度与 agent 列表
- D3 解析全部失败时安全降级为通用工具块，不报错

**E. 健壮性**
- E1 未知 `taskId` 的 `TaskUpdate` 不崩溃，降级为新建 pending
- E2 流中断时 `agent_run` 停在 running，不残留 spinner 假死
- E3 `parent_tool_use_id` 缺失时子调用挂到主调用下（降级），不丢块

---

## 6. 实施阶段

| 阶段 | 内容 | 前置 | 预估 |
|---|---|---|---|
| **A** 元数据补齐 | 4 张注册表 + i18n + 缩写去碰撞 + `extractToolKeyInfo` 改 includes | — | 0.5d |
| **B** 接线 agent_run | EventParser 发 `AgentRunStart/End` | — | 1d |
| **C** 任务板 | store 级幂等合并 + 渲染器泛化 | A | 2d |
| **D** Workflow 通用化 | name 规范化 + 解析器注册表 + 运行中视图 | B | 2–3d |
| **E** 子 agent 树 | `parent_tool_use_id` 端到端穿透 | **需先抓真实事件流验证字段回传** | 2d |

建议顺序 A → B → C。B 是唯一「UI 已建成、只差接线」的项目，
一天能出真实体验，并顺带验证 E 的可行性。

---

## 7. 已知待确认

1. `parent_tool_use_id`：本机 939 个转录中该字段出现 0 次。Polaris 走 CLI 模式，
   该字段可能仅在 SDK workflow 路径回传。**E 阶段前必须实测确认**。
2. `workflow` 工具名：939 个转录中 `"name":"workflow"` 0 命中，说明该路径当前
   可能只被单测覆盖（`AssaultResultCard.test.tsx` 存在）。**需确认生产路径是否真实触达**。
3. `input_json_delta` 消费：改造后需确认不影响现有文本 / thinking 去重逻辑
   （`streamed_text_this_turn` / `streamed_thinking_this_turn`）。
4. 本仓库存在 linter 回滚问题，注册表类改动（`toolConfig.ts`）改完须即时 commit 固化。

---

## 8. 关键代码锚点

| 位置 | 说明 |
|---|---|
| `src/utils/toolConfig.ts:56-416` | 4 张元数据注册表（A） |
| `src/utils/toolConfig.ts:483` | `extractToolKeyInfo` 精确匹配 `'task'`，需改 includes |
| `src-tauri/src/ai/event_parser.rs:1024-1066` | `extract_tool_calls`，只读 id/name/input（E） |
| `src-tauri/src/ai/event_parser.rs:543-595` | `parse_assistant_event`，平铺无层级 |
| `src-tauri/src/ai/event_parser.rs:412` | 忽略 `input_json_delta`（D 需扩展） |
| `src-tauri/src/models/ai_event.rs:904-967` | `AgentRunStart/EndEvent`，生产者为零（B） |
| `src/components/Chat/tool-calls/AgentRunBlockRenderer.tsx` | 249 行，已建成未接线（B） |
| `src/components/Chat/chatBlocks/index.tsx:26,58` | `WORKFLOW_TOOL_NAME` 精确匹配（D） |
| `src/stores/conversationStore/createConversationStore.ts:785` | name 原样赋值，无规范化 |
| `src/stores/conversationStore/createConversationStore.ts:1077-1150` | `appendAgentRunBlock` |
| `src/utils/toolSummary.ts:796,855` | `includes('task')` 子串误伤，仅做行数统计 |
| `src/components/Chat/chatUtils/helpers.ts:146` | `isTodoWriteTool` 严格匹配（C 泛化点） |
| `src/engines/claude-code` | 前端引擎层，无需改动 |
| `src-tauri/src/ai/history_claude.rs:279-340` | 历史仅扫深度 1，子 agent 转录不可见（后续） |
