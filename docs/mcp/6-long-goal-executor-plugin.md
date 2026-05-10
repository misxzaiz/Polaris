# 6. 长期目标执行 MCP 插件方案

## 目标理解

长期目标执行插件不是定时任务的简单包装，而是一个“跨会话目标执行编排”能力：

- 用户设定一个长期目标。
- 用户选择 AI 引擎、工作区、执行间隔、是否完成后自动暂停。
- 第一次 AI 会话只负责理解目标、拆解计划、生成协议文档和任务队列。
- 拆解完成后该会话结束。
- Polaris 按配置自动新建下一次 AI 会话，每次只推进一个小模块。
- 每次新会话开始前必须读取当前目标文档、进度、队列、用户补充和上一轮结果。
- 每次会话结束后必须写回进度、下一步、阻塞点、完成判定和会话摘要。
- 用户可以在 UI 中查看当前执行会话、历史会话、当前状态、下一步和补充内容。
- 用户可以暂停、恢复、中断当前会话，或在暂停状态下启动“只整理文档、不执行代码”的维护会话。
- AI 可以自动修改代码并提交 git。
- AI 判定目标完成后自动暂停；用户复审后可以选择继续。

## 设计原则

- MCP 插件负责目标状态、协议文档、任务队列、下一步选择和结果记录。
- Polaris 核心负责安装插件、权限授权、AI 引擎选择、新建会话、调度下一轮、会话可视化和中断控制。
- 自动推进优先使用“完成后间隔”：上一轮会话结束并写回状态后，再等待用户配置的间隔创建下一次会话。
- 每轮自动执行都必须有可审计的状态输入和状态输出。
- 第一版避免插件直接拥有后台常驻调度权。

## 组件边界

### 长期目标 MCP 插件

职责：

- 管理 `.polaris/long-goals/<goal-id>/` 下的目标文档。
- 创建目标文档结构。
- 生成或更新拆解计划。
- 读取当前目标状态。
- 选择下一小步。
- 写入执行结果。
- 记录会话摘要。
- 标记暂停、恢复、阻塞、完成。
- 生成维护会话 prompt。

不负责：

- 直接启动 AI 会话。
- 直接选择 AI 引擎。
- 直接持有后台调度循环。
- 绕过 Polaris 权限写任意文件。

### Polaris 核心

职责：

- 提供长期目标 UI。
- 保存目标运行配置。
- 选择 AI 引擎。
- 创建第一次规划会话。
- 创建后续自动执行会话。
- 监听会话开始、输出、结束、失败、中断。
- 调用 MCP 插件读取状态和生成 prompt。
- 按插件返回状态安排下一次运行。
- 处理暂停、恢复、中断和完成后复审。
- 控制工作区读写、命令执行、git 提交等权限。

## 数据结构

建议目录：

```text
.polaris/long-goals/<goal-id>/
  goal.json
  protocol.md
  plan.md
  progress.md
  queue.md
  supplement.md
  sessions/
    0001-planning.md
    0002-execution.md
  history/
    supplement/
    documents/
```

`goal.json` 示例：

```json
{
  "id": "goal-id",
  "title": "长期目标标题",
  "status": "active",
  "phase": "execution",
  "workspacePath": "D:/space/base/Polaris",
  "engineId": "selected-engine",
  "triggerMode": "afterCompletion",
  "interval": "30m",
  "retryCount": 0,
  "maxRetries": 2,
  "retryBackoff": "5m",
  "autoPauseOnComplete": true,
  "allowCodeChanges": true,
  "allowGitCommit": true,
  "currentStepId": "step-3",
  "currentSessionId": null,
  "lastSessionId": "session-id",
  "nextRunAt": 0,
  "lastFailureAt": null,
  "revision": 12,
  "createdAt": 0,
  "updatedAt": 0
}
```

状态建议：

- `planning`：第一次规划会话中。
- `active`：可自动推进。
- `running`：当前有自动会话正在执行。
- `paused`：停止自动推进。
- `maintenance`：只整理文档，不执行代码。
- `blocked`：需要用户输入。
- `completed`：AI 判定目标完成。
- `failed`：执行失败且无法继续。

