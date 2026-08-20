//! Unified Scheduler Repository
//!
//! Single storage for all scheduled tasks in config_dir/scheduler/tasks.json.
//! Workspace filtering via workspacePath field.
//!
//! This module now delegates to TaskStorage trait implementations for
//! actual storage operations, allowing for future extensibility.

use crate::error::{AppError, Result};
use crate::models::scheduler::{
    CreateTaskParams, CreateTemplateParams, PromptTemplate, ScheduledTask, TaskCategory, TaskMode,
    TaskStatus,
};
use crate::services::scheduler::local_file_storage::LocalFileStorage;
use crate::services::scheduler::storage::{TaskStorage, TaskUpdateParams, WorkspaceInfo};
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Unified repository for managing scheduled tasks in a single global storage
///
/// This repository uses the TaskStorage trait for storage operations,
/// allowing for different backend implementations (local files, database, etc.)
pub struct UnifiedSchedulerRepository {
    /// Storage backend
    storage: Box<dyn TaskStorage>,
    /// Current workspace path (optional, for filtering)
    current_workspace: Option<PathBuf>,
    /// Current workspace name (for display)
    current_workspace_name: Option<String>,
}

impl UnifiedSchedulerRepository {
    /// Create a new unified scheduler repository with local file storage
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        let storage_dir = config_dir.join("scheduler");

