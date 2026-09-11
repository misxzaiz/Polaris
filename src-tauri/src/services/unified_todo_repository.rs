//! Unified Todo Repository（SqliteStorage 后端）
//!
//! 保持公开 API（`new(config_dir, workspace)` + list/get/create/update/delete +
//! register_workspace + get_workspace_breakdown）不变，命令层零改动。
//!
//! 存储后端：契约 `Storage::SqliteStorage`（domain=`todo`）。每个 `TodoItem`
//! 是一条 `Item { id: todo.id, data: TodoItem 的 camelCase JSON }`，存于
//! `<config_dir>/stores/todo.db` 的 `items` 表（SqliteStorage 以传入 config_dir
//! 为 data_root，在其下建 stores/）。
//!
//! 关键设计：
//! - 尊重调用方传入的 `config_dir` 作 data_root，**不在内部调 data_root()**——
//!   MCP 独立服务进程可能未初始化全局 DataRoot，无条件调用会 panic。
//! - `workspaces.json` 注册逻辑保留原实现（工作区注册元数据，独立于待办项）。
//! - workspace 过滤保留原内存过滤语义（todo 数据量小，全量读入过滤足够）。

use crate::contracts::{Id as ContractId, Item as ContractItem, Query as ContractQuery, Storage};
use crate::error::{AppError, Result};
use crate::models::todo::{
    QueryScope, TodoCreateParams, TodoItem, TodoStatus, TodoSubtask, TodoUpdateParams,
};
use crate::services::storage::SqliteStorage;
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

const TODO_FILE_VERSION: &str = "1.0.0";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing todos in a single global storage
pub struct UnifiedTodoRepository {
    /// 全局存储目录（config_dir/todo）——保留字段以维持 `workspaces.json` 落点
    storage_dir: PathBuf,
    /// 契约 Storage 抽象（当前实现 SqliteStorage，domain=todo）
    storage: Box<dyn Storage>,
    /// Current workspace path (optional, for filtering)
    current_workspace: Option<PathBuf>,
    /// Current workspace name (for display)
    current_workspace_name: Option<String>,
}

/// Workspace registration info
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub last_accessed_at: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct WorkspacesFile {
    version: String,
    workspaces: Vec<WorkspaceInfo>,
}

impl UnifiedTodoRepository {
    /// Create a new unified todo repository
    ///
    /// # Arguments
    /// * `config_dir` - 应用配置根（命令层传 app_config_dir / MCP 传外部显式路径）。
    ///   SqliteStorage 以它为 data_root，在其下建 `stores/todo.db`。
    ///   保持此参数语义不变 → 命令层零改动；用户可通过 DataRoot 锚点影响命令层取值。
    /// * `current_workspace` - Current workspace path (optional, for filtering)
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        // 存储根：尊重调用方传入的 config_dir 作为 data_root（SqliteStorage 内部建 stores/）。
        // 不在此处调 data_root()——MCP 独立进程可能未初始化全局 DataRoot，会 panic。
        let storage: Box<dyn Storage> = Box::new(
            SqliteStorage::new(&config_dir)
                .expect("SqliteStorage 初始化失败（config_dir 不可用）"),
        );