### 状态机与 `nextRunAt` 语义（LG-004）

`nextRunAt` 是 Polaris 调度器决定下一次自动会话触发时间的唯一信号。它的取值与 `status` 之间存在**强契约**：调度只对 `active` 生效，状态一旦离开 `active`，`nextRunAt` 必须立即失效。`set_goal_status` 与 `update_next_run_at` 共同维护这条契约，具体行为如下表（实现见 `long_goal_service.rs::update_next_run_at`）：

| 入参 status | 入参 next_run_at | nextRunAt 实际写入值 | 说明 |
|---|---|---|---|
| `active` | `Some(ts)` | `Some(ts)` | 显式排期，调用方完全控制下一次触发时间。 |
| `active` | `None` | `Some(now + interval)` | 重算分支，基于目标 `interval` 自动接力。**典型用例：用户从 UI 把 paused 目标恢复成 active，无需提供时间戳。** |
| `paused` / `maintenance` / `blocked` / `failed` / `completed` | `None` | `None` | **隐性副作用**：`update_next_run_at` 看到非 active 状态会清空 nextRunAt，调度器立刻不再扫到该目标。 |
| `paused` / `maintenance` / `blocked` / `failed` / `completed` | `Some(ts)` | — | **被显式拒绝**：`set_goal_status` 在写盘前直接返回 `ValidationError("只有 active 状态可以设置 nextRunAt")`，避免误排期。 |
| `running` | 任意 | — | **被显式拒绝**：`running` 只能通过 `bind_session` 进入；外部调用 `set_goal_status` 设 `running` 会返回 `ValidationError`。 |

要点：

- "显式拒绝"由 `ensure_status_not_running` + `params.status != Active` 守门员负责，**任何写盘前**就报错，不会污染目标状态。
- "隐性副作用"由 `update_next_run_at` 在写盘路径上根据当前 `status` 决定，调用方不必关心是否要手动清零。
- `bind_session` 进入 `running` 时也会主动把 `next_run_at` 清空，避免在执行期间被调度器二次拉起。
- 单测覆盖：`set_goal_status_rejects_running_and_non_active_schedule`（显式拒绝）+ `set_goal_status_clears_next_run_at_when_transitioning_to_non_active`（隐性清零，覆盖 paused / maintenance / blocked 三个分支）+ `set_goal_status_recomputes_next_run_at_when_returning_to_active`（重算分支）。

## MCP Tools 草案

### `create_goal`

创建长期目标文档结构。

输入：

- `title`
- `goal`
- `workspacePath`
- `engineId`
- `interval`
- `maxRetries`
- `retryBackoff`
- `autoPauseOnComplete`
- `allowCodeChanges`
- `allowGitCommit`

输出：

- `goalId`
- `goalPath`
- `status`

### `read_goal_state`

读取当前目标状态。每轮会话开始必须调用。

输出：

- `goal`
- `protocol`
- `plan`
- `progress`
- `queue`
- `supplement`
- `lastSessionSummary`
- `status`
- `revision`

### `decompose_goal`

在第一次规划会话中调用，把目标拆解为计划和任务队列。

输出：

- `plan`
- `queue`
- `acceptanceCriteria`
- `initialStep`
- `recommendedNextRun`

### `select_next_step`

返回下一轮应执行的小模块。

输出：

- `stepId`
- `title`
- `scope`
- `allowedFiles`
- `blockedFiles`
- `doneCriteria`
- `mustUpdateDocuments`
- `commitPolicy`

### `record_step_result`

记录本轮执行结果。

输入：

- `stepId`
- `summary`
- `changedFiles`
- `testsRun`
- `commitSha`
- `result`
- `nextStep`
- `goalStatus`

输出：

- `status`
- `nextRunAt`
- `autoPause`
- `reviewRequired`

### `append_user_supplement`

追加用户补充。

输入：

- `content`
- `priority`

### `pause_goal` / `resume_goal`

切换自动推进状态。

### `interrupt_current_goal_session`

请求 Polaris 中断当前运行会话。这个 tool 本身只记录意图，真正中断由 Polaris 会话层执行。

