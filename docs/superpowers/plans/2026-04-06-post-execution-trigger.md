# Post-Execution Trigger 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为定时任务添加后执行触发机制，支持循环执行、链式触发和条件触发。

**Architecture:** 在现有 `ScheduledTask` 模型中添加 `postExecution` 配置块，在 `session_end` 事件处理时执行后执行逻辑。

**Tech Stack:** TypeScript, Rust, Tauri, React, Zustand

---

## 文件结构

| 文件 | 变更类型 | 职责 |
|------|----------|------|
| `src/types/scheduler.ts` | 修改 | TypeScript 类型定义 |
| `src-tauri/src/models/scheduler.rs` | 修改 | Rust 数据模型 |
| `src-tauri/src/services/scheduler/storage.rs` | 修改 | TaskUpdateParams 结构体 |
| `src-tauri/src/commands/scheduler.rs` | 修改 | 更新命令处理新字段 |
| `src/stores/schedulerStore.ts` | 修改 | 后执行逻辑实现 |
| `src/components/Scheduler/TaskEditor.tsx` | 修改 | UI 配置表单 |

---

## Task 1: TypeScript 类型定义

**Files:**
- Modify: `src/types/scheduler.ts`

- [ ] **Step 1: 添加 PostExecutionCondition 类型**

在 `src/types/scheduler.ts` 文件中，在 `TriggerType` 类型定义之后添加：

```typescript
/** 后执行条件类型 */
export type PostExecutionCondition =
  | 'always'        // 无条件执行
  | 'on_success'    // 仅成功时执行
  | 'on_failure'    // 仅失败时执行
  | 'has_pending_work'; // 协议模式：检查是否有待办任务
```

- [ ] **Step 2: 添加 PostExecutionConfig 接口**

在 `PostExecutionCondition` 类型之后添加：

```typescript
/** 后执行配置 */
export interface PostExecutionConfig {
  /** A: 循环执行 - 完成后继续执行自身 */
  continueSelf?: boolean;
  /** 循环执行延迟 (如 "5m", "1h") */
  continueDelay?: string;
  /** B: 链式触发 - 完成后触发其他任务 */
  triggerTasks?: string[];
  /** 链式触发延迟 */
  triggerDelay?: string;
  /** D: 条件控制 */
  condition?: PostExecutionCondition;
  /** 达到最大次数后禁用任务 */
  disableOnMaxRuns?: boolean;
}
```

- [ ] **Step 3: 扩展 ScheduledTask 接口**

在 `ScheduledTask` 接口中添加 `postExecution` 字段。找到 `notifyOnComplete: boolean;` 这一行，在其后添加：

```typescript
  // === 后执行配置 ===
  /** 后执行配置 */
  postExecution?: PostExecutionConfig;
```

- [ ] **Step 4: 扩展 CreateTaskParams 接口**

在 `CreateTaskParams` 接口中添加 `postExecution` 字段。找到 `notifyOnComplete?: boolean;` 这一行，在其后添加：

```typescript
  /** 后执行配置 */
  postExecution?: PostExecutionConfig;
```

- [ ] **Step 5: 验证类型定义**

运行 TypeScript 编译检查：

```bash
cd D:/space/base/Polaris && npx tsc --noEmit --skipLibCheck
```

预期：无错误

---

## Task 2: Rust 数据模型

**Files:**
- Modify: `src-tauri/src/models/scheduler.rs`

- [ ] **Step 1: 添加 PostExecutionCondition 枚举**

在 `src-tauri/src/models/scheduler.rs` 文件中，在 `TriggerType` 枚举定义之后添加：

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
```

- [ ] **Step 2: 添加 PostExecutionConfig 结构体**

在 `PostExecutionCondition` 枚举之后添加：

```rust
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

- [ ] **Step 3: 扩展 ScheduledTask 结构体**

在 `ScheduledTask` 结构体中添加 `post_execution` 字段。找到 `pub notify_on_complete: bool,` 这一行，在其后添加：

```rust
    // === 后执行配置 ===
    #[serde(default)]
    pub post_execution: Option<PostExecutionConfig>,
```

- [ ] **Step 4: 扩展 CreateTaskParams 结构体**

在 `CreateTaskParams` 结构体中添加 `post_execution` 字段。找到 `pub notify_on_complete: bool,` 这一行，在其后添加：

```rust
    #[serde(default)]
    pub post_execution: Option<PostExecutionConfig>,
```

- [ ] **Step 5: 编译检查**

```bash
cd D:/space/base/Polaris/src-tauri && cargo check 2>&1 | head -50
```

预期：无编译错误

