//! Task Storage Abstraction
//!
//! This module provides a storage abstraction layer for scheduled tasks.
//! It allows for different storage backends (local files, database, cloud, etc.)
//! to be plugged in without changing the business logic.

use crate::error::Result;
use crate::models::scheduler::{
    CreateTaskParams, CreateTemplateParams, PromptTemplate, ScheduledTask, TaskCategory, TaskMode,
    TaskStatus, TriggerType,
};
use std::collections::BTreeMap;
use std::collections::HashMap;

/// Workspace registration info
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceInfo {
    pub path: String,
    pub name: String,
    pub last_accessed_at: String,
}

/// Parameters for updating a scheduled task
#[derive(Debug, Clone, Default)]
pub struct TaskUpdateParams {
    pub name: Option<String>,
    pub enabled: Option<bool>,
    pub trigger_type: Option<TriggerType>,
    pub trigger_value: Option<String>,
    pub engine_id: Option<String>,
    pub prompt: Option<String>,
    pub work_dir: Option<String>,
    pub description: Option<String>,
    pub template_id: Option<String>,
    pub next_run_at: Option<i64>,
    pub last_run_at: Option<i64>,
    pub mode: Option<TaskMode>,
    pub category: Option<TaskCategory>,
    pub task_path: Option<String>,
    pub mission: Option<String>,
    pub template_params: Option<HashMap<String, String>>,
    pub max_runs: Option<u32>,
    pub current_runs: Option<u32>,
    pub max_retries: Option<u32>,
    pub retry_count: Option<u32>,
    pub retry_interval: Option<String>,
    pub timeout_minutes: Option<u32>,
    pub group: Option<String>,
    pub notify_on_complete: Option<bool>,
}

/// Task Storage Trait
///
/// Abstract interface for task storage operations.
/// Implementations can use different backends (local files, database, cloud, etc.)
pub trait TaskStorage: Send + Sync {
    // =========================================================================
    // Task Operations
    // =========================================================================

    /// List all tasks, optionally filtered by workspace
    fn list_tasks(&self, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>>;

    /// Get a single task by ID
    fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>>;

    /// Create a new task
    fn create_task(&self, params: CreateTaskParams, workspace_path: Option<String>, workspace_name: Option<String>) -> Result<ScheduledTask>;

    /// Update a task
    fn update_task(&self, id: &str, updates: TaskUpdateParams) -> Result<ScheduledTask>;

    /// Delete a task
    fn delete_task(&self, id: &str) -> Result<ScheduledTask>;

    /// Update task execution status
    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<ScheduledTask>;

    /// Toggle task enabled state
    fn toggle_task(&self, id: &str, enabled: bool) -> Result<ScheduledTask>;

    /// Get workspace breakdown summary
    fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>>;

    /// List tasks by category
    fn list_tasks_by_category(&self, category: TaskCategory, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>>;

    /// List tasks by mode
    fn list_tasks_by_mode(&self, mode: TaskMode, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>>;

    /// List tasks by group
    fn list_tasks_by_group(&self, group: &str, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>>;

    // =========================================================================
    // Template Operations
    // =========================================================================

    /// List all templates
    fn list_templates(&self) -> Result<Vec<PromptTemplate>>;

    /// Get a single template by ID
    fn get_template(&self, id: &str) -> Result<Option<PromptTemplate>>;

    /// Create a new template
    fn create_template(&self, params: CreateTemplateParams) -> Result<PromptTemplate>;

    /// Update a template
    fn update_template(&self, template: PromptTemplate) -> Result<PromptTemplate>;

    /// Delete a template
    fn delete_template(&self, id: &str) -> Result<()>;

    /// Toggle template enabled state
    fn toggle_template(&self, id: &str, enabled: bool) -> Result<PromptTemplate>;

    /// Build prompt with template
    fn build_prompt_with_template(&self, template_id: &str, task_name: &str, user_prompt: &str) -> Result<String>;

    // =========================================================================
    // Workspace Operations
    // =========================================================================

    /// Register a workspace
    fn register_workspace(&self, path: &str, name: &str) -> Result<()>;

    /// List all registered workspaces
    fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>>;

    /// Unregister a workspace
    fn unregister_workspace(&self, path: &str) -> Result<()>;
}

/// Storage backend type enumeration
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageBackend {
    /// Local file system storage
    LocalFile,
    // Future backends can be added here:
    // /// SQLite database storage
    // SQLite,
    // /// PostgreSQL database storage
    // PostgreSQL,
    // /// Cloud storage (S3, etc.)
    // Cloud,
}