        Self {
            storage: Box::new(LocalFileStorage::new(storage_dir)),
            current_workspace,
            current_workspace_name,
        }
    }

    /// Create a new unified scheduler repository with custom storage backend
    pub fn with_storage(
        storage: Box<dyn TaskStorage>,
        current_workspace: Option<PathBuf>,
    ) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        Self {
            storage,
            current_workspace,
            current_workspace_name,
        }
    }

    /// Register current workspace in the workspaces list
    pub fn register_workspace(&self) -> Result<()> {
        let Some(workspace) = &self.current_workspace else {
            return Ok(());
        };

        let workspace_path = workspace.to_string_lossy().to_string();
        let workspace_name = self.current_workspace_name.clone().unwrap_or_default();

        self.storage.register_workspace(&workspace_path, &workspace_name)
    }

    /// List all tasks (filtered by current workspace if set)
    pub fn list_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let workspace_path = self.current_workspace.as_ref().map(|p| p.to_string_lossy().to_string());
        self.storage.list_tasks(workspace_path.as_deref())
    }

    /// Get a single task by ID
    pub fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        self.storage.get_task(id)
    }

    /// Create a new task
    pub fn create_task(&self, params: CreateTaskParams) -> Result<ScheduledTask> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("任务名称不能为空".to_string()));
        }

        let workspace_path = self.current_workspace.as_ref().map(|p| p.to_string_lossy().to_string());
        let workspace_name = self.current_workspace_name.clone();

        self.storage.create_task(params, workspace_path, workspace_name)
    }

    /// Update a task
    pub fn update_task(&self, id: &str, updates: TaskUpdateParams) -> Result<ScheduledTask> {
        self.storage.update_task(id, updates)
    }

    /// Delete a task
    pub fn delete_task(&self, id: &str) -> Result<ScheduledTask> {
        self.storage.delete_task(id)
    }

    /// Update task execution status
    pub fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<ScheduledTask> {
        self.storage.update_task_status(id, status)
    }

    /// Toggle task enabled state
    pub fn toggle_task(&self, id: &str, enabled: bool) -> Result<ScheduledTask> {
        self.storage.toggle_task(id, enabled)
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        self.storage.get_workspace_breakdown()
    }

    /// List tasks by category
    pub fn list_tasks_by_category(&self, category: TaskCategory) -> Result<Vec<ScheduledTask>> {
        let workspace_path = self.current_workspace.as_ref().map(|p| p.to_string_lossy().to_string());
        self.storage.list_tasks_by_category(category, workspace_path.as_deref())
    }

    /// List tasks by mode
    pub fn list_tasks_by_mode(&self, mode: TaskMode) -> Result<Vec<ScheduledTask>> {
        let workspace_path = self.current_workspace.as_ref().map(|p| p.to_string_lossy().to_string());
        self.storage.list_tasks_by_mode(mode, workspace_path.as_deref())
    }

    /// List tasks by group
    pub fn list_tasks_by_group(&self, group: &str) -> Result<Vec<ScheduledTask>> {
        let workspace_path = self.current_workspace.as_ref().map(|p| p.to_string_lossy().to_string());
        self.storage.list_tasks_by_group(group, workspace_path.as_deref())
    }

    // =========================================================================
    // Template Management
    // =========================================================================

    /// List all templates
    pub fn list_templates(&self) -> Result<Vec<PromptTemplate>> {
        self.storage.list_templates()
    }

    /// Get a single template by ID
    pub fn get_template(&self, id: &str) -> Result<Option<PromptTemplate>> {
        self.storage.get_template(id)
    }

    /// Create a new template
    pub fn create_template(&self, params: CreateTemplateParams) -> Result<PromptTemplate> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        self.storage.create_template(params)
    }

    /// Update a template
    pub fn update_template(&self, template: PromptTemplate) -> Result<PromptTemplate> {
        self.storage.update_template(template)
    }

    /// Delete a template
    pub fn delete_template(&self, id: &str) -> Result<()> {
        self.storage.delete_template(id)
    }

    /// Toggle template enabled state
    pub fn toggle_template(&self, id: &str, enabled: bool) -> Result<PromptTemplate> {
        self.storage.toggle_template(id, enabled)
    }

    /// Get a template and apply it to build the final prompt
    pub fn build_prompt_with_template(&self, template_id: &str, task_name: &str, user_prompt: &str) -> Result<String> {
        self.storage.build_prompt_with_template(template_id, task_name, user_prompt)
    }

    // =========================================================================
    // Workspace Management
    // =========================================================================

    /// List all registered workspaces
    pub fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        self.storage.list_workspaces()
    }

    /// Unregister a workspace
    pub fn unregister_workspace(&self, path: &str) -> Result<()> {
        self.storage.unregister_workspace(path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduler::TriggerType;
    use uuid::Uuid;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-scheduler-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn creates_and_lists_tasks() {
        let config_dir = temp_dir("config");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = UnifiedSchedulerRepository::new(config_dir.clone(), Some(workspace.clone()));
        repo.register_workspace().unwrap();

        let task = repo
            .create_task(CreateTaskParams {
                name: "测试任务".to_string(),
                enabled: true,
                trigger_type: TriggerType::Interval,
                trigger_value: "1h".to_string(),
                engine_id: "claude-code".to_string(),
                prompt: "测试提示词".to_string(),
                ..Default::default()
            })
            .unwrap();

        assert!(task.workspace_path.is_some());
        assert!(task.next_run_at.is_some());

        let tasks = repo.list_tasks().unwrap();
        assert_eq!(tasks.len(), 1);

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn filters_by_category_and_mode() {
        let config_dir = temp_dir("filter");
        std::fs::create_dir_all(&config_dir).unwrap();

        let repo = UnifiedSchedulerRepository::new(config_dir.clone(), None);

        repo.create_task(CreateTaskParams {
            name: "开发任务".to_string(),
            enabled: true,
            trigger_type: TriggerType::Interval,
            trigger_value: "1h".to_string(),
            engine_id: "test".to_string(),
            prompt: "test".to_string(),
            mode: TaskMode::Protocol,
            category: TaskCategory::Development,
            ..Default::default()
        })
        .unwrap();

        repo.create_task(CreateTaskParams {
            name: "审查任务".to_string(),
            enabled: true,
            trigger_type: TriggerType::Interval,
            trigger_value: "1h".to_string(),
            engine_id: "test".to_string(),
            prompt: "test".to_string(),
            mode: TaskMode::Simple,
            category: TaskCategory::Review,
            ..Default::default()
        })
        .unwrap();

        let dev_tasks = repo.list_tasks_by_category(TaskCategory::Development).unwrap();
        assert_eq!(dev_tasks.len(), 1);
        assert_eq!(dev_tasks[0].name, "开发任务");

        let protocol_tasks = repo.list_tasks_by_mode(TaskMode::Protocol).unwrap();
        assert_eq!(protocol_tasks.len(), 1);

        let _ = std::fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn updates_and_deletes_tasks() {
        let config_dir = temp_dir("update");
        std::fs::create_dir_all(&config_dir).unwrap();

        let repo = UnifiedSchedulerRepository::new(config_dir.clone(), None);

        let created = repo
            .create_task(CreateTaskParams {
                name: "原始任务".to_string(),
                enabled: true,
                trigger_type: TriggerType::Interval,
                trigger_value: "30m".to_string(),
                engine_id: "test".to_string(),
                prompt: "test".to_string(),
                ..Default::default()
            })
            .unwrap();

        let updated = repo
            .update_task(
                &created.id,
                TaskUpdateParams {
                    name: Some("更新任务".to_string()),
                    enabled: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();

        assert_eq!(updated.name, "更新任务");
        assert!(!updated.enabled);

        let deleted = repo.delete_task(&created.id).unwrap();
        assert_eq!(deleted.id, created.id);

        let tasks = repo.list_tasks().unwrap();
        assert!(tasks.is_empty());

        let _ = std::fs::remove_dir_all(&config_dir);
    }

    #[test]
    fn toggles_task_status() {
        let config_dir = temp_dir("toggle");
        std::fs::create_dir_all(&config_dir).unwrap();

        let repo = UnifiedSchedulerRepository::new(config_dir.clone(), None);

        let created = repo
            .create_task(CreateTaskParams {
                name: "切换测试".to_string(),
                enabled: true,
                trigger_type: TriggerType::Interval,
                trigger_value: "1h".to_string(),
                engine_id: "test".to_string(),
                prompt: "test".to_string(),
                ..Default::default()
            })
            .unwrap();

        assert!(created.enabled);

        let toggled = repo.toggle_task(&created.id, false).unwrap();
        assert!(!toggled.enabled);

        let _ = std::fs::remove_dir_all(&config_dir);
    }
}