---

## Task 3: 存储层 TaskUpdateParams

**Files:**
- Modify: `src-tauri/src/services/scheduler/storage.rs`

- [ ] **Step 1: 添加 post_execution 字段到 TaskUpdateParams**

在 `src-tauri/src/services/scheduler/storage.rs` 文件中，找到 `TaskUpdateParams` 结构体，在 `pub notify_on_complete: Option<bool>,` 之后添加：

```rust
    pub post_execution: Option<crate::models::scheduler::PostExecutionConfig>,
```

需要同时在文件顶部添加导入（如果尚未导入）：

```rust
use crate::models::scheduler::PostExecutionConfig;
```

- [ ] **Step 2: 编译检查**

```bash
cd D:/space/base/Polaris/src-tauri && cargo check 2>&1 | head -50
```

---

## Task 4: 更新 LocalFileStorage 实现

**Files:**
- Modify: `src-tauri/src/services/scheduler/local_file_storage.rs`

- [ ] **Step 1: 更新 update_task 方法**

在 `local_file_storage.rs` 的 `update_task` 方法中，添加 `post_execution` 字段的处理。找到更新 `notify_on_complete` 的位置，在其后添加：

```rust
    if let Some(post_execution) = updates.post_execution {
        task.post_execution = Some(post_execution);
    }
```

- [ ] **Step 2: 编译检查**

```bash
cd D:/space/base/Polaris/src-tauri && cargo check 2>&1 | head -50
```

---

## Task 5: 更新 Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands/scheduler.rs`

- [ ] **Step 1: 更新 scheduler_update_task 命令**

在 `src-tauri/src/commands/scheduler.rs` 的 `scheduler_update_task` 函数中，找到 `TaskUpdateParams` 的构建，添加 `post_execution` 字段：

```rust
    repository.update_task(&task.id, TaskUpdateParams {
        name: Some(task.name),
        enabled: Some(task.enabled),
        trigger_type: Some(task.trigger_type),
        trigger_value: Some(task.trigger_value),
        engine_id: Some(task.engine_id),
        prompt: Some(task.prompt),
        work_dir: task.work_dir,
        description: task.description,
        mode: Some(task.mode),
        category: Some(task.category),
        mission: task.mission,
        template_id: task.template_id,
        template_params: task.template_params,
        max_runs: task.max_runs,
        current_runs: Some(task.current_runs),
        max_retries: task.max_retries,
        retry_count: Some(task.retry_count),
        retry_interval: task.retry_interval,
        timeout_minutes: task.timeout_minutes,
        group: task.group,
        notify_on_complete: Some(task.notify_on_complete),
        // 新增
        post_execution: task.post_execution,
        ..Default::default()
    })
```

- [ ] **Step 2: 编译检查**

```bash
cd D:/space/base/Polaris/src-tauri && cargo check 2>&1 | head -50
```

---

## Task 6: 前端执行逻辑 - 条件评估方法

**Files:**
- Modify: `src/stores/schedulerStore.ts`

- [ ] **Step 1: 添加 evaluateCondition 方法**

在 `schedulerStore.ts` 的 `SchedulerState` 接口中添加方法声明，找到 `renderProtocolDocument` 方法声明后添加：

```typescript
  // === 后执行逻辑 ===
  /** 评估后执行条件 */
  evaluateCondition: (
    condition: PostExecutionCondition,
    status: 'success' | 'failed',
    task: ScheduledTask
  ) => Promise<boolean>;
```

需要在文件顶部添加导入：

```typescript
import type {
  // ... 现有导入 ...
  PostExecutionCondition,
  PostExecutionConfig,
} from '../types/scheduler';
```

- [ ] **Step 2: 实现 evaluateCondition 方法**

在 `useSchedulerStore` 的实现中，在 `renderProtocolDocument` 方法之后添加：

```typescript
  // === 后执行逻辑 ===

  evaluateCondition: async (condition, status, task) => {
    switch (condition) {
      case 'always':
        return true;
      case 'on_success':
        return status === 'success';
      case 'on_failure':
        return status === 'failed';
      case 'has_pending_work':
        // 协议模式专用：检查 memory/tasks.md
        if (task.mode === 'protocol' && task.taskPath && task.workDir) {
          try {
            const tasksContent = await tauri.schedulerReadMemoryTasks(task.taskPath, task.workDir);
            // 检查是否有未完成的待办项
            return tasksContent.includes('- [ ]') || /\[TODO\]/i.test(tasksContent);
          } catch (e) {
            console.error('[Scheduler] 检查待办任务失败:', e);
            return false;
          }
        }
        return false;
      default:
        return true;
    }
  },
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd D:/space/base/Polaris && npx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

---

## Task 7: 前端执行逻辑 - 后执行处理方法

**Files:**
- Modify: `src/stores/schedulerStore.ts`

- [ ] **Step 1: 添加 handlePostExecution 方法声明**

在 `SchedulerState` 接口中，`evaluateCondition` 声明之后添加：

```typescript
  /** 处理后执行逻辑 */
  handlePostExecution: (task: ScheduledTask, status: 'success' | 'failed') => Promise<void>;
