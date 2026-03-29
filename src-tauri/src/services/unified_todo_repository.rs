//! Unified Todo Repository
//!
//! Supports both global todos (stored in config_dir) and workspace-scoped todos.
//! Provides unified query interface with scope parameter.

use crate::error::{AppError, Result};
use crate::models::todo::{
    QueryScope, TodoCreateParams, TodoFileData, TodoItem, TodoPriority, TodoStatus,
    TodoSubtask, TodoUpdateParams,
};
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const TODO_FILE_NAME: &str = "todos.json";
const TODO_FILE_VERSION: &str = "1.0.0";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing todos across global and workspace scopes
pub struct UnifiedTodoRepository {
    /// Global storage directory (config_dir/todo)
    global_dir: PathBuf,
    /// Current workspace path (optional)
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
    /// * `config_dir` - Application config directory for global storage
    /// * `current_workspace` - Current workspace path (optional)
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        Self {
            global_dir: config_dir.join("todo"),
            current_workspace,
            current_workspace_name,
        }
    }

    /// Register current workspace in the workspaces list
    pub fn register_workspace(&self) -> Result<()> {
        let Some(workspace) = &self.current_workspace else {
            return Ok(());
        };

        let workspaces_file = self.global_dir.join(WORKSPACES_FILE_NAME);
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
        match scope {
            QueryScope::Workspace => {
                if let Some(workspace) = &self.current_workspace {
                    let repo = WorkspaceTodoRepository::new(workspace);
                    repo.list_todos()
                } else {
                    // No workspace, return empty
                    Ok(Vec::new())
                }
            }
            QueryScope::All => {
                let mut all_todos = Vec::new();

                // 1. Global todos
                let global_repo = GlobalTodoRepository::new(&self.global_dir);
                let global_todos = global_repo.list_todos()?;
                all_todos.extend(global_todos);

                // 2. Todos from all registered workspaces
                let workspaces = self.get_registered_workspaces()?;
                for workspace_info in workspaces {
                    let workspace_path = PathBuf::from(&workspace_info.path);
                    if workspace_path.exists() {
                        let repo = WorkspaceTodoRepository::new(&workspace_path);
                        if let Ok(todos) = repo.list_todos() {
                            all_todos.extend(todos);
                        }
                    }
                }

                // Sort by updated_at descending
                all_todos.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

                Ok(all_todos)
            }
        }
    }

    /// Get a single todo by ID (searches both global and workspace)
    pub fn get_todo(&self, id: &str) -> Result<Option<TodoItem>> {
        // First check current workspace
        if let Some(workspace) = &self.current_workspace {
            let repo = WorkspaceTodoRepository::new(workspace);
            if let Some(todo) = repo.get_todo(id)? {
                return Ok(Some(todo));
            }
        }

        // Then check global
        let global_repo = GlobalTodoRepository::new(&self.global_dir);
        if let Some(todo) = global_repo.get_todo(id)? {
            return Ok(Some(todo));
        }

        // Finally check all registered workspaces
        let workspaces = self.get_registered_workspaces()?;
        for workspace_info in workspaces {
            let workspace_path = PathBuf::from(&workspace_info.path);
            if workspace_path.exists() {
                let repo = WorkspaceTodoRepository::new(&workspace_path);
                if let Some(todo) = repo.get_todo(id)? {
                    return Ok(Some(todo));
                }
            }
        }

        Ok(None)
    }

    /// Create a new todo
    pub fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem> {
        if params.is_global {
            let global_repo = GlobalTodoRepository::new(&self.global_dir);
            global_repo.create_todo(params)
        } else if let Some(workspace) = &self.current_workspace {
            let repo = WorkspaceTodoRepository::new(workspace);
            repo.create_todo_with_workspace(params, workspace, self.current_workspace_name.as_deref())
        } else {
            Err(AppError::ValidationError("没有当前工作区，无法创建工作区待办".to_string()))
        }
    }

    /// Update a todo (finds it by ID across all scopes)
    pub fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem> {
        // Find which repository owns this todo
        let location = self.find_todo_location(id)?;

        match location {
            TodoLocation::Global => {
                let global_repo = GlobalTodoRepository::new(&self.global_dir);
                global_repo.update_todo(id, updates)
            }
            TodoLocation::Workspace(path) => {
                let repo = WorkspaceTodoRepository::new(&path);
                repo.update_todo(id, updates)
            }
        }
    }

    /// Delete a todo (finds it by ID across all scopes)
    pub fn delete_todo(&self, id: &str) -> Result<TodoItem> {
        // Find which repository owns this todo
        let location = self.find_todo_location(id)?;

        match location {
            TodoLocation::Global => {
                let global_repo = GlobalTodoRepository::new(&self.global_dir);
                global_repo.delete_todo(id)
            }
            TodoLocation::Workspace(path) => {
                let repo = WorkspaceTodoRepository::new(&path);
                repo.delete_todo(id)
            }
        }
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let mut breakdown = BTreeMap::new();

        // Global todos
        let global_repo = GlobalTodoRepository::new(&self.global_dir);
        let global_count = global_repo.list_todos()?.len();
        if global_count > 0 {
            breakdown.insert("全局".to_string(), global_count);
        }

        // Workspace todos
        let workspaces = self.get_registered_workspaces()?;
        for workspace_info in workspaces {
            let workspace_path = PathBuf::from(&workspace_info.path);
            if workspace_path.exists() {
                let repo = WorkspaceTodoRepository::new(&workspace_path);
                if let Ok(todos) = repo.list_todos() {
                    if !todos.is_empty() {
                        breakdown.insert(workspace_info.name.clone(), todos.len());
                    }
                }
            }
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn find_todo_location(&self, id: &str) -> Result<TodoLocation> {
        // Check current workspace first
        if let Some(workspace) = &self.current_workspace {
            let repo = WorkspaceTodoRepository::new(workspace);
            if repo.get_todo(id)?.is_some() {
                return Ok(TodoLocation::Workspace(workspace.clone()));
            }
        }

        // Check global
        let global_repo = GlobalTodoRepository::new(&self.global_dir);
        if global_repo.get_todo(id)?.is_some() {
            return Ok(TodoLocation::Global);
        }

        // Check other workspaces
        let workspaces = self.get_registered_workspaces()?;
        for workspace_info in workspaces {
            let workspace_path = PathBuf::from(&workspace_info.path);
            if workspace_path.exists() {
                let repo = WorkspaceTodoRepository::new(&workspace_path);
                if repo.get_todo(id)?.is_some() {
                    return Ok(TodoLocation::Workspace(workspace_path));
                }
            }
        }

        Err(AppError::ValidationError(format!("待办不存在: {}", id)))
    }

    fn get_registered_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        let workspaces_file = self.global_dir.join(WORKSPACES_FILE_NAME);
        let data = self.read_workspaces_file(&workspaces_file)?;
        Ok(data.workspaces)
    }

    fn read_workspaces_file(&self, path: &Path) -> Result<WorkspacesFile> {
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

    fn write_workspaces_file(&self, path: &Path, data: &WorkspacesFile) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(path, format!("{}\n", content))?;
        Ok(())
    }
}