### `prepare_maintenance_session`

生成只整理文档的维护会话输入。

### `mark_goal_completed`

由 AI 在满足验收标准后调用。

输出：

- `completionSummary`
- `remainingRisks`
- `reviewSuggestions`
- `autoPause`

## 会话生命周期

### 第一次规划会话

1. 用户在 UI 创建长期目标。
2. 用户选择 AI 引擎。
3. Polaris 创建目标记录，状态为 `planning`。
4. Polaris 新建 AI 会话。
5. 会话调用 `read_goal_state` 和 `decompose_goal`。
6. 插件写入 `protocol.md`、`plan.md`、`queue.md`、`progress.md`。
7. 会话生成规划摘要并结束。
8. Polaris 将目标状态改为 `active`。
9. Polaris 按 interval 安排下一次自动执行会话。

### 自动执行会话

1. 到达 `nextRunAt`。
2. Polaris 检查目标未暂停、未完成、无运行中会话。
3. Polaris 使用目标配置的 `engineId` 新建会话。
4. 会话必须先调用 `read_goal_state`。
5. 会话调用 `select_next_step`。
6. AI 执行一个小模块。
7. 如果允许，AI 修改代码、运行验证、提交 git。
8. 会话调用 `record_step_result`。
9. Polaris 展示会话摘要。
10. 如果状态仍为 `active`，Polaris 按完成后间隔安排下一次会话。
11. 如果状态为 `completed`，Polaris 自动暂停并提示用户复审。

### 用户中断

1. 用户在 UI 点击中断。
2. Polaris 向当前 AI 会话发送停止信号。
3. Polaris 调用插件记录中断状态。
4. 目标进入 `paused` 或 `blocked`。
5. 用户可以补充说明，然后恢复。

### 维护会话

1. 目标处于 `paused`。
2. 用户选择“整理文档”。
3. Polaris 新建维护会话。
4. 会话只能整理协议、计划、进度、队列和补充内容。
5. 会话不得修改业务代码，不得提交 git。

## UI 需求

长期目标页建议展示：

- 目标标题、状态、当前阶段。
- 当前 AI 引擎。
- 执行间隔。
- 下一次运行时间。
- 当前会话状态。
- 当前小模块。
- 进度摘要。
- 最近一次提交。
- 最近一次测试结果。
- 用户补充输入框。
- 暂停、恢复、中断、立即执行、整理文档、复审完成结果。

当前会话面板建议展示：

- 会话 ID。
- 使用的 AI 引擎。
- 开始时间、运行时长。
- 当前阶段：读取文档、选择步骤、执行、测试、提交、写回文档。
- 实时输出摘要。
- 已修改文件。
- 已运行验证。
- 提交 SHA。
- 中断按钮。

历史会话列表建议展示：

- 第几轮。
- 类型：规划、执行、维护。
- 结果：成功、失败、中断、完成。
- 摘要。
- 变更文件。
- commit。

## AI 引擎选择

目标创建时必须选择默认 AI 引擎，并允许后续修改。

建议规则：

- `goal.engineId` 是默认引擎。
- 每次手动执行可以临时覆盖引擎。
- 自动执行默认使用 `goal.engineId`。
- 规划会话和执行会话可以允许不同引擎，但第一版建议先使用同一个。
- 引擎变更必须写入 `goal.json` 和历史记录。

## Git 提交策略

第一版建议：

- 每轮自动执行最多一个提交。
- 如果本轮没有代码变更，不提交。
- 如果验证失败，由 AI 判断是否继续修复；超过当前会话边界则记录失败并暂停。
- 提交信息包含目标 ID 和步骤 ID。

示例：

```text
feat: advance long goal <goal-id> step <step-id>
```

## 权限要求

该插件至少需要：

- `workspaceRead`
- `workspaceWrite`
- `aiToolAccess`
- `commandExecution`
- `gitCommit`

如果后续允许联网检索，还需要：

- `network`

这些权限当前 manifest schema 尚未全部覆盖，需要进入阶段 7 权限模型扩展。

## 需要改造的现有能力