```

- [ ] **Step 2: 实现 handlePostExecution 方法**

在 `evaluateCondition` 实现之后添加：

```typescript
  handlePostExecution: async (task, status) => {
    const config = task.postExecution;
    if (!config) return;

    // 1. 条件检查
    if (config.condition) {
      const shouldExecute = await get().evaluateCondition(config.condition, status, task);
      if (!shouldExecute) {
        console.log('[Scheduler] 后执行条件不满足，跳过:', task.name);
        return;
      }
    }

    // 2. 检查最大执行次数
    if (task.maxRuns && task.currentRuns >= task.maxRuns) {
      console.log('[Scheduler] 达到最大执行次数，停止循环:', task.name);
      if (config.disableOnMaxRuns) {
        await get().toggleTask(task.id, false);
      }
      return;
    }

    const now = Math.floor(Date.now() / 1000);

    // 3. A: 循环执行
    if (config.continueSelf) {
      const delay = config.continueDelay ? parseIntervalValue(config.continueDelay) : null;
      const delaySeconds = delay ? delay.num * { s: 1, m: 60, h: 3600, d: 86400 }[delay.unit] : 0;
      const nextRunAt = now + delaySeconds;

      await get().updateTask({
        ...task,
        nextRunAt,
        enabled: true,
      });
      console.log('[Scheduler] 设置下次执行时间:', task.name, new Date(nextRunAt * 1000).toISOString());
    }

    // 4. B: 链式触发
    if (config.triggerTasks && config.triggerTasks.length > 0) {
      const delay = config.triggerDelay ? parseIntervalValue(config.triggerDelay) : null;
      const delaySeconds = delay ? delay.num * { s: 1, m: 60, h: 3600, d: 86400 }[delay.unit] : 0;

      for (const targetTaskId of config.triggerTasks) {
        // 跳过自身（避免死循环）
        if (targetTaskId === task.id) {
          console.warn('[Scheduler] 跳过自触发:', targetTaskId);
          continue;
        }

        // 检查目标任务是否存在
        const targetTask = get().tasks.find(t => t.id === targetTaskId);
        if (!targetTask) {
          console.warn('[Scheduler] 目标任务不存在:', targetTaskId);
          continue;
        }

        if (delaySeconds > 0) {
          // 延迟触发：设置 nextRunAt
          const nextRunAt = now + delaySeconds;
          await get().updateTask({
            ...targetTask,
            nextRunAt,
            enabled: true,
          });
          console.log('[Scheduler] 延迟触发任务:', targetTask.name, new Date(nextRunAt * 1000).toISOString());
        } else {
          // 立即触发
          console.log('[Scheduler] 立即触发任务:', targetTask.name);
          await get().runTask(targetTaskId, { subscribe: false });
        }
      }
    }
  },
```

- [ ] **Step 3: TypeScript 检查**

```bash
cd D:/space/base/Polaris && npx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

---

## Task 8: 集成后执行逻辑到 updateRunStatus

**Files:**
- Modify: `src/stores/schedulerStore.ts`

- [ ] **Step 1: 在 updateRunStatus 中调用 handlePostExecution**

找到 `updateRunStatus` 方法的实现，在 `await tauri.schedulerUpdateRunStatus(id, status);` 之后、`set((state) => {` 之前添加：

```typescript
    // 获取任务信息用于后执行处理
    const task = get().tasks.find(t => t.id === id);

    // 处理后执行逻辑
    if (task?.postExecution) {
      // 异步执行，不阻塞状态更新
      get().handlePostExecution(task, status).catch(e => {
        console.error('[Scheduler] 后执行处理失败:', e);
      });
    }
```

- [ ] **Step 2: TypeScript 检查**

```bash
cd D:/space/base/Polaris && npx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

---

## Task 9: UI 表单 - 状态管理

**Files:**
- Modify: `src/components/Scheduler/TaskEditor.tsx`

- [ ] **Step 1: 添加后执行配置状态**

在 `TaskEditor.tsx` 中，找到状态声明区域（约第 75-79 行），在 `timeoutMinutes` 状态之后添加：

```typescript
  // 后执行配置
  const [postExecution, setPostExecution] = useState<PostExecutionConfig | undefined>(task?.postExecution);
