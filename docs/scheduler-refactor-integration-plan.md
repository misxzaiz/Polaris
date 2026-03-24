# Polaris 调度系统升级整合方案

## 1. 目标

本方案用于将当前 Polaris 的“定时任务”能力，从简单的触发执行器升级为**面向长期任务推进的协议化 Agent 调度系统**。

本次方案聚焦四个核心目标：

1. **协议文档优化**：让协议文档从“长提示词”升级为“稳定规则 + 可演进状态”的结构化任务载体。
2. **零间隔连续执行**：支持任务完成后立即进入下一轮执行，而不是依赖 cron/interval 的下一次调度。
3. **AI 会话延续**：记录首次执行建立的 `session_id`，后续执行可继续同一会话，形成持续上下文。
4. **整体架构升级**：让调度器逐步演进为支持任务生命周期、执行状态、重试、上下文延续和未来工作流能力的执行内核。

---

## 2. 当前系统诊断

### 2.1 当前系统已经不是“普通定时器”

从现有实现看，当前 scheduler 已经具备以下特征：

- 可持久化任务定义与日志
- 支持 `once / cron / interval`
- 支持 protocol 模式任务目录与记忆文件
- 支持任务订阅到前端上下文
- 日志中已记录 AI `session_id`
- Claude 引擎已经支持 `--resume <session_id>`
- `AIEngine` trait 已具备 `start_session / continue_session`

这意味着当前系统的真实定位更接近：

> **“带协议文档、记忆系统和会话能力的 Agent 任务运行器”**

问题不在于“能不能做”，而在于：

- 数据模型还停留在传统 scheduler 层面
- 协议文档承担了过多运行语义
- 调度器只会按时间点触发，不理解“任务尚未完成，需要立即继续推进”
- session 虽已出现在日志里，但没有成为任务级别的长期状态

---

### 2.2 当前主要问题

#### 问题 A：协议文档过重，运行状态与规则混杂

当前 `task.md` 中同时放了：

- 任务目标
- 工作区
- 执行规则
- 工程方法论
- 节奏约束
- 架构建议

这会带来几个问题：

1. **提示词膨胀**：每轮都重复输入大量稳定内容。
2. **状态不清晰**：哪些是长期规则，哪些是本轮状态，没有边界。
3. **难以演进**：一旦要增加“连续执行”“会话延续”“阻塞原因”等能力，只能继续堆文字。
4. **机器可控性弱**：系统难以基于结构化字段做调度决策。

#### 问题 B：时间触发模型无法表达“做完立即继续”

当前调度模型只有：

- `Once`
- `Cron`
- `Interval`

它们都描述“下一次什么时候开始”，但无法描述：

- 本轮执行成功后，是否应立刻继续下一轮
- 当前任务是否还处于“推进中”
- 当前轮是否只是一个阶段完成，而非任务整体完成

这会导致协议任务虽然本质是长期推进型任务，但执行层仍是“一次性调用 AI 然后结束”。

#### 问题 C：session_id 已存在，但没有沉淀为任务能力

现在日志里保存了 `session_id`，Claude 引擎也支持 resume，但调度器执行时仍然默认：

- 每次任务运行都是新的会话
- `session_id` 仅作为日志附属信息
- 不参与下一轮调度决策

结果就是：

- 无法天然形成长期对话
- 无法继承前一轮上下文链路
- protocol 任务的“持续推进”价值被削弱

#### 问题 D：调度器与执行器职责耦合偏重

dispatcher 当前同时负责：

- 轮询待执行任务
- 决定执行方式
- 构建 prompt
- 启动 AI 会话
- 处理订阅事件
- 写日志
- 写状态
- 处理超时 / 重试

后续如果再加入：

- 连续执行策略
- session 延续策略
- run/attempt 级状态机
- 工作流编排

则 dispatcher 会快速膨胀，难以维护。

---

## 3. 升级目标定位

建议将 Polaris 调度系统重新定位为：

> **Protocol Agent Scheduler（协议化 Agent 调度内核）**

