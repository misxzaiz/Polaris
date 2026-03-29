//! Todo commands for unified todo management
//!
//! Provides Tauri commands for frontend to interact with the unified todo repository.

use std::collections::BTreeMap;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::todo::{QueryScope, TodoCreateParams, TodoItem, TodoPriority, TodoStatus, TodoUpdateParams};
use crate::services::unified_todo_repository::UnifiedTodoRepository;

// ============================================================================
// List todos
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListTodosParams {
    /// Query scope: "workspace" or "all"
    #[serde(default)]
    pub scope: String,
    /// Workspace path (optional)
    pub workspace_path: Option<String>,
    /// Status filter (optional)
    pub status: Option<String>,
    /// Priority filter (optional)
    pub priority: Option<String>,
    /// Limit (optional)
    pub limit: Option<u32>,
}

#[tauri::command]
pub async fn list_todos(
    params: ListTodosParams,
    app: AppHandle,
) -> Result<Vec<TodoItem>> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    // Register workspace if provided
    repository.register_workspace().ok();

    let scope = match params.scope.as_str() {
        "all" => QueryScope::All,
        _ => QueryScope::Workspace,
    };

    let mut todos = repository.list_todos(scope)?;

    // Apply filters
    if let Some(status) = params.status {
        if let Ok(status) = parse_status(&status) {
            todos.retain(|t| t.status == status);
        }
    }

    if let Some(priority) = params.priority {
        if let Ok(priority) = parse_priority(&priority) {
            todos.retain(|t| t.priority == priority);
        }
    }

    if let Some(limit) = params.limit {
        todos.truncate(limit as usize);
    }

    Ok(todos)
}

// ============================================================================
// Create todo
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTodoParams {
    /// Todo content
    pub content: String,
    /// Description
    pub description: Option<String>,
    /// Priority
    #[serde(default)]
    pub priority: Option<String>,
    /// Tags
    pub tags: Option<Vec<String>>,
    /// Related files
    pub related_files: Option<Vec<String>>,
    /// Due date
    pub due_date: Option<String>,
    /// Estimated hours
    pub estimated_hours: Option<f64>,
    /// Subtasks
    pub subtasks: Option<Vec<TodoCreateSubtask>>,
    /// Is global todo
    #[serde(default)]
    pub is_global: bool,
    /// Workspace path (required if is_global is false)
    pub workspace_path: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct TodoCreateSubtask {
    pub title: String,
}

#[tauri::command]
pub async fn create_todo(
    params: CreateTodoParams,
    app: AppHandle,
) -> Result<TodoItem> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir.clone(), workspace_path.clone());

    // Register workspace if provided
    if workspace_path.is_some() {
        repository.register_workspace().ok();
    }

    let priority = params.priority
        .and_then(|p| parse_priority(&p).ok())
        .unwrap_or_default();

    let create_params = TodoCreateParams {
        content: params.content,
        description: params.description,
        priority: Some(priority),
        tags: params.tags,
        related_files: params.related_files,
        due_date: params.due_date,
        estimated_hours: params.estimated_hours,
        is_global: params.is_global,
        subtasks: params.subtasks.map(|items| {
            items.into_iter().map(|s| crate::models::todo::TodoCreateSubtask {
                title: s.title,
            }).collect()
        }),
        ..Default::default()
    };

    repository.create_todo(create_params)
}

// ============================================================================
// Update todo
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTodoParams {
    /// Todo ID
    pub id: String,
    /// Content
    pub content: Option<String>,
    /// Description
    pub description: Option<String>,
    /// Status
    pub status: Option<String>,
    /// Priority
    pub priority: Option<String>,
    /// Tags
    pub tags: Option<Vec<String>>,
    /// Related files
    pub related_files: Option<Vec<String>>,
    /// Due date
    pub due_date: Option<String>,
    /// Estimated hours
    pub estimated_hours: Option<f64>,
    /// Spent hours
    pub spent_hours: Option<f64>,
    /// Last progress
    pub last_progress: Option<String>,
    /// Last error
    pub last_error: Option<String>,
    /// Workspace path (for locating the todo)
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn update_todo(
    params: UpdateTodoParams,
    app: AppHandle,
) -> Result<TodoItem> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    let status = params.status.and_then(|s| parse_status(&s).ok());
    let priority = params.priority.and_then(|p| parse_priority(&p).ok());

    let update_params = TodoUpdateParams {
        content: params.content,
        description: params.description,
        status,
        priority,
        tags: params.tags,
        related_files: params.related_files,
        due_date: params.due_date,
        estimated_hours: params.estimated_hours,
        spent_hours: params.spent_hours,
        last_progress: params.last_progress,
        last_error: params.last_error,
        ..Default::default()
    };

    repository.update_todo(&params.id, update_params)
}

// ============================================================================
// Delete todo
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteTodoParams {
    /// Todo ID
    pub id: String,
    /// Workspace path (for locating the todo)
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn delete_todo(
    params: DeleteTodoParams,
    app: AppHandle,
) -> Result<TodoItem> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    repository.delete_todo(&params.id)
}

// ============================================================================
// Start / Complete todo
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartTodoParams {
    pub id: String,
    pub last_progress: Option<String>,
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn start_todo(
    params: StartTodoParams,
    app: AppHandle,
) -> Result<TodoItem> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    repository.update_todo(&params.id, TodoUpdateParams {
        status: Some(TodoStatus::InProgress),
        last_progress: params.last_progress,
        ..Default::default()
    })
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompleteTodoParams {
    pub id: String,
    pub last_progress: Option<String>,
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn complete_todo(
    params: CompleteTodoParams,
    app: AppHandle,
) -> Result<TodoItem> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    repository.update_todo(&params.id, TodoUpdateParams {
        status: Some(TodoStatus::Completed),
        last_progress: params.last_progress,
        ..Default::default()
    })
}

// ============================================================================
// Get workspace breakdown
// ============================================================================

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetBreakdownParams {
    pub workspace_path: Option<String>,
}

#[tauri::command]
pub async fn get_todo_workspace_breakdown(
    params: GetBreakdownParams,
    app: AppHandle,
) -> Result<BTreeMap<String, usize>> {
    let config_dir = app.path().app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;

    let workspace_path = params.workspace_path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);

    let repository = UnifiedTodoRepository::new(config_dir, workspace_path);

    repository.get_workspace_breakdown()
}

// ============================================================================
// Helpers
// ============================================================================

fn parse_status(value: &str) -> Result<TodoStatus> {
    match value {
        "pending" => Ok(TodoStatus::Pending),
        "in_progress" => Ok(TodoStatus::InProgress),
        "completed" => Ok(TodoStatus::Completed),
        "cancelled" => Ok(TodoStatus::Cancelled),
        _ => Err(crate::error::AppError::ValidationError(format!("无效状态: {}", value))),
    }
}

fn parse_priority(value: &str) -> Result<TodoPriority> {
    match value {
        "low" => Ok(TodoPriority::Low),
        "normal" => Ok(TodoPriority::Normal),
        "high" => Ok(TodoPriority::High),
        "urgent" => Ok(TodoPriority::Urgent),
        _ => Err(crate::error::AppError::ValidationError(format!("无效优先级: {}", value))),
    }
}
