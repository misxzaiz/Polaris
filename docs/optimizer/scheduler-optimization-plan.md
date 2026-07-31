# 定时任务系统优化方案

> 分析时间：2025-07-31
> 目标：简化当前过于复杂的定时任务系统，让普通用户更容易使用

---

## 一、现状分析

### 1.1 代码规模

| 层级 | 文件数 | 代码量 |
|------|--------|--------|
| 前端组件 (`src/components/Scheduler/`) | 14 个文件 | ~3000 行 |
| 前端 Store (`stores/schedulerStore.ts`) | 1 个文件 | ~500 行 |
| 前端类型 (`types/scheduler.ts`) | 1 个文件 | ~400 行 |
| 前端 Service (`services/tauri/schedulerService.ts`) | 1 个文件 | ~300 行 |
| 后端命令 (`commands/scheduler.rs`) | 1 个文件 | ~844 行 |
| 后端模型 (`models/scheduler.rs`) | 1 个文件 | ~1025 行 |
| 后端服务 (`services/scheduler/`) | 5 个文件 | ~1500 行 |
| 后端守护进程 (`services/scheduler_daemon.rs`) | 1 个文件 | ~330 行 |
| 后端仓库 (`services/unified_scheduler_repository.rs`) | 1 个文件 | ~359 行 |
| MCP 服务器 (`services/scheduler_mcp_server.rs`) | 1 个文件 | ~612 行 |
| **合计** | **28 个文件** | **~8870 行** |

### 1.2 功能清单（当前）

| 功能模块 | 复杂度 | 实际使用率 |
|----------|--------|-----------|
| 简单模式 (simple) 任务 | 中 | ⭐⭐⭐⭐ |
| 协议模式 (protocol) 任务 | 极高 | ⭐⭐ |
| 提示词模板 (PromptTemplate) | 中 | ⭐⭐ |
| 协议模板 (ProtocolTemplate) | 极高 | ⭐ |
| 快捷片段 (Snippet) | 低 | ⭐⭐ |
| 4 种触发类型 (once/cron/interval/after_completion) | 高 | ⭐⭐⭐ |
| 调度器分布式锁 | 高 | ⭐⭐ |
| 执行日志（标签页+抽屉+自动滚动+拖拽） | 极高 | ⭐⭐⭐ |
| 事件订阅系统 | 高 | ⭐⭐⭐ |
| 任务分类/模式/分组 | 中 | ⭐ |
| MCP 服务器 | 高 | ⭐ |
| 协议文档（生成/备份/补充/记忆） | 极高 | ⭐ |
| 筛选/排序 + localStorage 持久化 | 中 | ⭐⭐⭐ |

### 1.3 核心问题诊断

#### 🔴 问题 1：双模式割裂（Simple vs Protocol）
- 同一任务管理面板，有两条完全不同的创建/编辑/执行路径
- 协议模式需要独立的模板系统、文档生成、文件备份、记忆管理
- 用户根本不需要区分"简单"和"协议"两种模式

#### 🔴 问题 2：三层模板系统
- **PromptTemplate**：简单模式的提示词模板
- **ProtocolTemplate**：协议模式的协议文档模板
- **Snippet**：快捷片段
- 三层模板管理 UI 各需独立弹窗，用户完全懵

#### 🔴 问题 3：过度设计的执行日志
- 标签页多任务日志 + 抽屉自动展开 + 拖拽调整高度 + 自动滚动检测
- 每次执行都创建新 AI 会话（`start_chat`），日志通过事件系统路由
- 日志条目类型 7 种，每条带 metadata，前端需要图标/颜色/状态管理

#### 🔴 问题 4：冗余字段
- `TaskCategory`（5 个分类）、`group`、`mode` 字段
- `maxRuns`、`maxRetries`、`retryInterval`、`timeoutMinutes` 执行控制
- 用户实际只关心：任务名、时间、内容、是否启用

#### 🔴 问题 5：MCP 服务器重复造轮子
- 612 行的 MCP 服务器只为定时任务提供 MCP 工具
- 这些功能在 UI 中已经有完整实现
- 维护两套接口，极易不一致

---

## 二、优化方案

### 2.1 总体原则

> **KISS 原则**：只做用户真正需要的功能，砍掉过度设计的部分

**用户真实需求排序**：
1. 设置定时任务（每隔多久跑一次）
2. 一键手动执行
3. 看到执行结果
4. 查看/编辑历史任务

### 2.2 分阶段改造计划