/// Where a todo is stored
enum TodoLocation {
    Global,
    Workspace(PathBuf),
}

// =========================================================================
// Workspace-scoped Todo Repository (existing logic refactored)
// =========================================================================

struct WorkspaceTodoRepository {
    file_path: PathBuf,
}

impl WorkspaceTodoRepository {
    fn new(workspace_path: &Path) -> Self {
        Self {
            file_path: workspace_path.join(".polaris").join(TODO_FILE_NAME),
        }
    }

    fn list_todos(&self) -> Result<Vec<TodoItem>> {
        Ok(self.read_file_data()?.todos)
    }

    fn get_todo(&self, id: &str) -> Result<Option<TodoItem>> {
        let data = self.read_file_data()?;
        Ok(data.todos.into_iter().find(|todo| todo.id == id))
    }

    fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem> {
        self.create_todo_with_workspace(params, Path::new(""), None)
    }

    fn create_todo_with_workspace(
        &self,
        params: TodoCreateParams,
        workspace_path: &Path,
        workspace_name: Option<&str>,
    ) -> Result<TodoItem> {
        let content = params.content.trim();
        if content.is_empty() {
            return Err(AppError::ValidationError("待办内容不能为空".to_string()));
        }

        let mut data = self.read_file_data()?;
        let now = now_iso();
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
            workspace_path: if workspace_path.to_string_lossy().is_empty() {
                None
            } else {
                Some(workspace_path.to_string_lossy().to_string())
            },
            workspace_name: workspace_name.map(|s| s.to_string()),
        };