它不只是“到点执行一个 prompt”，而是要管理：

- 任务定义（Task Definition）
- 任务运行状态（Run State）
- 执行尝试（Attempt / Log）
- 记忆资产（Memory / Supplement / History）
- AI 会话（Conversation Session）
- 连续推进策略（Continuous Progression Policy）

---

## 4. 协议文档优化方案

## 4.1 设计原则

协议文档应从“大而全提示词”改造成**分层结构**：

- **稳定层**：长期不变的任务目标、工作区、原则
- **运行层**：当前阶段、待办、阻塞、下一步
- **补充层**：用户一次性附加要求
- **历史层**：归档与备份

核心原则：

1. **稳定规则尽量少重复**
2. **运行状态必须结构化、可读、可维护**
3. **用户补充与系统记忆严格分离**
4. **协议文档负责表达任务语义，调度系统负责表达运行语义**

---

## 4.2 推荐文档结构

保留现有目录，但重构职责：

```text
.polaris/tasks/<task_timestamp>/
  task.md
  user-supplement.md
  memory/
    index.md
    tasks.md
    runs.md
```

同时保留归档目录：

```text
.oprcli/tasks/<task_timestamp>/
  supplement-history/
  doc-history/
```

其中：

### `task.md`
用于保存**稳定协议**，不再承载大量运行中状态。

建议包含：

- 任务 ID
- 创建时间
- 任务目标（mission）
- 工作区
- 成果定义
- 执行边界
- 连续执行策略说明
- 会话延续策略说明

建议移除或弱化：

- 过长的工程过程说明
- 每次执行必读的大段方法论
- 重复性的 AI 行为约束

可保留为更精简的模板，例如：

```md
# 任务协议

## 任务目标
...

## 工作区
...

## 成果定义
- 什么算完成
- 什么不算完成

## 执行规则
- 优先读取补充与记忆
- 每轮只推进一个小闭环
- 完成后更新记忆与待办

## 连续执行策略
- 若任务仍未完成且允许连续执行，可立即进入下一轮

## 会话策略
- 默认记录并复用最近一次有效 session_id
```

### `memory/index.md`
用于保存**任务当前状态摘要**。

推荐结构：

```md
# 成果索引

## 当前状态
状态: 进行中 | 阻塞中 | 已完成
当前阶段: 分析 | 设计 | 开发 | 测试 | 修复 | 验收
进度: 35%
最近更新: 2026-03-24 12:00:00

## 本轮结论
- ...

## 已完成
- ...

## 当前阻塞
- ...

## 下一步
- ...
```

### `memory/tasks.md`
用于保存**明确的可执行任务队列**，避免泛化描述。

推荐结构：

```md
# 任务队列

## 待办
1. ...
2. ...

## 进行中
- ...

## 已完成
- ...

## 暂缓
- ...
```

### `memory/runs.md`
新增，保存**每轮执行摘要**，而不是把所有历史都堆到 index 中。

推荐结构：

```md
# 执行轮次记录

## Run 12
- 时间: ...
- 使用会话: ...
- 完成事项: ...
- 遗留事项: ...
- 是否触发连续执行: 是/否
```

### `user-supplement.md`
继续保留一次性用户补充语义，但模板要更明确：

```md
# 用户补充

> 用于临时调整任务方向、增加限制、插入优先事项。
> 处理完成后系统会归档并清空。

---

<!-- 在下方添加补充内容 -->
```

---

## 4.3 协议模板升级建议

在 `ProtocolTaskService` 中建议进行以下升级：

1. `generate_task_md()` 改为更精简的默认模板
2. `generate_memory_index()` 增加阶段、阻塞、下一步字段
3. `generate_memory_tasks()` 改为“待办 / 进行中 / 已完成 / 暂缓”格式
4. 新增 `generate_memory_runs()`
5. `create_task_structure_with_templates()` 同步创建 `memory/runs.md`
6. 未来允许模板版本号，例如：
   - `protocol_version: 2`
   - 便于老任务平滑迁移

---

