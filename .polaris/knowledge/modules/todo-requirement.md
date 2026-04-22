# 模块：待办与需求管理

> ID: todo-requirement | 复杂度: 中 | 变更频率: 低
> 依赖: unified_todo_repository, unified_requirement_repository, simpleTodoService, requirementService, requirementStore | 被依赖: MCP 外部调用, 前端 TodoPanel/RequirementPanel, Scheduler（AI 生成需求）

## 概述

统一管理全局和工作区两级待办事项与需求队列。后端提供**双接口架构**：Tauri IPC 命令（供 GUI 直接调用）和独立 MCP Server 进程（供 Claude Code 等 AI 工具通过 stdin/stdout JSON-RPC 调用）。前端通过 Singleton Service（Todo）和 Zustand Store（Requirement）提供响应式状态管理。

## 架构模式

### P1. 双接口架构（IPC + MCP）

同一 Repository 层同时服务两条调用路径：

```
前端 GUI ──invoke()──▶ Tauri Commands (commands/todo.rs, commands/requirement.rs)
                              │
                              ▼
                    UnifiedTodoRepository / UnifiedRequirementRepository
                              ▲
                              │
Claude Code ──JSON-RPC──▶ MCP Server (todo_mcp_server.rs, requirements_mcp_server.rs)
```

- Tauri 命令：7 个 todo + 7 个 requirement 命令，通过 `AppHandle` 获取 config_dir
- MCP Server：7 个 todo + 6 个 requirement 工具，通过 CLI 参数获取 config_dir
- 两者共享 Repository 层，但参数解析、错误格式、响应结构各自独立

### P2. Singleton Service + Observer 模式（前端）

```
simpleTodoService (Singleton)
  ├── listeners: Set<() => void>
  ├── todos: TodoItem[] (内存缓存)
  └── 每个 mutation 后调用 loadTodos() + notifyListeners()

SimpleTodoPanel
  └── subscribe(refreshTodos) → useState 驱动重渲染
```

- Requirement 使用 Zustand Store 包装 `requirementService`，但底层同样是 Singleton + listener
- Todo 直接用 `useState` + `subscribe`，没有 Zustand 中间层

### P3. Read-Modify-Write 循环（后端）

每次数据变更（create/update/delete）都执行完整的三步操作：
1. `read_file_data()` — 从磁盘读取整个 JSON 文件
2. 在内存 `Vec<T>` 中执行修改
3. `write_file_data()` — 将整个文件写回磁盘

无文件锁，依赖单线程 stdin 事件循环保证安全。

### P4. 双作用域存储

```
~/.config/com.polaris.app/
├── todo/todos.json          ← 所有待办（global + workspace 混存）
├── todo/workspaces.json     ← 已注册工作区列表
├── requirements/requirements.json  ← 所有需求
├── requirements/workspaces.json
└── requirements/prototypes/{id}.html  ← 需求原型
```

- `workspace_path` 为 `None` → 全局待办/需求
- `workspace_path` 为具体路径 → 属于该工作区
- `QueryScope::Workspace` 过滤当前工作区；`QueryScope::All` 返回全部

### P5. 容错数据归一化

读取时使用 `serde_json::Value` 中间解析，然后手动归一化：
- 缺失 `id` → Todo 生成新 UUID，Requirement 丢弃该项
- 缺失时间戳 → 默认 `now_iso()` / `now_millis()`
- 缺失 `content` → 丢弃该项（返回 `None`）
- 空字符串/空数组 → 归一化为 `None`

### P6. 状态机 + 副作用

**Todo 状态**：`Pending → InProgress → Completed → Cancelled`

- `Completed` 时自动设置 `completed_at`
- 从 `Completed` 离开时清除 `completed_at`

**Requirement 状态**：`Draft → Pending → Approved/Rejected → Executing → Completed/Failed`

- `Approved/Rejected` → 设置 `reviewed_at`
- `Executing` → 设置 `executed_at`
- `Completed` → 设置 `completed_at`
- 无状态校验：任何状态可以跳转到任意其他状态

## 核心组件

### 后端（Rust）