- 将 scheduler 协议文档能力抽象为可复用文档服务，而不是只服务定时任务。
- 增加长期目标运行配置和状态存储。
- 增加会话编排层：按目标配置自动新建 AI 会话。
- 增加会话事件可视化：运行中、输出、结束、中断。
- 增加目标级暂停/恢复/完成后复审。
- 扩展 plugin manifest permissions。
- 扩展外部 MCP server 的启动和权限授权。

## 分阶段建议

## 当前实施状态

已完成第一阶段基础能力：

- Rust 侧新增长期目标模型。
- Rust 侧新增文档服务，支持创建目标、读取状态、列出目标、追加用户补充、绑定运行会话、结束会话写回、暂停、恢复、记录步骤、标记完成、生成规划会话 prompt、生成执行会话 prompt 和生成维护会话 prompt。
- Tauri 命令已注册：`long_goal_create`、`long_goal_list`、`long_goal_read`、`long_goal_append_supplement`、`long_goal_bind_session`、`long_goal_finish_session`、`long_goal_pause`、`long_goal_resume`、`long_goal_prepare_planning`、`long_goal_prepare_execution`、`long_goal_record_step`、`long_goal_complete`、`long_goal_prepare_maintenance`。
- Web IPC 已支持同名命令。
- 前端新增 `longGoalService.ts`，提供上述命令的 typed wrapper。
- 前端新增长期目标左侧面板入口，支持创建目标、选择 AI 引擎、设置间隔、设置重试策略、设置是否允许修改代码和提交 git、查看目标状态、追加用户补充、暂停/恢复、创建规划会话、创建执行会话、创建维护会话、预览维护会话输入和手动标记完成。
- 目标创建表单支持“创建后自动启动规划会话”开关，默认开启；创建成功后会立即生成规划 prompt、创建项目会话并绑定 `planning` phase。
- 规划/执行/维护会话当前复用已有聊天 UI：面板创建新的项目会话，使用目标配置的 `engineId`，把 `currentSessionId`、`lastSessionId`、`running` 状态和当前 phase 写回 `goal.json`，并把后端生成的 prompt 作为首条用户消息发送。
- 长期目标面板在存在 `currentSessionId` 时显示“中断会话”按钮，调用会话管理器中断当前 AI 会话，并将目标切回暂停状态。
- 前端已注册 App 级长期目标会话跟踪器，监听 `session_end` 后根据 `currentSessionId` 找到目标，写入 `sessions/*.md` 和 `progress.md`，并清空 `currentSessionId`。
- 后端会在目标进入 `active` 状态时按 `interval` 写入 `nextRunAt`；前端跟踪器每 30 秒扫描到期目标并自动启动下一次执行会话。
- 自动启动执行会话失败，或会话以 `error/aborted` 结束时，会写入失败记录；未超过 `maxRetries` 时按 `retryBackoff` 重新排期，超过上限后将目标标记为 `failed`，停止继续自动推进。`failed` 与 `blocked` 在 `nextRunAt` 行为上一致（都被清零，调度器不再扫到），但语义分流（LG-007）：`failed` = 系统判定不可恢复（重试耗尽 / 致命错误），需要用户介入做根因分析、修复后用 `set_status` 拉回 `active`；`blocked` = 等待用户输入（AI 主动声明 blocker 或用户从 UI 显式 set `blocked`），用户在 `supplement.md` 给出输入后即可恢复。
- `completed` 状态下长期目标面板显示完成复审区，支持确认完成、继续执行、补充后重新规划。
- 长期目标详情中显示当前会话、上次会话、下次执行时间、重试状态和执行权限策略，并可展开最近会话摘要。
- 已补充 Rust 文档服务编译测试和前端 service 调用测试。

尚未完成：

- 外部 MCP server 打包和 manifest。
- 外部插件权限模型扩展。

当前已新增外部插件样例骨架：`examples/plugins/long-goal-mcp-plugin`。该样例贡献 `polaris-long-goal` stdio MCP server，第一版只暴露文档读写和状态更新 tools；自动调度、新建会话、AI 引擎选择、中断和完成复审仍归宿主侧负责。