## 5. 零间隔连续执行设计

## 5.1 需求定义

用户期望的是：

> 任务本轮执行完成后，如果任务尚未结束，系统可以立即发起下一轮，而不是等待 interval/cron。

这不是简单的 interval=0，而是一个**执行策略**问题。

因为“立即继续”通常依赖：

- 本轮是否成功
- 本轮是否产生有效成果
- 任务是否仍有待办
- 是否出现阻塞
- 是否达到最大连续轮次

所以该能力不应建模为触发器，而应建模为**连续执行策略（Continuation Policy）**。

---

## 5.2 推荐数据模型

建议为 `ScheduledTask` 增加以下字段：

```rust
pub continuous_mode: Option<ContinuousMode>,
pub max_continuous_runs: Option<u32>,
pub continuous_runs_count: u32,
pub continue_on_success: bool,
pub continue_on_partial_progress: bool,
pub stop_on_blocked: bool,
```

建议新增枚举：

```rust
pub enum ContinuousMode {
    Off,
    Immediate,
    UntilBlocked,
}
```

含义：

- `Off`：关闭连续执行
- `Immediate`：成功后立即再跑一轮
- `UntilBlocked`：只要任务仍可推进且未阻塞，就持续推进

如果希望第一版更轻，可以先只做：

```rust
pub continue_immediately: bool,
pub max_continuous_runs: Option<u32>,
```

这是最小 MVP。

---

## 5.3 执行判定逻辑

任务一轮执行结束后，dispatcher 不应立刻只计算 `next_run_at`，而应先判断是否满足连续执行条件。

推荐判断顺序：

1. 本轮是否成功完成
2. 任务是否启用连续执行
3. 是否达到 `max_runs`
4. 是否达到 `max_continuous_runs`
5. 是否检测到阻塞
6. 是否还有待办或未完成阶段

若满足条件，则：

- 立即创建下一轮执行请求
- 不等待下一次时间轮询
- 可直接在当前任务生命周期内排入本地队列

若不满足条件，则：

- 回到普通调度逻辑
- 计算 `next_run_at`

---

## 5.4 推荐实现方式

### 方案 A：Dispatcher 内最小改造

在现有 `execute_task()` 完成后：

- 根据执行结果计算 `should_continue`
- 若为 `true`，直接再次调用执行流程
- 通过计数器避免死循环

优点：

- 改动小
- 可快速验证需求

缺点：

- dispatcher 更重
- 不利于后续抽象工作流

### 方案 B：引入 RunCoordinator（推荐）

新增一个执行协调器，例如：

- `RunCoordinator`
- `TaskExecutionService`

职责：

- 负责一次任务运行链（多轮连续执行）
- 决定 start / continue session
- 决定是否立即进入下一轮
- 负责 run 级状态写回

dispatcher 只负责：

- 找到 due tasks
- 把任务交给 coordinator

这是更推荐的中期方案。

---

## 5.5 连续执行的安全边界

必须增加保护措施：

1. **最大连续轮次限制**
   - 防止无限循环
2. **最大总执行时长限制**
   - 防止一次链式运行占用过长
3. **阻塞检测**
   - 如 memory/index.md 标记“阻塞中”则停止
4. **无增量检测**
   - 连续两轮无有效进展则停止
5. **错误终止**
   - 任一轮失败后回落到 retry / failed 流程

建议第一阶段至少实现：

- `max_continuous_runs`
- `stop_on_blocked`
- `continue_on_success`

---

## 6. AI 会话延续设计

## 6.1 目标定义

用户期望：

> 第一次运行开启 AI 会话，记录对应 `session_id`；下一次执行时，继续这个对话，而不是新建会话。

当前系统已具备关键基础：

- `TaskLog.session_id` 已存在
- `AIEngine::continue_session()` 已存在
- `EngineRegistry::continue_session()` 已存在
- `ClaudeEngine` 已支持 `--resume <session_id>`

因此该能力可以作为**任务层状态管理增强**来实现。

---

## 6.2 推荐数据模型