| 组件 | 文件 | 行数 | 职责 |
|------|------|------|------|
| TodoMcpServer | `services/todo_mcp_server.rs` | 766 | 独立进程 MCP 服务器，7 个工具，JSON-RPC 2.0 |
| RequirementMcpServer | `services/requirements_mcp_server.rs` | 630 | 独立进程 MCP 服务器，6 个工具 |
| UnifiedTodoRepository | `services/unified_todo_repository.rs` | 699 | 待办仓储，双作用域，读-改-写循环 |
| UnifiedRequirementRepository | `services/unified_requirement_repository.rs` | 637 | 需求仓储，含原型管理 |
| TodoCommands | `commands/todo.rs` | 365 | 7 个 Tauri IPC 命令 |
| RequirementCommands | `commands/requirement.rs` | 406 | 7 个 Tauri IPC 命令 |
| TodoModels | `models/todo.rs` | 134 | TodoItem, TodoStatus, TodoPriority 等数据模型 |
| RequirementModels | `models/requirement.rs` | 131 | RequirementItem, 7 种状态, ExecuteConfig |
| TodoMcpBinary | `bin/polaris_todo_mcp.rs` | 85 | MCP 二进制入口，CLI 参数解析 |
| RequirementMcpBinary | `bin/polaris_requirements_mcp.rs` | 82 | MCP 二进制入口 |

### 前端（TypeScript/React）

| 组件 | 文件 | 行数 | 职责 |
|------|------|------|------|
| SimpleTodoPanel | `components/TodoPanel/SimpleTodoPanel.tsx` | 401 | 待办主面板，useState + service |
| TodoCard | `components/TodoPanel/TodoCard.tsx` | 253 | 单条待办卡片 |
| TodoForm | `components/TodoPanel/TodoForm.tsx` | 378 | 创建/编辑表单 |
| TodoDetailDialog | `components/TodoPanel/TodoDetailDialog.tsx` | 76 | 编辑弹窗 |
| PriorityIcon | `components/TodoPanel/PriorityIcon.tsx` | 45 | 优先级图标映射 |
| RequirementPanel | `components/RequirementPanel/RequirementPanel.tsx` | 561 | 需求主面板，Zustand store |
| RequirementCard | `components/RequirementPanel/RequirementCard.tsx` | 207 | 单条需求卡片 |
| RequirementForm | `components/RequirementPanel/RequirementForm.tsx` | 278 | 创建/编辑表单 |
| RequirementDetailDialog | `components/RequirementPanel/RequirementDetailDialog.tsx` | 524 | 详情/编辑弹窗，含原型预览 |
| RequirementGenerateDialog | `components/RequirementPanel/RequirementGenerateDialog.tsx` | 132 | AI 生成需求弹窗 |
| simpleTodoService | `services/simpleTodoService.ts` | 283 | Todo 前端服务层 Singleton |
| requirementService | `services/requirementService.ts` | 298 | Requirement 前端服务层 Singleton |
| requirementStore | `stores/requirementStore.ts` | 309 | Requirement Zustand Store |
| todo types | `types/todo.ts` | 538 | Todo 类型定义（含大量未使用类型） |
| requirement types | `types/requirement.ts` | 320 | Requirement 类型定义 |

## 数据流

### D1. Todo 创建流程

```
用户输入 → TodoForm.onSubmit
  → simpleTodoService.createTodo(params)
    → invoke('create_todo', { ...params, workspacePath })
      → commands/todo.rs: create_todo()
        → UnifiedTodoRepository::create_todo()
          → read_file_data() → 生成 UUID → push → write_file_data()
      ← TodoItem
    → simpleTodoService.loadTodos()
      → invoke('list_todos')
    → notifyListeners()
  → SimpleTodoPanel.refreshTodos() → useState 触发重渲染
```

### D2. Requirement AI 生成流程

```
RequirementGenerateDialog.onConfirm
  → RequirementPanel.handleGenerate(scope, context)
    → useSchedulerStore.getState().createTask({
        name, triggerType: 'once', engineId, prompt: "分析并生成需求..."
      })
      → 后台 Scheduler 执行 prompt → AI 调用 MCP create_requirement
        → requirements_mcp_server: execute_create_requirement()
          → UnifiedRequirementRepository::create_requirement()
```

注意：RequirementPanel 不直接创建需求，而是委托给 Scheduler 异步执行。

### D3. 需求审核 + 执行流程

```
RequirementCard [Approve] → store.approveRequirements([id])
  → Promise.all(ids.map(id => updateRequirement(id, { status: 'approved' })))
    → invoke('update_requirement', { id, status: 'approved' })
      → repository: apply_status_side_effects → reviewed_at = now

RequirementCard [Execute] → store.updateRequirement(id, { status: 'executing' })
  → RequirementPanel.handleExecute(req)
    → useSchedulerStore.getState().createTask({
        triggerType: 'once', prompt: "执行需求: ..."
      })
    → 后台执行 → AI 调用 MCP update_requirement({ status: 'completed'/'failed' })
```

