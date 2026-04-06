# 定时任务后执行触发机制设计

> 日期: 2026-04-06
> 状态: Draft
> 作者: Claude

## 背景

当前调度器系统支持三种触发类型：`once`（单次）、`cron`（定时）、`interval`（间隔）。这些触发方式都需要预先设置执行时间。

用户需要任务执行完成后自动触发下一轮执行的能力，具体场景：

- **A（循环执行）**: 任务完成后自动再次执行自身，直到满足停止条件
- **B（链式触发）**: 任务完成后触发其他任务，形成任务链
- **D（条件触发）**: 任务完成后根据执行结果决定是否继续

## 设计目标

1. 解耦触发时机与执行后行为
2. 向后兼容现有任务配置
3. 支持组合配置（A + B 同时生效）
4. 利用现有协议模式基础设施（`memory/tasks.md`）

## 方案设计

### 数据模型

#### 新增类型定义

**TypeScript** (`src/types/scheduler.ts`):

```typescript
/** 后执行条件类型 */
export type PostExecutionCondition =
  | 'always'        // 无条件执行
  | 'on_success'    // 仅成功时执行
  | 'on_failure'    // 仅失败时执行
  | 'has_pending_work'; // 协议模式：检查是否有待办任务

/** 后执行配置 */
export interface PostExecutionConfig {
  /** A: 循环执行 - 完成后继续执行自身 */
  continueSelf?: boolean;
  /** 循环执行延迟 (如 "5m", "1h") */
  continueDelay?: string;

  /** B: 链式触发 - 完成后触发其他任务 */
  triggerTasks?: string[];
  /** 铱式触发延迟 */
  triggerDelay?: string;

  /** D: 条件控制 */
  condition?: PostExecutionCondition;

  /** 达到最大次数后禁用任务 */
  disableOnMaxRuns?: boolean;
}
```

**Rust** (`src-tauri/src/models/scheduler.rs`):

```rust
/// 后执行条件类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum PostExecutionCondition {
    #[default]
    Always,
    OnSuccess,
    OnFailure,
    HasPendingWork,
}

/// 后执行配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PostExecutionConfig {
    pub continue_self: Option<bool>,
    pub continue_delay: Option<String>,
    pub trigger_tasks: Option<Vec<String>>,
    pub trigger_delay: Option<String>,
    pub condition: Option<PostExecutionCondition>,
    pub disable_on_max_runs: Option<bool>,
}
```

#### 扩展 ScheduledTask

在现有 `ScheduledTask` 结构中添加:

```typescript
// TypeScript
postExecution?: PostExecutionConfig;
```

```rust
// Rust
pub post_execution: Option<PostExecutionConfig>,
```

### 执行流程

#### 触发时机

后执行逻辑在 `session_end` 事件处理时触发，位于 `schedulerStore.ts` 的 `updateRunStatus` 方法中。

#### 执行逻辑伪代码

```
function handlePostExecution(task, executionStatus):
    config = task.postExecution

    // 1. 条件检查
    if config.condition:
        if not evaluateCondition(config.condition, executionStatus, task):
            return  // 条件不满足，不执行后处理

    // 2. 检查最大执行次数
    if task.maxRuns and task.currentRuns >= task.maxRuns:
        if config.disableOnMaxRuns:
            disableTask(task.id)
        return  // 达到上限，停止循环

    // 3. A: 循环执行
    if config.continueSelf:
        delay = parseInterval(config.continueDelay || "0")
        nextRunAt = now + delay
        updateTask(task.id, { nextRunAt, enabled: true })

    // 4. B: 链式触发
    if config.triggerTasks:
        for targetTaskId in config.triggerTasks:
            if config.triggerDelay:
                // 延迟触发：设置目标任务的 nextRunAt
                nextRunAt = now + parseInterval(config.triggerDelay)
                updateTask(targetTaskId, { nextRunAt, enabled: true })
            else:
                // 立即触发
                runTask(targetTaskId)

function evaluateCondition(condition, status, task):
    switch condition:
        case 'always':
            return true
        case 'on_success':
            return status == 'success'
        case 'on_failure':
            return status == 'failed'
        case 'has_pending_work':
            // 协议模式专用：检查 memory/tasks.md
            if task.mode == 'protocol' and task.taskPath:
                return checkHasPendingWork(task.taskPath, task.workDir)
            return false
```

#### 条件检查实现

`has_pending_work` 条件利用协议模式现有的 `memory/tasks.md` 文件：

```typescript
// 新增方法
async checkHasPendingWork(taskPath: string, workDir: string): boolean {
  const tasksContent = await tauri.schedulerReadMemoryTasks(taskPath, workDir);
  // 检查是否有未完成的待办项（Markdown 待办格式）
  return tasksContent.includes('- [ ]') || /\[TODO\]/i.test(tasksContent);
}
```

### UI 设计

在 `TaskEditor.tsx` 的执行控制区块添加"后执行策略"配置：