建议在 `ScheduledTask` 中新增：

```rust
pub conversation_session_id: Option<String>,
pub session_strategy: Option<SessionStrategy>,
pub session_last_used_at: Option<i64>,
pub session_reset_on_error: bool,
```

新增枚举：

```rust
pub enum SessionStrategy {
    NewEachRun,
    ReuseLatest,
    Sticky,
}
```

建议语义：

- `NewEachRun`：每次新会话
- `ReuseLatest`：若存在最近有效 session_id，则继续，否则新建
- `Sticky`：固定使用同一任务会话，除非明确重置

MVP 可先只做：

```rust
pub conversation_session_id: Option<String>,
pub reuse_session: bool,
```

---

## 6.3 执行流程设计

### 首次执行

1. task 尚无 `conversation_session_id`
2. dispatcher / coordinator 调用 `registry.start_session(...)`
3. Claude 返回真实 session_id
4. 日志写入 `TaskLog.session_id`
5. 同时把 session_id 回写到 `ScheduledTask.conversation_session_id`

### 后续执行

1. 若 `reuse_session = true`
2. 且 task 上存在 `conversation_session_id`
3. 则调用 `registry.continue_session(engine_id, session_id, prompt, options)`
4. 若恢复失败，再降级到 `start_session`
5. 启动新会话后更新任务上的 `conversation_session_id`

---

## 6.4 session 失效处理

需要考虑以下场景：

- CLI 本地 session 已丢失
- session_id 对应上下文不可恢复
- 用户切换引擎
- prompt 结构发生重大变化，不适合沿用旧对话

建议策略：

1. `continue_session` 失败时自动降级为 `start_session`
2. 新会话创建成功后覆盖旧 `conversation_session_id`
3. 若任务配置 `session_reset_on_error = true`，则失败后清空 session
4. UI 提供“重置任务会话”按钮

---

## 6.5 Prompt 结构配合调整

如果支持会话延续，则 prompt 需要避免每次都发送重复大段背景，否则会造成：

- 冗余上下文
- 模型重复吸收稳定信息
- 后续轮次效率变差

推荐策略：

### 首轮 prompt
包含：

- 任务目标
- 工作区
- 协议规则
- 当前记忆摘要
- 当前待办
- 用户补充

### 续跑 prompt
更简洁，只强调：

- 这是同一任务的继续执行
- 本轮新增补充
- 上轮后新增状态变化
- 当前优先事项
- 明确本轮目标

这意味着 `build_prompt()` 后续应支持区分：

- `InitialPrompt`
- `ContinuationPrompt`

---

## 7. 核心数据模型升级建议

建议把当前 `ScheduledTask` 从“静态任务定义 + 少量运行字段”升级为“任务定义 + 持久运行态”。

推荐新增字段：

```rust
pub protocol_version: Option<u32>,
pub execution_mode: Option<String>, // simple / protocol / workflow
pub continue_immediately: bool,
pub max_continuous_runs: Option<u32>,
pub continuous_runs_count: u32,
pub conversation_session_id: Option<String>,
pub reuse_session: bool,
pub session_last_used_at: Option<i64>,
pub blocked: bool,
pub blocked_reason: Option<String>,
pub current_phase: Option<String>,
pub last_effective_progress_at: Option<i64>,
```

如果后续愿意进一步抽象，建议拆分：

### TaskDefinition
保存长期定义：

- name
- trigger_type
- engine_id
- work_dir
- mission
- continuous/session 策略

### TaskRuntimeState
保存运行态：

- current_runs
- next_run_at
- retry_count
- last_run_status
- conversation_session_id
- blocked
- current_phase

这样长期更合理，但第一阶段可先不拆表。

---

## 8. 执行架构升级建议

## 8.1 目标架构

建议后续形成如下分层：

```text
SchedulerDispatcher
  -> DueTaskScanner
  -> TaskExecutionCoordinator
      -> PromptBuilder
      -> SessionStrategyResolver
      -> EngineExecutor
      -> RunStateUpdater
      -> RetryHandler
      -> ContinuationDecider
```

