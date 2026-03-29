# Todo MCP 全局 + 工作区双模式支持

## 1. 概述

本文档总结 Todo MCP 从单一工作区模式升级为「全局 + 工作区」双模式支持的完整实现过程，包括：

- 双模式数据存储设计
- 后端统一仓库层实现
- 前端 Tauri 命令层集成
- MCP 参数向后兼容处理

## 2. 问题背景

### 2.1 原有设计

原有 Todo MCP 仅支持工作区范围待办：

- 待办存储在工作区目录 `.polaris/todos.json`
- MCP 工具只能操作当前工作区的待办
- 无法在项目间共享通用待办（如个人日程）

### 2.2 需求目标

支持双模式：

| 模式 | 存储位置 | 用途 |
|------|----------|------|
| 全局待办 | `{config_dir}/todo/todos.json` | 跨项目共享的待办 |
| 工作区待办 | `{workspace}/.polaris/todos.json` | 项目专属待办 |

查询时支持两种范围：

- `workspace`：仅当前工作区（默认）
- `all`：全局 + 所有已注册工作区

## 3. 数据存储设计

### 3.1 目录结构

```
{config_dir}/                              # 如 C:\Users\xxx\AppData\Roaming\com.polaris.app
├── todo/
│   ├── todos.json                         # 全局待办
│   └── workspaces.json                    # 已注册工作区列表

{workspace}/                               # 如 D:\projects\myapp
└── .polaris/
    └── todos.json                         # 工作区待办
```

### 3.2 工作区注册机制

当用户在某个工作区使用 Todo 功能时，自动注册到 `workspaces.json`：

```json
{
  "version": "1.0.0",
  "workspaces": [
    {
      "path": "D:\\projects\\myapp",
      "name": "myapp",
      "lastAccessedAt": "2026-03-29T04:00:56.127Z"
    }
  ]
}
```

作用：查询 `scope=all` 时遍历所有已注册工作区。

### 3.3 TodoItem 扩展字段

```typescript
interface TodoItem {
  // ... 原有字段

  /** 所属工作区路径（null 表示全局待办） */
  workspacePath?: string | null

  /** 所属工作区名称（用于显示） */
  workspaceName?: string | null
}
```

## 4. 后端实现

### 4.1 分层架构

```
┌─────────────────────────────────────────────┐
│              Tauri Commands                  │
│         (src/commands/todo.rs)              │
└────────────────────┬────────────────────────┘
                     │
┌────────────────────▼────────────────────────┐
│          UnifiedTodoRepository              │
│    (src/services/unified_todo_repository.rs)│
└────────┬───────────────────────┬────────────┘
         │                       │
┌────────▼────────┐     ┌────────▼────────┐
│ GlobalTodoRepo  │     │ WorkspaceTodoRepo│
│  (config_dir)   │     │  (.polaris)      │
└─────────────────┘     └──────────────────┘
```

### 4.2 UnifiedTodoRepository

统一仓库层，支持双模式：

```rust
pub struct UnifiedTodoRepository {
    global_dir: PathBuf,           // config_dir/todo
    current_workspace: Option<PathBuf>,
    current_workspace_name: Option<String>,
}

impl UnifiedTodoRepository {
    /// 列出待办（支持 scope 参数）
    pub fn list_todos(&self, scope: QueryScope) -> Result<Vec<TodoItem>>;

    /// 创建待办（支持 is_global 参数）
    pub fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem>;

    /// 更新/删除待办（自动定位所属仓库）
    pub fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem>;
    pub fn delete_todo(&self, id: &str) -> Result<TodoItem>;

    /// 获取工作区分布统计
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>>;
}
```

### 4.3 QueryScope

```rust
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QueryScope {
    Workspace,  // 仅当前工作区
    All,        // 全局 + 所有已注册工作区
}
```

### 4.4 Tauri 命令

```rust
#[tauri::command]
pub async fn list_todos(params: ListTodosParams, app: AppHandle) -> Result<Vec<TodoItem>>;

#[tauri::command]
pub async fn create_todo(params: CreateTodoParams, app: AppHandle) -> Result<TodoItem>;

#[tauri::command]
pub async fn update_todo(params: UpdateTodoParams, app: AppHandle) -> Result<TodoItem>;

#[tauri::command]
pub async fn delete_todo(params: DeleteTodoParams, app: AppHandle) -> Result<TodoItem>;

#[tauri::command]
pub async fn start_todo(params: StartTodoParams, app: AppHandle) -> Result<TodoItem>;

#[tauri::command]
pub async fn complete_todo(params: CompleteTodoParams, app: AppHandle) -> Result<TodoItem>;

#[tauri::command]
pub async fn get_todo_workspace_breakdown(params: GetBreakdownParams, app: AppHandle) -> Result<BTreeMap<String, usize>>;
```

## 5. 前端实现

### 5.1 SimpleTodoService 改造

从直接文件访问改为 Tauri 命令调用：