当前已新增正式 Rust MCP server 骨架：`polaris-long-goal-mcp`。它通过内置 `polaris.long-goal` manifest 暴露 `polaris-long-goal` MCP server，复用 Rust `LongGoalService`，用于替代 Node 样例成为正式执行面。Node 外部样例仍保留，用于验证外部插件安装和 manifest 模板。

第一版外部 MCP tools 边界：

- `long_goal_list`
- `long_goal_read`
- `long_goal_append_supplement`
- `long_goal_record_progress`
- `long_goal_update_documents`
- `long_goal_set_status`
- `long_goal_complete`

### MCP / IPC / Service 三方命名对照（LG-006）

长期目标的工具表面分三层：MCP（外部插件 / agent 调用）、Tauri IPC（前端调用）、Rust Service（内部实现）。三者**绝大多数同名**，仅 `record_progress` 一线**有意保留分叉**——MCP 名是已发布的外部接口，改名属 breaking change 需走 deprecation 周期；IPC / Service 名沿用 `record_step` 历史命名。**修改任何工具时必须同步三处**。

| MCP 工具名 (外部接口)            | Tauri IPC 命令 (前端)              | Service 方法 (Rust)                              | 备注 |
|---|---|---|---|
| `long_goal_create`               | `long_goal_create`                 | `LongGoalService::create_goal`                   | — |
| `long_goal_list`                 | `long_goal_list`                   | `LongGoalService::list_goals`                    | — |
| `long_goal_read`                 | `long_goal_read`                   | `LongGoalService::read_goal`                     | — |
| `long_goal_append_supplement`    | `long_goal_append_supplement`      | `LongGoalService::append_supplement`             | — |
| **`long_goal_record_progress`**  | **`long_goal_record_step`**        | **`LongGoalService::record_step`**               | **LG-006 命名分叉，三名同义** |
| `long_goal_update_documents`     | `long_goal_update_documents`       | `LongGoalService::update_documents`              | — |
| `long_goal_set_status`           | `long_goal_pause` / `long_goal_resume` | `LongGoalService::pause_goal` / `resume_goal` + 内部 `set_goal_status` 守门员 | MCP 暴露通用 set_status，IPC 拆成 pause/resume 两入口 |
| `long_goal_complete`             | `long_goal_complete`               | `LongGoalService::complete_goal`                 | — |

宿主独占 IPC（**不**通过 MCP 暴露，详细文档归 LG-008）：`long_goal_bind_session`、`long_goal_finish_session`、`long_goal_prepare_planning`、`long_goal_prepare_execution`、`long_goal_prepare_maintenance`。这些命令承载会话编排、调度协议生成、`running` 状态写入等"宿主-only"特权操作，**不应**让外部 MCP 客户端绕过宿主直接调用。

### 宿主独占 IPC：hosted-only 命令边界（LG-008）

LG-006 的三方命名表覆盖的是"MCP 与 IPC 同名或仅 MCP 名分叉"的工具表面。除此之外，长期目标还有**5 个 IPC 命令只对宿主前端开放，故意不进入 MCP `tools/list`**。这层边界不是历史遗留，而是 owner 边界设计：每条命令都依赖外部 MCP 客户端拿不到（也不应该拿到）的运行时上下文。

#### 命令清单

| Tauri IPC 命令 | Service 方法 | 触发时机 | 主要副作用 |
|---|---|---|---|
| `long_goal_bind_session`        | `LongGoalService::bind_session`              | 宿主新建 / 接管 AI 会话时 | 写 `current_session_id` + `last_session_id`；状态置 `running`；清空 `next_run_at`（避免运行期间被调度器二次拉起） |
| `long_goal_finish_session`      | `LongGoalService::finish_session`            | 宿主监听到 `session_end` 兜底写回时 | 写 `sessions/<ts>-<phase>-<sid>.md`；追加 `progress.md` / `queue.md`；触发 retry 状态机（LG-007 Failed 分流）；调用 `update_next_run_at` 重排期 |
| `long_goal_prepare_planning`    | `LongGoalService::prepare_planning_session`  | 宿主创建第一次规划会话前 | 读 `goal.config` 组装规划阶段 first-message prompt（不写盘） |
| `long_goal_prepare_execution`   | `LongGoalService::prepare_execution_session` | 宿主创建自动执行会话前 | 读 `goal.config` + 当前 `progress` / `queue` / `supplement` 组装执行阶段 first-message prompt（不写盘） |
| `long_goal_prepare_maintenance` | `LongGoalService::prepare_maintenance_session` | 宿主创建维护会话前 | 读 `goal.config` 组装"只整理文档"维护阶段 first-message prompt（不写盘） |