职责说明：

### `SchedulerDispatcher`
只负责：

- 轮询或接收到期任务
- 防止重复调度
- 把任务交给执行协调器

### `TaskExecutionCoordinator`
负责：

- 一次完整执行链的 orchestration
- 多轮连续执行控制
- session 复用决策
- 执行结果归并

### `PromptBuilder`
负责：

- 构建初次执行 prompt
- 构建续跑 prompt
- 注入协议文档与记忆内容

### `SessionStrategyResolver`
负责：

- 决定 `start_session` 还是 `continue_session`
- 处理会话失效回退

### `RunStateUpdater`
负责：

- 更新任务状态
- 更新 session_id
- 更新 runs 记录
- 更新 memory 文件

### `ContinuationDecider`
负责：

- 判断是否立即再跑一轮
- 控制最大连续轮次
- 检测阻塞 / 无进展

---

## 8.2 为什么不建议现在就完全重写

虽然允许完全重构，但当前并不需要一步到位大改。

原因：

1. 现有系统已经具备关键能力雏形
2. session resume 基础已经存在
3. protocol 文件体系已可复用
4. 最大问题是边界与模型，而不是底层完全不可用

因此建议策略是：

> **先做“语义升级 + 模型升级 + 执行协调器抽离”，再决定是否走 workflow 引擎化。**

这比直接全量推倒重写更稳。

---

## 9. 分阶段实施路线图

## Phase 1：最小可用增强（推荐立即做）

目标：最小成本实现用户最关心的两个能力。

### 范围

1. 协议模板精简与结构化
2. 任务支持 `reuse_session`
3. 任务支持 `continue_immediately`
4. 成功执行后可立即再跑一轮
5. 首轮 session_id 回写到任务
6. 后续运行优先 `continue_session`

### 建议改动文件

- `src-tauri/src/models/scheduler.rs`
- `src-tauri/src/services/scheduler/store.rs`
- `src-tauri/src/services/scheduler/dispatcher.rs`
- `src-tauri/src/services/scheduler/protocol_task.rs`
- `src-tauri/src/commands/scheduler.rs`
- 前端 scheduler 表单与任务详情相关文件

### 交付结果

- 任务可以配置“复用会话”
- 任务可以配置“执行成功后立即继续一次/多次”
- protocol 文档模板更清晰
- 不需要完全重构即可验证产品价值

---

## Phase 2：执行协调器抽离（推荐紧接着做）

目标：控制复杂度，避免 dispatcher 持续膨胀。

### 范围

1. 新增 `TaskExecutionCoordinator`
2. 抽离 prompt 构建逻辑
3. 抽离 session 策略解析
4. 抽离连续执行判定
5. 统一成功 / 失败 / retry / continue 的状态写回

### 交付结果

- dispatcher 更轻
- 连续执行与会话延续逻辑更可测试
- 为 workflow 模式打基础

---

## Phase 3：运行态结构升级

目标：让系统真正具备任务生命周期管理能力。

### 范围

1. 增加 blocked / phase / last_effective_progress_at
2. 增加 `memory/runs.md`
3. 增加任务会话重置能力
4. UI 展示当前 phase / session / 连续执行状态
5. 改进执行结果结构化判断

### 交付结果

- 任务运行状态更可观测
- 可以更可靠地判断是否继续执行
- protocol 任务逐步具备“持续推进”体验

---

## Phase 4：存储与工作流演进（中长期）

目标：从增强版 scheduler 演进为更强的任务运行平台。

### 可选方向

1. JSON 存储迁移到 SQLite
2. Task / Run / Attempt 分离建模
3. 增加 workflow / DAG / 子任务能力
4. 支持事件触发而不只时间触发
5. 引入更强的执行队列与并发控制

### 判断标准

当以下情况明显出现时，再启动此阶段：

- 任务数量显著增多
- 日志与状态查询复杂度上升
- 需要跨任务编排
- 需要更强审计与恢复能力

---

## 10. 具体实现建议（最佳落地顺序）