        data.todos.push(todo.clone());
        self.write_file_data(&mut data)?;
        Ok(todo)
    }

    fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem> {
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

    fn delete_todo(&self, id: &str) -> Result<TodoItem> {
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

    fn read_file_data(&self) -> Result<TodoFileData> {
        if !self.file_path.exists() {
            let mut empty = create_empty_todo_file_data();
            self.write_file_data(&mut empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&self.file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        let normalized = normalize_file_data(raw_json);
        self.persist_if_changed(&normalized)?;
        Ok(normalized)
    }

    fn write_file_data(&self, data: &mut TodoFileData) -> Result<()> {
        data.version = TODO_FILE_VERSION.to_string();
        data.updated_at = now_iso();

        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&self.file_path, format!("{}\n", content))?;
        Ok(())
    }

    fn persist_if_changed(&self, normalized: &TodoFileData) -> Result<()> {
        let serialized = format!("{}\n", serde_json::to_string_pretty(normalized)?);
        let current = std::fs::read_to_string(&self.file_path).unwrap_or_default();
        if current != serialized {
            if let Some(parent) = self.file_path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(&self.file_path, serialized)?;
        }
        Ok(())
    }
}

// =========================================================================
// Global Todo Repository
// =========================================================================

struct GlobalTodoRepository {
    file_path: PathBuf,
}

impl GlobalTodoRepository {
    fn new(global_dir: &Path) -> Self {
        Self {
            file_path: global_dir.join(TODO_FILE_NAME),
        }
    }

    fn list_todos(&self) -> Result<Vec<TodoItem>> {
        Ok(self.read_file_data()?.todos)
    }

    fn get_todo(&self, id: &str) -> Result<Option<TodoItem>> {
        let data = self.read_file_data()?;
        Ok(data.todos.into_iter().find(|todo| todo.id == id))
    }

    fn create_todo(&self, params: TodoCreateParams) -> Result<TodoItem> {
        let content = params.content.trim();
        if content.is_empty() {
            return Err(AppError::ValidationError("待办内容不能为空".to_string()));
        }

        let mut data = self.read_file_data()?;
        let now = now_iso();
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
            workspace_path: None,  // Global todo
            workspace_name: Some("全局".to_string()),
        };

        data.todos.push(todo.clone());
        self.write_file_data(&mut data)?;
        Ok(todo)
    }

    fn update_todo(&self, id: &str, updates: TodoUpdateParams) -> Result<TodoItem> {
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

    fn delete_todo(&self, id: &str) -> Result<TodoItem> {
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

    fn read_file_data(&self) -> Result<TodoFileData> {
        if !self.file_path.exists() {
            let mut empty = create_empty_todo_file_data();
            self.write_file_data(&mut empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&self.file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        Ok(normalize_file_data(raw_json))
    }

    fn write_file_data(&self, data: &mut TodoFileData) -> Result<()> {
        data.version = TODO_FILE_VERSION.to_string();
        data.updated_at = now_iso();

        if let Some(parent) = self.file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&self.file_path, format!("{}\n", content))?;
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
        std::env::temp_dir().join(format!("polaris-unified-todo-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn creates_global_and_workspace_todos() {
        let config_dir = temp_dir("config");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = UnifiedTodoRepository::new(config_dir.clone(), Some(workspace.clone()));

        // Register workspace
        repo.register_workspace().unwrap();

        // Create workspace todo
        let ws_todo = repo
            .create_todo(TodoCreateParams {
                content: "工作区待办".to_string(),
                is_global: false,
                ..Default::default()
            })
            .unwrap();
        assert!(ws_todo.workspace_path.is_some());

        // Create global todo
        let global_todo = repo
            .create_todo(TodoCreateParams {
                content: "全局待办".to_string(),
                is_global: true,
                ..Default::default()
            })
            .unwrap();
        assert!(global_todo.workspace_path.is_none());
        assert_eq!(global_todo.workspace_name, Some("全局".to_string()));

        // List workspace scope
        let ws_todos = repo.list_todos(QueryScope::Workspace).unwrap();
        assert_eq!(ws_todos.len(), 1);

        // List all scope
        let all_todos = repo.list_todos(QueryScope::All).unwrap();
        assert_eq!(all_todos.len(), 2);

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn updates_and_deletes_across_scopes() {
        let config_dir = temp_dir("update");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = UnifiedTodoRepository::new(config_dir.clone(), Some(workspace.clone()));
        repo.register_workspace().unwrap();

        // Create global todo
        let created = repo
            .create_todo(TodoCreateParams {
                content: "全局待办".to_string(),
                is_global: true,
                ..Default::default()
            })
            .unwrap();

        // Update via unified repo
        let updated = repo
            .update_todo(
                &created.id,
                TodoUpdateParams {
                    content: Some("已更新".to_string()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.content, "已更新");

        // Delete via unified repo
        let deleted = repo.delete_todo(&created.id).unwrap();
        assert_eq!(deleted.id, created.id);

        let all = repo.list_todos(QueryScope::All).unwrap();
        assert!(all.is_empty());

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }
}