```typescript
export class SimpleTodoService {
  private scope: 'workspace' | 'all' = 'workspace'

  setScope(scope: 'workspace' | 'all'): void {
    this.scope = scope
    this.loadTodos()
  }

  private async loadTodos(): Promise<void> {
    this.todos = await invoke('list_todos', {
      params: {
        scope: this.scope,
        workspacePath: this.workspacePath,
      }
    })
  }

  async createTodo(params: { ..., isGlobal?: boolean }): Promise<TodoItem> {
    return await invoke('create_todo', {
      params: { ..., isGlobal: params.isGlobal || false, workspacePath: this.workspacePath }
    })
  }
}
```

### 5.2 UI 组件更新

**SimpleTodoPanel**：添加范围切换按钮

```tsx
const [scope, setScope] = useState<'workspace' | 'all'>('workspace')

<div className="flex gap-1">
  <button onClick={() => setScope('workspace')} className={scope === 'workspace' ? 'active' : ''}>
    <FolderOpen size={14} /> 工作区
  </button>
  <button onClick={() => setScope('all')} className={scope === 'all' ? 'active' : ''}>
    <Globe size={14} /> 全部
  </button>
</div>
```

**TodoForm**：添加全局待办复选框

```tsx
const [isGlobal, setIsGlobal] = useState(false)

<label>
  <input type="checkbox" checked={isGlobal} onChange={e => setIsGlobal(e.target.checked)} />
  创建为全局待办
</label>
```

**TodoCard**：使用新字段显示工作区信息

```tsx
const isGlobal = !todo.workspacePath
const workspaceDisplayName = todo.workspaceName || (isGlobal ? '全局' : null)

{isGlobal ? (
  <Globe size={12} /> 全局
) : workspaceDisplayName && (
  <FolderOpen size={12} /> {workspaceDisplayName}
)}
```

## 6. MCP 工具更新

### 6.1 工具列表

| 工具名 | 说明 |
|--------|------|
| `list_todos` | 列出待办，支持 `scope` 参数 |
| `get_todo` | 获取单个待办 |
| `create_todo` | 创建待办，支持 `is_global` 参数 |
| `update_todo` | 更新待办 |
| `delete_todo` | 删除待办 |
| `start_todo` | 开始待办 |
| `complete_todo` | 完成待办 |
| `get_workspace_breakdown` | 获取工作区分布统计 |

### 6.2 参数格式

**list_todos**：
```json
{ "scope": "workspace" | "all" }
```

**create_todo**：
```json
{
  "content": "待办内容",
  "priority": "normal",
  "isGlobal": false,
  ...
}
```

## 7. 向后兼容处理

### 7.1 MCP 二进制参数兼容

新版本期望：`polaris-todo-mcp <config_dir> [workspace_path]`

旧配置格式：`polaris-todo-mcp <workspace_path>`（缺少 config_dir）

兼容逻辑：

```rust
fn parse_args(args: &[String]) -> Result<(String, Option<&str>)> {
    match args.len() {
        2 => {
            // 单参数：检测是工作区还是 config_dir
            let path = PathBuf::from(&args[1]);
            if path.exists() && path.join(".polaris").exists() {
                // 旧格式：使用默认 config_dir
                let config_dir = get_default_config_dir()?;
                Ok((config_dir, Some(&args[1])))
            } else {
                // 新格式：config_dir，无工作区
                Ok((args[1].clone(), None))
            }
        }
        3 => {
            // 新格式：config_dir + workspace_path
            Ok((args[1].clone(), Some(&args[2])))
        }
        _ => Err(...)
    }
}
```

### 7.2 默认 config_dir

```rust
fn get_default_config_dir() -> Result<String> {
    dirs::config_dir()
        .map(|p| p.join("com.polaris.app"))
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppError::ProcessError("无法确定配置目录".to_string()))
}
```

## 8. 文件清单

### 8.1 新增文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/commands/todo.rs` | Tauri 命令层 |
| `src-tauri/src/services/unified_todo_repository.rs` | 统一仓库层 |

### 8.2 修改文件

| 文件 | 说明 |
|------|------|
| `src-tauri/src/models/todo.rs` | 添加 QueryScope、TodoCreateParams.is_global |
| `src-tauri/src/services/todo_mcp_server.rs` | 支持 scope 参数 |
| `src-tauri/src/services/mcp_config_service.rs` | MCP 配置添加 config_dir 参数 |
| `src-tauri/src/bin/polaris_todo_mcp.rs` | 参数向后兼容 |
| `src-tauri/src/commands/mod.rs` | 注册 todo 模块 |
| `src-tauri/src/lib.rs` | 注册 Tauri 命令 |
| `src/types/todo.ts` | 添加 workspacePath/workspaceName 字段 |
| `src/services/simpleTodoService.ts` | 改用 Tauri 命令 |
| `src/components/TodoPanel/SimpleTodoPanel.tsx` | 添加范围切换 UI |
| `src/components/TodoPanel/TodoForm.tsx` | 添加全局待办复选框 |
| `src/components/TodoPanel/TodoCard.tsx` | 显示工作区信息 |

## 9. 后续优化

1. **i18n 支持**：添加新增 UI 文案的多语言翻译
2. **性能优化**：大量工作区时的查询缓存
3. **工作区管理**：提供工作区注销功能
4. **数据迁移**：旧版 `.polaris/todos.json` 的迁移工具