建议按以下顺序实施：

### 第一步：协议文档模板升级

先改 `ProtocolTaskService`：

- 精简 `task.md`
- 结构化 `memory/index.md`
- 优化 `memory/tasks.md`
- 新增 `memory/runs.md`

原因：

- 成本低
- 直接提升 protocol 任务体验
- 为连续执行与 session 续跑准备更好的状态承载体

### 第二步：任务模型增加 session / continuation 字段

先做最小字段集：

```rust
pub reuse_session: bool,
pub conversation_session_id: Option<String>,
pub continue_immediately: bool,
pub max_continuous_runs: Option<u32>,
```

原因：

- 能快速打通核心能力
- 不需要先上复杂状态机

### 第三步：dispatcher 增加 start/continue 分支

逻辑：

- 有 session 且允许复用 → `continue_session`
- 否则 → `start_session`
- 失败自动降级到新会话
- 新 session 成功后回写 task

### 第四步：执行成功后增加 immediate continuation

逻辑：

- 成功后判断 `continue_immediately`
- 若为真且未达上限，则直接进入下一轮
- 每轮更新 logs 与 runs 记录

### 第五步：抽离 coordinator

在功能已验证后再做架构整理，避免前期设计过度。

---

## 11. 风险与注意事项

## 11.1 会话复用风险

### 风险

- 旧 session 上下文过长，导致性能下降
- 历史上下文污染新一轮执行
- 引擎切换后 session 不可用

### 应对

- 提供“重置会话”入口
- 允许按任务配置是否复用 session
- 对长任务支持“定期新开会话，但保留摘要”模式（后续能力）

---

## 11.2 连续执行风险

### 风险

- 任务陷入无限自循环
- 一次任务占用过长，影响其他任务
- 连续运行造成日志膨胀

### 应对

- 强制 `max_continuous_runs`
- 增加总执行时长限制
- 检测阻塞/无进展
- 在 UI 明确展示“连续执行中”状态

---

## 11.3 协议文档风险

### 风险

- 模板升级后与历史任务不兼容
- 文档字段变多后维护成本上升

### 应对

- 增加 `protocol_version`
- 对旧任务保持兼容读取
- 模板尽量保持简洁，不把运行状态重新堆回 `task.md`

---

## 12. 最终建议

综合当前代码基础与目标诉求，最佳方案不是直接完全重写，而是：

> **先把当前 scheduler 升级为“支持协议、连续执行、会话延续”的 Agent 调度内核，再视业务复杂度决定是否进入 workflow/SQLite 阶段。**

### 最推荐的近期实施包

#### P0（必须优先）

1. 重构 protocol 默认模板
2. 为任务增加 `reuse_session`
3. 为任务增加 `conversation_session_id`
4. 为任务增加 `continue_immediately`
5. Claude 执行路径支持优先 `continue_session`
6. 执行成功后支持立即进入下一轮

#### P1（紧随其后）

1. 新增 `memory/runs.md`
2. 增加 `max_continuous_runs`
3. 增加 session 失效自动回退
4. 抽离 `TaskExecutionCoordinator`

#### P2（中期演进）

1. phase / blocked / progress 结构化
2. SQLite 存储
3. Task / Run / Attempt 分层
4. 工作流化与事件驱动扩展

---

## 13. 结论

Polaris 当前的 scheduler 已经具备向“长期任务推进系统”升级的现实基础，特别是：

- protocol 目录与文档体系已存在
- 日志中已记录 `session_id`
- 引擎层已支持 `continue_session`
- Claude CLI 已支持 `--resume`

因此最优路径不是推翻重写，而是围绕以下三点完成升级：

1. **协议文档从长提示词改为分层状态载体**
2. **执行链从单次调度改为支持零间隔连续推进**
3. **AI 运行从单次会话改为支持任务级会话延续**

完成这三步后，Polaris 的 scheduler 将不再只是“定时执行 prompt”，而会成为一个真正可持续推进任务的协议化 Agent Runtime 基础设施。