---

### 🟢 第一阶段：前端简化（高收益，低风险）

#### 2.2.1 合并双模式为单一模式

**现状**：Simple 模式用 `prompt`，Protocol 模式用 `mission` + `taskPath` + 文档系统
**改造**：统一为单一模式，用户只需填写：
- 任务名称
- 任务内容（自由文本，作为 prompt）
- 工作目录
- 引擎选择

**删除**：
- `TaskMode` 枚举及所有相关 UI
- `TaskCategory` 枚举及所有相关 UI
- `mission`、`group` 字段

#### 2.2.2 合并模板系统

**现状**：PromptTemplate（简单模式模板） + ProtocolTemplate（协议模板）
**改造**：只保留 PromptTemplate，去掉 ProtocolTemplate 相关全部代码
- 删除 `ProtocolTemplate` 类型及所有 UI
- 删除 `ProtocolTemplateSelector`、`ProtocolTemplateManager`、`ProtocolDocumentViewer` 组件
- 删除 `templateParams`、`taskPath` 等协议模式专属字段

**结果**：从 14 个组件文件减少到 ~6 个

#### 2.2.3 简化触发类型

**现状**：4 种触发类型（once/cron/interval/after_completion）
**改造**：只保留 2 种
- `interval`：间隔执行（保留预设快捷选项）
- `cron`：Cron 表达式（保留但减少引导）
- **删除** `once`（用 interval 0s 替代）
- **删除** `after_completion`（过于复杂）

#### 2.2.4 简化执行日志

**现状**：多标签页 + 抽屉 + 拖拽 + 7 种日志类型 + 自动滚动
**改造**：
- 去掉多标签页，只保留当前执行任务的日志
- 去掉拖拽高度调整（固定高度）
- 去掉 autoScroll 检测，默认自动滚动
- 日志类型简化为 3 种：`message`、`tool`、`error`
- 去掉执行日志 Drawer 组件，改为任务卡片内直接展示最近执行状态

#### 2.2.5 简化任务编辑表单

**现状**：~20 个输入字段
**改造**：只保留核心 6 个字段
| 字段 | 说明 |
|------|------|
| 任务名称 | 必填 |
| 任务内容（Prompt） | 必填 |
| 工作目录 | 可选 |
| 引擎 | 下拉选择 |
| 触发类型 + 值 | 联合输入 |
| 是否启用 | 开关 |

**删除字段**：
- `description`、`mode`、`category`、`group`
- `templateId`、`templateParams`、`mission`
- `maxRuns`、`maxRetries`、`retryInterval`、`timeoutMinutes`
- `notifyOnComplete`、`currentRuns`、`retryCount`

#### 2.2.6 简化筛选/排序

**现状**：4 个筛选条件 + 排序 + localStorage 持久化
**改造**：只保留搜索框，去掉其他筛选和排序

---

### 🟡 第二阶段：后端简化（中等风险，需保持兼容）

#### 2.2.7 简化 Task 模型

```rust
// 改造后
struct ScheduledTask {
    id: String,
    name: String,
    prompt: String,
    engine_id: String,
    work_dir: Option<String>,
    enabled: bool,
    trigger_type: TriggerType,
    trigger_value: String,
    last_run_at: Option<i64>,
    last_run_status: Option<TaskStatus>,
    next_run_at: Option<i64>,
    created_at: i64,
    updated_at: i64,
}
```

**删除字段**：
- `description`、`mode`、`category`、`group`
- `task_path`、`mission`、`template_id`、`template_params`
- `max_runs`、`current_runs`、`max_retries`、`retry_count`
- `retry_interval`、`timeout_minutes`、`notify_on_complete`
- `workspace_path`、`workspace_name`

#### 2.2.8 删除冗余后端服务

| 服务 | 操作 |
|------|------|
| `services/scheduler/protocol_task.rs` | ❌ 删除 |
| `services/scheduler/protocol_template.rs` | ❌ 删除 |
| `services/scheduler_mcp_server.rs` (612行) | ❌ 删除 |
| `bin/polaris_scheduler_mcp.rs` | ❌ 删除 |
| `models/scheduler.rs` 中 Protocol 相关类型 | ❌ 删除 |
| `commands/scheduler.rs` 中 Protocol 相关命令 | ❌ 删除 |
| Prompt Snippet 相关命令/模型 | ❌ 删除 |

#### 2.2.9 简化调度器锁机制

