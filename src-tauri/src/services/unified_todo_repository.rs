//! Unified Todo Repository
//!
//! Single storage for all todos in config_dir/todo/todos.json.
//! Workspace filtering via workspacePath field.

use crate::error::{AppError, Result};
use crate::models::todo::{
    QueryScope, TodoCreateParams, TodoFileData, TodoItem, TodoPriority, TodoStatus,
    TodoSubtask, TodoUpdateParams,
};
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

const TODO_FILE_NAME: &str = "todos.json";
const TODO_FILE_VERSION: &str = "1.0.0";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing todos in a single global storage
pub struct UnifiedTodoRepository {
    /// Global storage directory (config_dir/todo)
    storage_dir: PathBuf,
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
    /// * `config_dir` - Application config directory for storage
    /// * `current_workspace` - Current workspace path (optional, for filtering)
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        Self {
            storage_dir: config_dir.join("todo"),
            current_workspace,
            current_workspace_name,
        }
    }

    /// Register current workspace in the workspaces list
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
        let all_todos = self.read_file_data()?.todos;

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
        let data = self.read_file_data()?;
        Ok(data.todos.into_iter().find(|todo| todo.id == id))
    }

    /// Create a new todo
    pub fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem> {
        let content = params.content.trim();
        if content.is_empty() {
            return Err(AppError::ValidationError("待办内容不能为空".to_string()));
        }

        let mut data = self.read_file_data()?;
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

        data.todos.push(todo.clone());
        self.write_file_data(&mut data)?;
        Ok(todo)
    }

    /// Update a todo
    pub fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem> {
        let mut data = self.read_file_data()?;
        let todo = data
            .todos
            .iter_mut()
            .find(|todo| todo.id == id)
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
        self.write_file_data(&mut data)?;
        Ok(result)
    }

    /// Delete a todo
    pub fn delete_todo(&self, id: &str) -> Result<TodoItem> {
        let mut data = self.read_file_data()?;
        let index = data
            .todos
            .iter()
            .position(|todo| todo.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("待办不存在: {}", id)))?;
        let removed = data.todos.remove(index);
        self.write_file_data(&mut data)?;
        Ok(removed)
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let todos = self.read_file_data()?.todos;
        let mut breakdown = BTreeMap::new();

        for todo in todos {
            let key = todo.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn read_file_data(&self) -> Result<TodoFileData> {
        let file_path = self.storage_dir.join(TODO_FILE_NAME);

        if !file_path.exists() {
            let mut empty = create_empty_todo_file_data();
            self.write_file_data(&mut empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        Ok(normalize_file_data(raw_json))
    }

    fn write_file_data(&self, data: &mut TodoFileData) -> Result<()> {
        let file_path = self.storage_dir.join(TODO_FILE_NAME);

        data.version = TODO_FILE_VERSION.to_string();
        data.updated_at = now_iso();

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
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
// Helper functions
// =========================================================================

fn create_empty_todo_file_data() -> TodoFileData {
    TodoFileData {
        version: TODO_FILE_VERSION.to_string(),
        updated_at: now_iso(),
        todos: Vec::new(),
    }
}

fn normalize_file_data(raw_json: serde_json::Value) -> TodoFileData {
    let version = raw_json
        .get("version")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(TODO_FILE_VERSION)
        .to_string();

    let updated_at = raw_json
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(now_iso);

    let todos = raw_json
        .get("todos")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(normalize_todo_item).collect::<Vec<_>>())
        .unwrap_or_default();

    TodoFileData {
        version,
        updated_at,
        todos,
    }
}

fn normalize_todo_item(value: &serde_json::Value) -> Option<TodoItem> {
    let object = value.as_object()?;
    let content = object.get("content")?.as_str()?.trim().to_string();
    if content.is_empty() {
        return None;
    }

    let created_at = object
        .get("createdAt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(now_iso);

    let updated_at = object
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
        .unwrap_or_else(|| created_at.clone());

    Some(TodoItem {
        id: object
            .get("id")
            .and_then(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(|value| value.to_string())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        content,
        description: optional_string_field(object.get("description")),
        status: parse_status(object.get("status")).unwrap_or_default(),
        priority: parse_priority(object.get("priority")).unwrap_or_default(),
        tags: optional_string_array(object.get("tags")),
        related_files: optional_string_array(object.get("relatedFiles")),
        session_id: optional_string_field(object.get("sessionId")),
        workspace_id: optional_string_field(object.get("workspaceId")),
        subtasks: normalize_subtasks(object.get("subtasks")),
        due_date: optional_string_field(object.get("dueDate")),
        reminder_time: optional_string_field(object.get("reminderTime")),
        estimated_hours: object.get("estimatedHours").and_then(|value| value.as_f64()),
        spent_hours: object.get("spentHours").and_then(|value| value.as_f64()),
        depends_on: optional_string_array(object.get("dependsOn")),
        blockers: optional_string_array(object.get("blockers")),
        completed_at: optional_string_field(object.get("completedAt")),
        last_progress: optional_string_field(object.get("lastProgress")),
        last_error: optional_string_field(object.get("lastError")),
        created_at,
        updated_at,
        workspace_path: optional_string_field(object.get("workspacePath")),
        workspace_name: optional_string_field(object.get("workspaceName")),
    })
}

fn normalize_subtasks(value: Option<&serde_json::Value>) -> Option<Vec<TodoSubtask>> {
    let subtasks = value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let object = item.as_object()?;
                    let title = object.get("title")?.as_str()?.trim().to_string();
                    if title.is_empty() {
                        return None;
                    }

                    Some(TodoSubtask {
                        id: object
                            .get("id")
                            .and_then(|value| value.as_str())
                            .filter(|value| !value.trim().is_empty())
                            .map(|value| value.to_string())
                            .unwrap_or_else(|| Uuid::new_v4().to_string()),
                        title,
                        completed: object.get("completed").and_then(|value| value.as_bool()).unwrap_or(false),
                        created_at: optional_string_field(object.get("createdAt")),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if subtasks.is_empty() {
        None
    } else {
        Some(subtasks)
    }
}

fn parse_status(value: Option<&serde_json::Value>) -> Option<TodoStatus> {
    match value.and_then(|value| value.as_str()) {
        Some("pending") => Some(TodoStatus::Pending),
        Some("in_progress") => Some(TodoStatus::InProgress),
        Some("completed") => Some(TodoStatus::Completed),
        Some("cancelled") => Some(TodoStatus::Cancelled),
        _ => None,
    }
}

fn parse_priority(value: Option<&serde_json::Value>) -> Option<TodoPriority> {
    match value.and_then(|value| value.as_str()) {
        Some("low") => Some(TodoPriority::Low),
        Some("normal") => Some(TodoPriority::Normal),
        Some("high") => Some(TodoPriority::High),
        Some("urgent") => Some(TodoPriority::Urgent),
        _ => None,
    }
}

fn optional_string_field(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string())
}

fn optional_string_array(value: Option<&serde_json::Value>) -> Option<Vec<String>> {
    let values = value
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(|item| item.to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    if values.is_empty() {
        None
    } else {
        Some(values)
    }
}

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

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-todo-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn creates_and_lists_todos() {
        let config_dir = temp_dir("config");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = UnifiedTodoRepository::new(config_dir.clone(), Some(workspace.clone()));
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

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn filters_by_workspace() {
        let config_dir = temp_dir("filter");
        let workspace_a = temp_dir("ws-a");
        let workspace_b = temp_dir("ws-b");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace_a).unwrap();
        std::fs::create_dir_all(&workspace_b).unwrap();

        // Create todo in workspace A
        let repo_a = UnifiedTodoRepository::new(config_dir.clone(), Some(workspace_a.clone()));
        repo_a.create_todo(TodoCreateParams {
            content: "Workspace A todo".to_string(),
            ..Default::default()
        })
        .unwrap();

        // Create todo in workspace B
        let repo_b = UnifiedTodoRepository::new(config_dir.clone(), Some(workspace_b.clone()));
        repo_b.create_todo(TodoCreateParams {
            content: "Workspace B todo".to_string(),
            ..Default::default()
        })
        .unwrap();

        // Both todos should be in the same file
        let repo_all = UnifiedTodoRepository::new(config_dir.clone(), None);
        let all = repo_all.list_todos(QueryScope::All).unwrap();
        assert_eq!(all.len(), 2);

        // Filter by workspace A
        let a_todos = repo_a.list_todos(QueryScope::Workspace).unwrap();
        assert_eq!(a_todos.len(), 1);
        assert_eq!(a_todos[0].content, "Workspace A todo");

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace_a);
        let _ = std::fs::remove_dir_all(&workspace_b);
    }

    #[test]
    fn updates_and_deletes() {
        let config_dir = temp_dir("update");
        std::fs::create_dir_all(&config_dir).unwrap();

        let repo = UnifiedTodoRepository::new(config_dir.clone(), None);

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

        let _ = std::fs::remove_dir_all(&config_dir);
    }
}