#### 设计动机：三组特权操作

**1. `running` 状态写入特权 —— `bind_session`**

`bind_session` 是项目内**唯一**的 `LongGoalStatus::Running` 写入路径。LG-004 状态机表已经记录：`set_goal_status` 通过 `ensure_status_not_running` 守门员**显式拒绝**任何把状态设成 `running` 的请求，包括 MCP 工具 `long_goal_set_status`、IPC 包装 `long_goal_pause` / `long_goal_resume`、以及内部直接调用。`running` 语义被收窄成"宿主已经在某个 AI 会话上挂了一个执行槽位"——只有持有 `session_id` 的宿主能进入这个状态。如果允许外部 MCP 写 `running`，调度器就无法再用 `running` 作为"是否有 in-flight 会话"的断言依据，nextRunAt 双拉起、并发写盘等 corner case 会立刻浮出。

**2. 会话边界与重试状态机 —— `finish_session`**

`finish_session` 是会话生命周期的写盘汇聚点：它接收 `session_id` + `summary` + `next_step` + `result` + `retry_failure` 五个仅在 `session_end` 时刻才能确定的入参，串起三处落盘（`sessions/*.md` 写入、`progress.md` 追加、`queue.md` 追加）+ retry 状态机（成功路径重置 retry，失败路径走 `apply_retry_failure` 退避并在耗尽时落 `LongGoalStatus::Failed`，详见 LG-007）+ `update_next_run_at` 重排期（依赖当前 `status` + `interval` 决定是否清零或自动接力，详见 LG-004 状态机表）。这套语义高度依赖宿主侧的两个上下文：一是当前 session 是否仍是 `current_session_id`（用于幂等校验，避免延迟回调写错会话）；二是会话退出原因是否触发 retry（仅宿主的会话事件层能给出 `error/aborted` 信号）。外部 MCP 没有这两路信号源，强行暴露只会让 retry 状态机被错误的 `retry_failure=false` 调用污染。

**3. 宿主上下文注入路径 —— `prepare_planning` / `prepare_execution` / `prepare_maintenance`**

三个 `prepare_*` 命令的产出是字符串——一段被宿主当作 first-message 注入到刚创建的 AI 会话里的 prompt。它们读取 `goal.config`（含 `allowCodeChanges` / `allowGitCommit` 权限）和 `progress` / `queue` / `supplement` 文档，按阶段组装"本轮边界 + 期望产出 + MCP 工具写回要求"模板。换句话说，**调用方就是即将运行该 prompt 的会话本身**：宿主在 `t=0` 时为新会话生成上下文，会话在 `t>0` 时执行该上下文。外部 MCP 客户端处于会话内部，没有"为自己生成 prompt"的语义需求；如果暴露这层接口，反而会让用户混淆"prepare 是查询还是触发"。如果只是想看下一轮 prompt 长什么样，可以从 `read_goal_state` 拿到原料并在客户端侧自行组装预览，不需要服务端能力。

#### 与 `long_goal_set_status` MCP 工具的边界对比

`long_goal_set_status` 已经在外部 MCP 暴露，能把目标状态切到 `planning` / `active` / `paused` / `maintenance` / `blocked` / `completed` / `failed`，唯独**不能切到 `running`**（守门员显式拒绝）。这条边界本质上就是：

> **状态机的"业务态"对外开放，"运行态"对内封闭。**

业务态由用户主观决策驱动（暂停 / 恢复 / 标记完成 / 声明阻塞），允许 AI 通过 MCP 工具配合用户决策；运行态由宿主调度层客观写入（绑定会话进 / 结束会话出），只能由宿主自己拥有。`bind_session` 与 `finish_session` 是这条运行态边界的入口和出口，不通过 MCP 暴露；`prepare_*` 则是绑定前的上下文注入，与运行态本质同源。