        Self {
            storage_dir: config_dir.join("todo"),
            storage,
            current_workspace,
            current_workspace_name,
        }
    }

    /// Register current workspace in the workspaces list（保留原实现）
    pub fn register_workspace(&self) -> Result<()> {
        let Some(workspace) = &self.current_workspace else {
            return Ok(());
        };

        let workspaces_file = self.storage_dir.join(WORKSPACES_FILE_NAME);
        let mut data = self.read_workspaces_file(&workspaces_file)?;

        let workspace_path = workspace.to_string_lossy().to_string();
        let now = now_iso();

        // Update or add workspace
        if let Some(existing) = data.workspaces.iter_mut().find(|w| w.path == workspace_path) {
            existing.last_accessed_at = now;
        } else {
            data.workspaces.push(WorkspaceInfo {
                path: workspace_path,
                name: self.current_workspace_name.clone().unwrap_or_default(),
                last_accessed_at: now,
            });
        }

        self.write_workspaces_file(&workspaces_file, &data)?;
        Ok(())
    }

    /// List todos based on scope
    pub fn list_todos(&self, scope: QueryScope) -> Result<Vec<TodoItem>> {
        let all_todos = self.read_all_todos()?;

        let filtered = match scope {
            QueryScope::Workspace => {
                // Filter by current workspace path
                if let Some(workspace) = &self.current_workspace {
                    let workspace_path = workspace.to_string_lossy().to_string();
                    all_todos
                        .into_iter()
                        .filter(|todo| todo.workspace_path.as_deref() == Some(workspace_path.as_str()))
                        .collect()
                } else {
                    // No workspace, return todos without workspace (legacy global)
                    all_todos
                        .into_iter()
                        .filter(|todo| todo.workspace_path.is_none())
                        .collect()
                }
            }
            QueryScope::All => all_todos,
        };

        Ok(filtered)
    }

    /// Get a single todo by ID
    pub fn get_todo(&self, id: &str) -> Result<Option<TodoItem>> {
        let item = self.storage.load("todo", &ContractId(id.to_string()));
        match item {
            Ok(item) => {
                let todo: TodoItem = serde_json::from_value(item.data)
                    .map_err(|e| AppError::ValidationError(format!("反序列化待办失败: {}", e)))?;
                Ok(Some(todo))
            }
            Err(_) => Ok(None),
        }
    }

    /// Create a new todo
    pub fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem> {
        let content = params.content.trim();
        if content.is_empty() {
            return Err(AppError::ValidationError("待办内容不能为空".to_string()));
        }

        let now = now_iso();

        // Determine workspace info
        let (workspace_path, workspace_name) = if let Some(workspace) = &self.current_workspace {
            (
                Some(workspace.to_string_lossy().to_string()),
                self.current_workspace_name.clone(),
            )
        } else {
            (None, None)
        };

        let todo = TodoItem {
            id: Uuid::new_v4().to_string(),
            content: content.to_string(),
            description: sanitize_optional_string(params.description),
            status: TodoStatus::Pending,
            priority: params.priority.unwrap_or_default(),
            tags: sanitize_optional_vec(params.tags),
            related_files: sanitize_optional_vec(params.related_files),
            session_id: sanitize_optional_string(params.session_id),
            workspace_id: sanitize_optional_string(params.workspace_id),
            subtasks: params.subtasks.map(|items| {
                items
                    .into_iter()
                    .filter_map(|subtask| {
                        let title = subtask.title.trim();
                        if title.is_empty() {
                            return None;
                        }
                        Some(TodoSubtask {
                            id: Uuid::new_v4().to_string(),
                            title: title.to_string(),
                            completed: false,
                            created_at: Some(now.clone()),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .filter(|items| !items.is_empty()),
            due_date: sanitize_optional_string(params.due_date),
            reminder_time: None,
            estimated_hours: params.estimated_hours,
            spent_hours: None,
            depends_on: None,
            blockers: None,
            completed_at: None,
            last_progress: None,
            last_error: None,
            created_at: now.clone(),
            updated_at: now,
            workspace_path,
            workspace_name,
        };

        self.insert_item(&todo)?;
        Ok(todo)
    }

    /// Update a todo
    pub fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem> {
        let mut todo = self
            .get_todo(id)?
            .ok_or_else(|| AppError::ValidationError(format!("待办不存在: {}", id)))?;

        if let Some(content) = updates.content {
            let trimmed = content.trim();
            if !trimmed.is_empty() {
                todo.content = trimmed.to_string();
            }
        }

        if let Some(description) = updates.description {
            todo.description = sanitize_string_value(description);
        }

        if let Some(priority) = updates.priority {
            todo.priority = priority;
        }

        if let Some(tags) = updates.tags {
            todo.tags = sanitize_vec_value(tags);
        }

        if let Some(related_files) = updates.related_files {
            todo.related_files = sanitize_vec_value(related_files);
        }

        if let Some(due_date) = updates.due_date {
            todo.due_date = sanitize_string_value(due_date);
        }

        if let Some(estimated_hours) = updates.estimated_hours {
            todo.estimated_hours = Some(estimated_hours);
        }

        if let Some(spent_hours) = updates.spent_hours {
            todo.spent_hours = Some(spent_hours);
        }

        if let Some(reminder_time) = updates.reminder_time {
            todo.reminder_time = sanitize_string_value(reminder_time);
        }

        if let Some(depends_on) = updates.depends_on {
            todo.depends_on = sanitize_vec_value(depends_on);
        }

        if let Some(session_id) = updates.session_id {
            todo.session_id = sanitize_string_value(session_id);
        }

        if let Some(subtasks) = updates.subtasks {
            todo.subtasks = if subtasks.is_empty() {
                None
            } else {
                Some(subtasks)
            };
        }

        if let Some(last_progress) = updates.last_progress {
            todo.last_progress = sanitize_string_value(last_progress);
        }

        if let Some(last_error) = updates.last_error {
            todo.last_error = sanitize_string_value(last_error);
        }

        if let Some(next_status) = updates.status {
            let was_completed = todo.status == TodoStatus::Completed;
            let now_completed = next_status == TodoStatus::Completed;
            todo.status = next_status;
            if now_completed && !was_completed {
                todo.completed_at = Some(now_iso());
            }
            if !now_completed {
                todo.completed_at = None;
            }
        }

        todo.updated_at = now_iso();
        let result = todo.clone();
        self.insert_item(&todo)?;
        Ok(result)
    }

    /// Delete a todo
    pub fn delete_todo(&self, id: &str) -> Result<TodoItem> {
        let todo = self
            .get_todo(id)?
            .ok_or_else(|| AppError::ValidationError(format!("待办不存在: {}", id)))?;
        self.storage
            .delete("todo", &ContractId(id.to_string()))
            .map_err(|e| AppError::ValidationError(format!("删除失败: {}", e)))?;
        Ok(todo)
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let todos = self.read_all_todos()?;
        let mut breakdown = BTreeMap::new();

        for todo in todos {
            let key = todo.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers（SqliteStorage 后端）
    // =========================================================================

    /// 读全部 todo（domain=todo 的 items 全表）
    fn read_all_todos(&self) -> Result<Vec<TodoItem>> {
        let items = self
            .storage
            .query("todo", &ContractQuery { filter: serde_json::json!({}), limit: None })
            .map_err(|e| AppError::ValidationError(format!("读取待办失败: {}", e)))?;

        let mut todos = Vec::with_capacity(items.len());
        for item in items {
            if let Ok(todo) = serde_json::from_value::<TodoItem>(item.data) {
                todos.push(todo);
            }
        }
        Ok(todos)
    }

    /// 写入 / 更新一个 todo 项（INSERT OR REPLACE）
    fn insert_item(&self, todo: &TodoItem) -> Result<()> {
        let data = serde_json::to_value(todo)
            .map_err(|e| AppError::ValidationError(format!("序列化待办失败: {}", e)))?;
        self.storage
            .store(
                "todo",
                &ContractItem {
                    id: ContractId(todo.id.clone()),
                    data,
                },
            )
            .map_err(|e| AppError::ValidationError(format!("写入失败: {}", e)))?;
        Ok(())
    }

    fn read_workspaces_file(&self, path: &std::path::Path) -> Result<WorkspacesFile> {
        if !path.exists() {
            return Ok(WorkspacesFile {
                version: TODO_FILE_VERSION.to_string(),
                workspaces: Vec::new(),
            });
        }

        let content = std::fs::read_to_string(path)?;
        let data: WorkspacesFile = serde_json::from_str(&content).unwrap_or_default();
        Ok(data)
    }

    fn write_workspaces_file(&self, path: &std::path::Path, data: &WorkspacesFile) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(path, format!("{}\n", content))?;
        Ok(())
    }
}

// =========================================================================
// Helper functions（保留原 sanitize / normalize 逻辑）
// =========================================================================

fn sanitize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(sanitize_string_value)
}

fn sanitize_string_value(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn sanitize_optional_vec(values: Option<Vec<String>>) -> Option<Vec<String>> {
    values.and_then(sanitize_vec_value)
}

fn sanitize_vec_value(values: Vec<String>) -> Option<Vec<String>> {
    let values = values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::todo::TodoPriority;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-todo-{}-{}", name, Uuid::new_v4()))
    }

    /// 测试构造：直接注入临时 config_dir 作 data_root（避开全局 data_root()）
    fn make_repo(workspace: Option<PathBuf>) -> UnifiedTodoRepository {
        let config_dir = temp_dir("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let current_workspace_name = workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        UnifiedTodoRepository {
            storage_dir: config_dir.join("todo"),
            storage: Box::new(SqliteStorage::new(&config_dir).unwrap()),
            current_workspace: workspace,
            current_workspace_name,
        }
    }

    #[test]
    fn creates_and_lists_todos() {
        let _tmp = temp_dir("root");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = make_repo(Some(workspace.clone()));
        repo.register_workspace().unwrap();

        // Create todo
        let created = repo
            .create_todo(TodoCreateParams {
                content: "测试待办".to_string(),
                priority: Some(TodoPriority::High),
                ..Default::default()
            })
            .unwrap();

        assert!(created.workspace_path.is_some());
        assert_eq!(created.status, TodoStatus::Pending);

        // List with workspace scope
        let ws_todos = repo.list_todos(QueryScope::Workspace).unwrap();
        assert_eq!(ws_todos.len(), 1);

        // List with all scope
        let all_todos = repo.list_todos(QueryScope::All).unwrap();
        assert_eq!(all_todos.len(), 1);
    }

    #[test]
    fn filters_by_workspace() {
        let workspace_a = temp_dir("ws-a");
        let workspace_b = temp_dir("ws-b");
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();

        // Create todo in workspace A
        let repo_a = make_repo(Some(workspace_a.clone()));
        repo_a.create_todo(TodoCreateParams {
            content: "Workspace A todo".to_string(),
            ..Default::default()
        })
        .unwrap();

        // Create todo in workspace B
        let repo_b = make_repo(Some(workspace_b.clone()));
        repo_b.create_todo(TodoCreateParams {
            content: "Workspace B todo".to_string(),
            ..Default::default()
        })
        .unwrap();

        // Both todos should be in the same file
        let repo_all = make_repo(None);
        let all = repo_all.list_todos(QueryScope::All).unwrap();
        assert_eq!(all.len(), 2);

        // Filter by workspace A
        let a_todos = repo_a.list_todos(QueryScope::Workspace).unwrap();
        assert_eq!(a_todos.len(), 1);
        assert_eq!(a_todos[0].content, "Workspace A todo");
    }

    #[test]
    fn updates_and_deletes() {
        let _tmp = temp_dir("update");
        let repo = make_repo(None);

        let created = repo
            .create_todo(TodoCreateParams {
                content: "原始内容".to_string(),
                ..Default::default()
            })
            .unwrap();

        let updated = repo
            .update_todo(
                &created.id,
                TodoUpdateParams {
                    content: Some("更新内容".to_string()),
                    status: Some(TodoStatus::Completed),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(updated.content, "更新内容");
        assert_eq!(updated.status, TodoStatus::Completed);
        assert!(updated.completed_at.is_some());

        let deleted = repo.delete_todo(&created.id).unwrap();
        assert_eq!(deleted.id, created.id);

        let all = repo.list_todos(QueryScope::All).unwrap();
        assert!(all.is_empty());
    }
}