```
┌─────────────────────────────────────────┐
│ 后执行策略                               │
├─────────────────────────────────────────┤
│ 策略类型: [无 ▼]                         │
│   - 无                                   │
│   - 循环执行                             │
│   - 链式触发                             │
│   - 组合（循环+链式）                    │
├─────────────────────────────────────────┤
│ 条件: [always ▼]                         │
│   - 无条件                               │
│   - 成功时执行                           │
│   - 失败时执行                           │
│   - 有待办任务时执行（协议模式）          │
├─────────────────────────────────────────┤
│ 循环延迟: [5m] 分钟                      │
│ 达到最大次数后禁用: [✓]                  │
├─────────────────────────────────────────┤
│ 触发任务: [任务A ▼] [任务B ▼]            │
│ 触发延迟: [0] 分钟                       │
└─────────────────────────────────────────┘

**UI 实现细节**:
- 触发任务选择器使用 `schedulerStore.tasks` 列表填充
- 支持多选（数组选择）
- 排除当前任务自身（避免自触发死循环）
- 禁用状态下拉选项灰显
```

### 存储层变更

`UnifiedSchedulerRepository` 和相关 CRUD 命令需要处理新字段：

1. `CreateTaskParams` 添加 `postExecution?: PostExecutionConfig`
2. `TaskUpdateParams` 添加 `post_execution: Option<PostExecutionConfig>`
3. 任务 JSON 文件自动包含新字段（向后兼容）

### 场景示例配置

#### A: 循环执行（成功后继续）

```json
{
  "postExecution": {
    "continueSelf": true,
    "continueDelay": "5m",
    "condition": "on_success",
    "disableOnMaxRuns": true
  },
  "maxRuns": 10
}
```

#### B: 链式触发（成功后触发下游）

```json
{
  "postExecution": {
    "triggerTasks": ["task-review-id", "task-deploy-id"],
    "triggerDelay": "1m",
    "condition": "on_success"
  }
}
```

#### D: 条件触发（协议模式有待办才继续）

```json
{
  "mode": "protocol",
  "postExecution": {
    "continueSelf": true,
    "condition": "has_pending_work",
    "disableOnMaxRuns": true
  },
  "maxRuns": 50
}
```

#### A + B 组合

```json
{
  "postExecution": {
    "continueSelf": true,
    "continueDelay": "10m",
    "triggerTasks": ["notify-task-id"],
    "condition": "on_success"
  }
}
```

## 实现计划

### 阶段 1: 数据模型 (15 min)
- 添加 TypeScript 类型定义
- 添加 Rust 结构体定义
- 更新 CreateTaskParams / TaskUpdateParams

### 阶段 2: 存储层 (5 min)
- 确保 JSON 序列化/反序列化正确
- 验证向后兼容性

### 阶段 3: 执行逻辑 (30 min)
- 在 `updateRunStatus` 中添加后执行处理入口
- 实现 `handlePostExecution` 方法
- 实现 `evaluateCondition` 方法
- 实现 `checkHasPendingWork` 方法

### 阶段 4: UI 表单 (40 min)
- TaskEditor 添加后执行策略配置区块
- 条件类型下拉框
- 延迟时间输入
- 任务选择器（链式触发）

### 阶段 5: 测试验证 (30 min)
- 测试循环执行场景
- 测试链式触发场景
- 测试条件触发场景
- 测试组合场景
- 测试向后兼容（旧任务不受影响）

**预估总时间**: 2-3 小时

## 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 任务链死循环 | `maxRuns` 限制 + `disableOnMaxRuns` 选项 |
| 链式触发目标不存在 | 验证 triggerTasks ID，不存在时跳过并记录日志 |
| 条件检查阻塞执行 | 异步检查，超时默认返回 false |
| 并发触发竞态 | 任务执行时标记 running，daemon 检查跳过 |

## 扩展预留

- `conditionExpression?: string` - 未来支持自定义表达式条件
- 更多条件类型 - 如 `on_timeout`, `on_retry_exhausted`
- 任务 DAG 可视化 - 展示任务链依赖关系

## 附录：现有代码变更清单

### 新增文件
- 无

### 修改文件

| 文件 | 变更内容 |
|------|----------|
| `src/types/scheduler.ts` | 添加 `PostExecutionCondition`, `PostExecutionConfig` 类型，扩展 `ScheduledTask`, `CreateTaskParams` |
| `src-tauri/src/models/scheduler.rs` | 添加 `PostExecutionCondition`, `PostExecutionConfig` 结构体，扩展 `ScheduledTask`, `CreateTaskParams` |
| `src/stores/schedulerStore.ts` | 添加 `handlePostExecution`, `evaluateCondition`, `checkHasPendingWork` 方法，修改 `updateRunStatus` |
| `src-tauri/src/services/scheduler_daemon.rs` | 无需修改（daemon 只负责时间触发，后执行由 store 处理） |
| `src-tauri/src/commands/scheduler.rs` | 更新 `scheduler_update_task` 命令以处理新字段 |
| `src-tauri/src/services/unified_scheduler_repository.rs` | 更新 `TaskUpdateParams` 结构体 |
| `src/components/Scheduler/TaskEditor.tsx` | 添加后执行策略配置表单区块 |