外部 MCP 客户端**仍然可以观察**这些状态变化——通过 `long_goal_read` / `long_goal_list` 拿到的 `status` 字段会真实反映 `running`，但不能通过 MCP 写入。

当前已完成补充：

- `polaris.long-goal` manifest 同时贡献受控宿主 `long-goal.panel` 可视化入口和 `polaris-long-goal` MCP server。
- 规划/执行/维护会话 prompt 已明确要求先调用 `long_goal_read`，结束前调用 `long_goal_update_documents`、`long_goal_record_progress` 或 `long_goal_complete` 写回。
- 长期目标会话启动时会把 `polaris-long-goal` MCP tools 加入允许工具列表。
- `LongGoalService` 已收紧外部状态更新，`running` 只能通过宿主绑定会话进入，非 `active` 状态不能直接设置 `nextRunAt`。
- 会话结束监听仍保留为兜底：如果 AI 没有通过 MCP tools 写回，宿主会在 `session_end` 后记录会话摘要和重试/排期状态。

### 路径形态契约：workspacePath 与 goalPath（LG-009）

**适用范围**：仅 Windows 平台。`std::fs::canonicalize` 在 Windows 上会把 `D:\space\base\Polaris` 规范化成 `\\?\D:\space\base\Polaris`（verbatim / UNC 形态）。前端 `longGoalSessionTracker` 持有的工作区路径来自 Tauri 启动时的 `currentWorkspacePath`，是非-UNC 形态 `D:\…`。两者通过字符串比较匹配，UNC vs 非-UNC 不一致 → `findLongGoalBySession` 返回 None → 自动会话写回链路断裂。

**契约**：

| 字段 | 持久化形态 | 暴露给前端 | 内部路径校验 |
|---|---|---|---|
| `LongGoalConfig.workspace_path` | 非-UNC `D:\…` | 是（`workspacePath`） | 不参与（每次都重新 canonicalize） |
| `LongGoalState.goal_path` | 非-UNC `D:\…\.polaris\long-goals\<id>` | 是（`goalPath`） | 不参与 |
| `canonical_workspace` 内部 `PathBuf` | strip-after-canonicalize | 否（私有） | 调用 `checked_goal_dir` 时由后者再 canonicalize |
| `checked_goal_dir` 内部 `canonical_root` / `canonical_dir` | UNC（仅在比对那一刻） | 否 | **越权前缀比对在此完成**（UNC vs UNC） |

**实现要点**：

- `strip_verbatim_prefix(PathBuf) -> PathBuf` 是 cfg(windows) 私有 helper，**只**剥离 `\\?\D:\…` 这种"verbatim 盘符"形态；`\\?\UNC\server\share` 的 UNC server 形态保留原样（无非-verbatim 等价表达）；非 Windows 目标编译为 no-op。
- 剥离时机：`canonical_workspace` 末端 + `checked_goal_dir` **越权检查通过之后** 的返回值。两个 strip 点都在"安全检查已结束"的地方，不会削弱路径越权防御。
- 已有数据迁移：不做主动迁移。新建 goal 自动落非-UNC 形态；存量 goal.json 如果是 UNC，由前端 sessionTracker 在后续 P2（LG-014 测试覆盖周边）层面通过 PathMatcher 等价判定吸收，本契约只关闭源头。

