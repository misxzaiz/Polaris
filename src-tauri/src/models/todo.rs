use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoPriority {
    Low,
    Normal,
    High,
    Urgent,
}

impl Default for TodoPriority {
    fn default() -> Self {
        Self::Normal
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Completed,
    Cancelled,
}

impl Default for TodoStatus {
    fn default() -> Self {
        Self::Pending
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodoSubtask {
    pub id: String,
    pub title: String,
    pub completed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    pub id: String,
    pub content: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub status: TodoStatus,
    pub priority: TodoPriority,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub related_files: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtasks: Option<Vec<TodoSubtask>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reminder_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_hours: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spent_hours: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depends_on: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blockers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_progress: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// 所属工作区路径（None 表示全局待办）
    #[serde(default)]
    pub workspace_path: Option<String>,
    /// 所属工作区名称（用于显示）
    #[serde(default)]
    pub workspace_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TodoFileData {
    pub version: String,
    pub updated_at: String,
    pub todos: Vec<TodoItem>,
}

/// 查询范围
#[derive(Debug, Clone, Copy, serde::Serialize, serde::Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QueryScope {
    /// 仅当前工作区
    #[default]
    Workspace,
    /// 全局 + 所有已注册工作区
    All,
}

#[derive(Debug, Clone, Default)]
pub struct TodoCreateSubtask {
    pub title: String,
}

#[derive(Debug, Clone, Default)]
pub struct TodoCreateParams {
    pub content: String,
    pub description: Option<String>,
    pub priority: Option<TodoPriority>,
    pub tags: Option<Vec<String>>,
    pub related_files: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub workspace_id: Option<String>,
    pub subtasks: Option<Vec<TodoCreateSubtask>>,
    pub due_date: Option<String>,
    pub estimated_hours: Option<f64>,
    /// 是否创建为全局待办（默认 false，即工作区待办）
    pub is_global: bool,
}

#[derive(Debug, Clone, Default)]
pub struct TodoUpdateParams {
    pub content: Option<String>,
    pub description: Option<String>,
    pub status: Option<TodoStatus>,
    pub priority: Option<TodoPriority>,
    pub tags: Option<Vec<String>>,
    pub related_files: Option<Vec<String>>,
    pub due_date: Option<String>,
    pub estimated_hours: Option<f64>,
    pub spent_hours: Option<f64>,
    pub reminder_time: Option<String>,
    pub depends_on: Option<Vec<String>>,
    pub session_id: Option<String>,
    pub subtasks: Option<Vec<TodoSubtask>>,
    pub last_progress: Option<String>,
    pub last_error: Option<String>,
}