```

需要添加导入：

```typescript
import type { ScheduledTask, CreateTaskParams, TriggerType, TaskMode, TaskCategory, ProtocolTemplate, PostExecutionConfig, PostExecutionCondition } from '../../types/scheduler';
```

- [ ] **Step 2: 更新 handleSave 方法**

在 `handleSave` 方法中，找到 `onSave({...})` 调用，在 `group: group.trim() || undefined,` 之后添加：

```typescript
      // 后执行配置
      postExecution,
```

---

## Task 10: UI 表单 - 配置区块

**Files:**
- Modify: `src/components/Scheduler/TaskEditor.tsx`

- [ ] **Step 1: 添加后执行策略配置 UI**

在表单内容区域，找到触发配置 `<TriggerConfig ... />` 之后（约第 406 行），添加后执行策略配置区块：

```tsx
          {/* 后执行策略 */}
          <div className="p-4 bg-background-surface rounded-lg border border-border-subtle space-y-4">
            <h4 className="text-sm font-medium text-text-primary">{t('editor.postExecution.title')}</h4>

            {/* 条件选择 */}
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                {t('editor.postExecution.condition')}
              </label>
              <select
                value={postExecution?.condition || 'always'}
                onChange={(e) => setPostExecution(prev => ({
                  ...prev,
                  condition: e.target.value as PostExecutionCondition
                }))}
                className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="always">{t('editor.postExecution.conditionAlways')}</option>
                <option value="on_success">{t('editor.postExecution.conditionOnSuccess')}</option>
                <option value="on_failure">{t('editor.postExecution.conditionOnFailure')}</option>
                <option value="has_pending_work" disabled={mode !== 'protocol'}>
                  {t('editor.postExecution.conditionHasPendingWork')}
                  {mode !== 'protocol' && ` (${t('editor.postExecution.protocolOnly')})`}
                </option>
              </select>
            </div>

            {/* 循环执行配置 */}
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={postExecution?.continueSelf || false}
                  onChange={(e) => setPostExecution(prev => ({
                    ...prev,
                    continueSelf: e.target.checked
                  }))}
                  className="w-4 h-4 rounded border-border-subtle"
                />
                <span className="text-sm text-text-secondary">{t('editor.postExecution.continueSelf')}</span>
              </label>

              {postExecution?.continueSelf && (
                <input
                  type="text"
                  value={postExecution.continueDelay || ''}
                  onChange={(e) => setPostExecution(prev => ({
                    ...prev,
                    continueDelay: e.target.value
                  }))}
                  placeholder="5m"
                  className="flex-1 px-3 py-1.5 bg-background-base border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
              )}
            </div>

            {/* 链式触发配置 */}
            <div>
              <label className="block text-sm text-text-secondary mb-1">
                {t('editor.postExecution.triggerTasks')}
              </label>
              <select
                multiple
                value={postExecution?.triggerTasks || []}
                onChange={(e) => {
                  const selected = Array.from(e.target.selectedOptions, option => option.value);
                  setPostExecution(prev => ({
                    ...prev,
                    triggerTasks: selected.length > 0 ? selected : undefined
                  }));
                }}
                className="w-full px-3 py-2 bg-background-base border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                {useSchedulerStore.getState().tasks
                  .filter(t => t.id !== task?.id) // 排除自身
                  .map(t => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
              </select>
              <p className="mt-1 text-xs text-text-muted">{t('editor.postExecution.triggerTasksHint')}</p>

              {(postExecution?.triggerTasks?.length || 0) > 0 && (
                <div className="mt-2">
                  <input
                    type="text"
                    value={postExecution?.triggerDelay || ''}
                    onChange={(e) => setPostExecution(prev => ({
                      ...prev,
                      triggerDelay: e.target.value || undefined
                    }))}
                    placeholder={t('editor.postExecution.triggerDelayPlaceholder')}
                    className="w-full px-3 py-1.5 bg-background-base border border-border-subtle rounded-lg text-text-primary text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              )}
            </div>

            {/* 达到最大次数后禁用 */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={postExecution?.disableOnMaxRuns || false}
                onChange={(e) => setPostExecution(prev => ({
                  ...prev,
                  disableOnMaxRuns: e.target.checked
                }))}
                className="w-4 h-4 rounded border-border-subtle"
              />
              <span className="text-sm text-text-secondary">{t('editor.postExecution.disableOnMaxRuns')}</span>
            </label>

            {/* 清除配置按钮 */}
            {(postExecution?.continueSelf || postExecution?.triggerTasks?.length) && (
              <button
                type="button"
                onClick={() => setPostExecution(undefined)}
                className="text-xs text-text-muted hover:text-danger transition-colors"
              >
                {t('editor.postExecution.clearConfig')}
              </button>
            )}
          </div>
```

---

## Task 11: 国际化文本

**Files:**
- Modify: `src/locales/zh/scheduler.json`
- Modify: `src/locales/en/scheduler.json`

- [ ] **Step 1: 添加中文翻译**

在 `src/locales/zh/scheduler.json` 的 `editor` 对象中添加：

```json
  "postExecution": {
    "title": "后执行策略",
    "condition": "执行条件",
    "conditionAlways": "无条件执行",
    "conditionOnSuccess": "成功时执行",
    "conditionOnFailure": "失败时执行",
    "conditionHasPendingWork": "有待办任务时执行",
    "protocolOnly": "仅协议模式",
    "continueSelf": "完成后继续执行自身",
    "triggerTasks": "完成后触发其他任务",
    "triggerTasksHint": "按住 Ctrl 多选",
    "triggerDelayPlaceholder": "延迟时间（如 1m）",
    "disableOnMaxRuns": "达到最大次数后禁用任务",
    "clearConfig": "清除后执行配置"
  }
```

- [ ] **Step 2: 添加英文翻译**

在 `src/locales/en/scheduler.json` 的 `editor` 对象中添加：

```json
  "postExecution": {
    "title": "Post-Execution Strategy",
    "condition": "Condition",
    "conditionAlways": "Always execute",
    "conditionOnSuccess": "Execute on success",
    "conditionOnFailure": "Execute on failure",
    "conditionHasPendingWork": "Execute when pending work exists",
    "protocolOnly": "Protocol mode only",
    "continueSelf": "Continue self after completion",
    "triggerTasks": "Trigger other tasks after completion",
    "triggerTasksHint": "Hold Ctrl to multi-select",
    "triggerDelayPlaceholder": "Delay (e.g., 1m)",
    "disableOnMaxRuns": "Disable task after max runs reached",
    "clearConfig": "Clear post-execution config"
  }
```

---

## Task 12: 构建验证

**Files:**
- 无

- [ ] **Step 1: 前端构建检查**

```bash
cd D:/space/base/Polaris && npm run build 2>&1 | tail -30
```

预期：构建成功

- [ ] **Step 2: Rust 构建检查**

```bash
cd D:/space/base/Polaris/src-tauri && cargo build 2>&1 | tail -30
```

预期：编译成功

- [ ] **Step 3: 运行应用验证**

启动应用，测试创建任务并配置后执行策略，验证 UI 正常显示。

---

## Task 13: 功能测试

**Files:**
- 无

- [ ] **Step 1: 测试循环执行场景**

1. 创建一个简单模式任务
2. 配置后执行策略：`continueSelf: true`, `condition: 'on_success'`, `continueDelay: '1m'`
3. 手动触发任务执行
4. 等待任务完成，验证任务 `nextRunAt` 被更新为 1 分钟后

- [ ] **Step 2: 测试链式触发场景**

1. 创建两个任务：Task A 和 Task B
2. Task A 配置后执行策略：`triggerTasks: ['task-b-id']`, `condition: 'on_success'`
3. 手动触发 Task A
4. 验证 Task A 完成后 Task B 被触发执行

- [ ] **Step 3: 测试条件触发场景**

1. 创建一个协议模式任务
2. 配置后执行策略：`condition: 'has_pending_work'`, `continueSelf: true`
3. 在 `memory/tasks.md` 中添加待办项
4. 手动触发任务
5. 验证任务完成检测到待办项后会继续执行

- [ ] **Step 4: 测试向后兼容**

1. 检查现有任务列表
2. 验证旧任务正常加载，无 `postExecution` 字段
3. 编辑旧任务，验证可以正常保存

---

## Task 14: 提交代码

**Files:**
- 无

- [ ] **Step 1: Git 提交**

```bash
cd D:/space/base/Polaris && git add -A && git status
```

检查变更文件列表，确认无误后提交：

```bash
git commit -m "$(cat <<'EOF'
feat(scheduler): add post-execution trigger mechanism

- Add PostExecutionConfig and PostExecutionCondition types
- Support loop execution (continueSelf) after task completion
- Support chain trigger (triggerTasks) to downstream tasks
- Support conditional execution based on status or pending work
- Add UI configuration in TaskEditor

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 2: 验证提交**

```bash
git log -1 --oneline
```