**现状**：分布式锁 + PID 追踪 + isLockedByOther 状态
**改造**：
- 保留基本锁机制（防止多实例重复运行）
- 去掉复杂的 `LockStatus` 结构
- 简化为：尝试获取锁 -> 成功则运行 -> 退出时释放

---

### 🟠 第三阶段：架构优化（长期）

#### 2.2.10 统一执行流程

**现状**：
```
守护进程检测到期 → emit 事件 → 前端 handleTaskDue → 
构建 prompt → 应用模板 → start_chat → AI 执行
```

**问题**：每次定时任务执行都创建新 AI 会话，资源消耗大

**改造方向**：
- 考虑任务结果缓存（相同任务不重复执行）
- 考虑任务队列（避免同时执行多个任务）
- 考虑任务超时自动取消

---

## 三、预期效果

| 指标 | 改造前 | 改造后 | 降幅 |
|------|--------|--------|------|
| 前端组件文件数 | 14 | ~6 | -57% |
| 前端 Store 代码行 | ~500 | ~250 | -50% |
| 前端类型代码行 | ~400 | ~150 | -62% |
| 后端 Rust 代码行 | ~4700 | ~2000 | -57% |
| 用户需要理解的字段 | ~20 | 6 | -70% |
| 模板系统 | 3 套 | 1 套 | -67% |
| 触发类型 | 4 种 | 2 种 | -50% |

---

## 四、向后兼容策略

1. **数据迁移**：改造后的模型需要处理旧数据
   - 旧任务的 `mode`、`category` 等字段直接忽略
   - `protocol` 模式的任务只保留 `prompt` 字段内容
   - 旧模板系统数据保留但不展示

2. **分步实施**：
   - 第一阶段（前端）可以独立实施
   - 第二阶段（后端）需要确保数据迁移平滑
   - 第三阶段（架构）可以推迟

3. **回退方案**：
   - 通过 feature flag 控制
   - 旧模式可以通过配置恢复

---

## 五、实施建议

### 优先级排序

1. 🥇 **合并双模式** — 影响面大，用户感知强
2. 🥇 **删除协议模板系统** — 代码量大，使用率低
3. 🥈 **简化触发类型** — 减少学习成本
4. 🥈 **简化执行日志** — 减少 UI 复杂度
5. 🥉 **删除 MCP 服务器** — 维护成本高
6. 🥉 **简化筛选/排序** — 边际收益
7. 🏅 **后端模型精简** — 配合前端改造

### 预计工作量

| 阶段 | 预估工时 |
|------|----------|
| 第一阶段（前端） | 2-3 天 |
| 第二阶段（后端） | 2-3 天 |
| 第三阶段（架构） | 待定 |
| **合计** | **4-6 天** |

---

## 六、附录：当前文件清单

### 前端
```
src/components/Scheduler/
├── index.ts
├── SchedulerPanel.tsx        ← 主面板
├── SchedulerControl.tsx      ← 控制栏
├── TaskCard.tsx              ← 任务卡片
├── TaskEditor.tsx            ← 编辑器
├── TriggerConfig.tsx         ← 触发配置
├── ExecutionLogDrawer.tsx    ← 执行日志
├── TemplateManager.tsx       ← 模板管理
├── ProtocolTemplateSelector.tsx  ← 协议模板选择器
├── ProtocolTemplateManager.tsx   ← 协议模板管理
├── ProtocolDocumentViewer.tsx    ← 协议文档查看
├── ProtocolDocumentViewer.test.tsx
├── ProtocolTemplateManager.test.tsx
├── ProtocolTemplateSelector.test.tsx

src/stores/
├── schedulerStore.ts
├── schedulerStoreUtils.ts

src/types/
└── scheduler.ts

src/services/tauri/
└── schedulerService.ts

src/plugins/scheduler/
└── manifest.ts
```

### 后端 (Rust)
```
src-tauri/src/
├── commands/scheduler.rs           ← 844 行
├── models/scheduler.rs             ← 1025 行
├── services/
│   ├── scheduler/
│   │   ├── mod.rs
│   │   ├── storage.rs
│   │   ├── local_file_storage.rs
│   │   ├── protocol_task.rs        ← 待删
│   │   └── protocol_template.rs    ← 待删
│   ├── scheduler_daemon.rs         ← 330 行
│   ├── scheduler_mcp_server.rs     ← 612 行（待删）
│   └── unified_scheduler_repository.rs ← 359 行
└── bin/polaris_scheduler_mcp.rs    ← 81 行（待删）
```