**回归保护**：单测 `create_goal_persists_non_unc_workspace_path`（cfg(windows)）断言 `state.config.workspace_path` 与 `state.goal_path` 都不以 `\\?\` 开头；纯函数级单测覆盖三档：盘符 strip / UNC server passthrough / 非 UNC passthrough。

## 外部 MCP 迁移实施方案

目标不是让外部 MCP 插件接管后台调度，而是把“协议文档读写能力”和“AI 可调用工具面”迁出宿主；宿主保留会话编排、定时扫描、AI 引擎选择、中断和复审。

### 阶段 1：修正宿主原型和外部样例边界

- 修复宿主 Tauri 调用参数：所有 `params` 结构体命令必须按 `{ params: ... }` 传入。
- 外部样例插件继续只声明 `mcpServers`，不声明 `views`。
- 外部样例 MCP tools 只操作 `.polaris/long-goals/<goal-id>/` 文档和 `goal.json`。
- 设置页应显示该插件 `0 个入口 / 1 个 MCP 服务`。
- 已补充安装发现回归测试，覆盖 `examples/plugins/long-goal-mcp-plugin` manifest 校验、项目级安装、发现结果和 MCP server contribution。

### 阶段 2：抽出共享文档服务边界

当前 Rust `LongGoalService` 同时服务 Tauri 命令、宿主 UI 和 Rust MCP server。稳定文档服务边界已经形成：

- `create_goal`
- `list_goals`
- `read_goal`
- `append_supplement`
- `record_progress`
- `update_documents`
- `set_status`
- `prepare_planning_context`
- `prepare_execution_context`
- `prepare_maintenance_context`

宿主 Tauri 命令和正式 Rust MCP server 复用同一套语义，避免 JS 样例和 Rust 服务长期分叉。Node 样例只保留为外部安装/manifest 示例。

### 阶段 3：外部 MCP server 正式化

有两条可选路线：

1. Node 外部插件路线：保留 `examples/plugins/long-goal-mcp-plugin/mcp/long-goal-mcp-server.js`，补齐工具校验、文件锁、状态机约束和测试。
2. Rust 二进制路线：新增 `polaris-long-goal-mcp`，像 `polaris-todo-mcp` 一样由宿主解析路径，并可复用 Rust `LongGoalService`。

已开始采用 Rust 二进制路线；Node 样例只用于验证外部插件安装、manifest 和工具边界。

### 阶段 4：UI 入口归属调整

当前长期目标面板来自 `polaris.long-goal` 的受控宿主入口，不是外部插件自带前端代码。

迁移顺序：

1. 已保留内置 `LongGoalPanel`，确保功能稳定。
2. 已将 `long-goal.panel` 从 `polaris.core` 移到受控 manifest `polaris.long-goal`。
3. 外部插件 manifest 可声明 `panelType: 'longGoal'`，但 React 组件仍由宿主提供。
4. 只有插件系统支持外部前端代码后，才考虑真正动态加载外部 UI。

### 阶段 5：权限和状态约束

- `workspaceRead`：读取长期目标文档。
- `workspaceWrite`：写入补充、进度、队列和状态。
- `aiToolAccess`：允许聊天会话调用 MCP tools。
- `allowCodeChanges` / `allowGitCommit` 仍是长期目标执行策略，不等同于插件安装权限。
- 外部 MCP 不应直接新建会话、启动后台定时器或绕过用户暂停状态。

### 阶段 A：纯设计和 schema

- 定义 `goal.json` schema。
- 定义 MCP tools 输入输出。
- 定义目标状态机。
- 定义 UI 状态模型。
- 定义权限声明。

### 阶段 B：核心文档服务

- 从 scheduler protocol mode 中抽出长期目标文档服务。
- 不接自动会话，只支持创建、读取、更新、暂停、恢复。

### 阶段 C：MCP 插件原型

- 做一个外部长期目标 MCP server。
- 支持 create/read/decompose/select/record/pause/resume。
- 用本地安装插件方式安装，不做内置插件。

### 阶段 D：Polaris 会话编排

- 支持目标创建后自动新建规划会话。
- 支持完成后间隔触发下一次执行会话。
- 支持选择 AI 引擎。
- 支持中断当前会话。

### 阶段 E：UI 可视化和复审

- 长期目标列表。
- 当前会话面板。
- 历史会话。
- 完成后复审入口。
- 手动维护会话入口。

## 当前开放问题

- 用户补充是每轮合并进主协议后清空，还是长期保留追加日志？
- 第一版是否复用 scheduler 的协议模板，还是新建长期目标模板体系？
- 自动执行失败后，是暂停等待用户，还是按重试次数自动继续？
- 当前会话实时输出是否复用已有聊天 UI，还是做长期目标专用执行面板？
