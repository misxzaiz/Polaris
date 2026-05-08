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
  "autoPauseOnComplete": true,
  "allowCodeChanges": true,
  "allowGitCommit": true,
  "currentStepId": "step-3",
  "currentSessionId": null,
  "lastSessionId": "session-id",
  "nextRunAt": 0,
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

## MCP Tools 草案

### `create_goal`

创建长期目标文档结构。

输入：

- `title`
- `goal`
- `workspacePath`
- `engineId`
- `interval`
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
- 前端新增长期目标左侧面板入口，支持创建目标、选择 AI 引擎、设置间隔、查看目标状态、追加用户补充、暂停/恢复、创建规划会话、创建执行会话、创建维护会话、预览维护会话输入和手动标记完成。
- 目标创建表单支持“创建后自动启动规划会话”开关，默认开启；创建成功后会立即生成规划 prompt、创建项目会话并绑定 `planning` phase。
- 规划/执行/维护会话当前复用已有聊天 UI：面板创建新的项目会话，使用目标配置的 `engineId`，把 `currentSessionId`、`lastSessionId`、`running` 状态和当前 phase 写回 `goal.json`，并把后端生成的 prompt 作为首条用户消息发送。
- 长期目标面板在存在 `currentSessionId` 时显示“中断会话”按钮，调用会话管理器中断当前 AI 会话，并将目标切回暂停状态。
- 前端已注册 App 级长期目标会话跟踪器，监听 `session_end` 后根据 `currentSessionId` 找到目标，写入 `sessions/*.md` 和 `progress.md`，并清空 `currentSessionId`。
- 后端会在目标进入 `active` 状态时按 `interval` 写入 `nextRunAt`；前端跟踪器每 30 秒扫描到期目标并自动启动下一次执行会话。
- 自动启动执行会话失败，或会话以 `error/aborted` 结束时，会写入失败记录并将目标标记为 `blocked`，停止继续自动推进。
- `completed` 状态下长期目标面板显示完成复审区，支持确认完成、继续执行、补充后重新规划。
- 长期目标详情中显示当前会话、上次会话、下次执行时间，并可展开最近会话摘要。
- 已补充 Rust 文档服务编译测试和前端 service 调用测试。

尚未完成：

- 自动执行重试次数和退避策略。
- 外部 MCP server 打包和 manifest。
- 权限模型扩展。

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