## 设计决策

| # | 决策 | 选择 | 原因 | 代价 |
|---|------|------|------|------|
| D1 | 两个 MCP Server vs 统一 | 分离 | Todo 和 Requirement 生命周期不同，工具集差异大 | JSON-RPC 协议代码重复 ~200 行 |
| D2 | 前端状态管理策略 | Todo=useState, Req=Zustand | Todo 先开发用了简单方案；Req 后开发选了 Zustand | 两套模式共存，维护成本翻倍 |
| D3 | 存储格式 | 单 JSON 文件全量读写 | 实现简单，数据量小（通常 < 100 条） | 不支持并发写；大数据量时性能瓶颈 |
| D4 | 时间戳格式 | Todo=ISO 字符串, Req=epoch 毫秒 | 独立开发，未统一约定 | 前端格式化代码需要两套逻辑 |
| D5 | 唯一性约束 | 仅 Requirement 校验标题去重 | 需求标题是业务标识；待办内容可重复 | update_requirement 不校验，可重名 |
| D6 | 便捷操作 | Todo 有 start/complete 快捷命令 | 减少参数传递，语义清晰 | MCP 侧也有，但前端实际用 updateTodo |
| D7 | 原型存储 | 独立 HTML 文件 + DB 记录 | 文件可独立访问，iframe 可直接渲染 | 删除时需同步清理；save_prototype 忽略更新错误 |
| D8 | 容错策略 | 静默丢弃损坏数据 | 保证系统可用性 | 数据丢失无日志 |

## 已知陷阱

### 后端

1. **JSON-RPC 结构体重复**：`JsonRpcRequest/JsonRpcError/JsonRpcResponse` 在 `todo_mcp_server.rs` 和 `requirements_mcp_server.rs` 中完全重复定义，无共享协议模块
2. **QueryScope 独立定义**：`models/todo.rs` 和 `models/requirement.rs` 各自定义了同名但不同类型的 `QueryScope` 枚举，不可互换
3. **无文件锁**：`read_file_data → modify → write_file_data` 非原子操作，理论上多进程并发可损坏数据（实际单线程 stdin loop 保证了安全）
4. **save_prototype 忽略更新错误**：`unified_requirement_repository.rs:299` 用 `let _ = self.update_requirement(...)` — 需求被并发删除后，HTML 文件成为孤儿文件
5. **start_todo/complete_todo 无状态校验**：已完成待办可被"重新开始"，直接设置 `InProgress`（同时清除 `completed_at`）
6. **optional_string_array 静默丢弃**：传入全空字符串数组 → 返回 `None` → 更新不生效
7. **completed_at 清除逻辑过度复杂**：`requirement repository` 的 `apply_status_side_effects` 中非 Completed 状态总是设 `None`，但用了 `filter` 闭包实现
8. **线性扫描查找**：`get_todo`/`get_requirement` 用 `Vec::iter().find()` O(n)，数据量大时性能差
9. **Todo normalize 为缺失 ID 生成新 UUID**：但 Requirement normalize 直接丢弃缺失 ID 的项 — 行为不一致
10. **CLI 参数向后兼容**：单参数时判断目录是否含 `.polaris` 决定是工作区路径还是 config 路径，不够直观

### 前端

11. **TodoState/TodoActions 类型未使用**：`types/todo.ts` 声明了完整的 store 接口（queryCache、batchOperations、export/import），但实际实现用 simpleTodoService + useState，约 100 行类型声明无效
12. **SimpleTodoPanel 无 loading 状态**：数据加载期间无 spinner，用户可能看到空列表
13. **默认作用域不同**：Todo 默认 `workspace`，Requirement 默认 `all` — 用户切换面板时可能困惑
14. **approveRequirements 用 Promise.all**：部分失败时，已成功的无法回滚
15. **SimpleTodoPanel 用 eslint-disable**：两处 `eslint-disable-next-line` 排除 `refreshTodos` 避免无限循环 — 实际是设计缺陷的 workaround
16. **getStats() 非响应式**：`SimpleTodoPanel` 在渲染中直接调用 `simpleTodoService.getStats()`，仅在 `refreshTodos` 触发重渲染时更新
17. **RequirementDetailDialog 复杂度高**：524 行，集查看/编辑/原型预览/全屏/拒绝反馈于一体
