//! Unified Scheduler Repository
//!
//! Single storage for all scheduled tasks in config_dir/scheduler/tasks.json.
//! Workspace filtering via workspacePath field.

use crate::error::{AppError, Result};
use crate::models::scheduler::{
    CreateTaskParams, ScheduledTask, TaskStatus, TaskStore, TriggerType,
};
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

const TASKS_FILE_NAME: &str = "tasks.json";
const SCHEDULER_FILE_VERSION: &str = "1.0.0";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing scheduled tasks in a single global storage
pub struct UnifiedSchedulerRepository {
    /// Global storage directory (config_dir/scheduler)
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
    pub document_config: Option<crate::models::scheduler::DocumentConfig>,
}

impl UnifiedSchedulerRepository {
    /// Create a new unified scheduler repository
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        Self {
            storage_dir: config_dir.join("scheduler"),
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

    /// List all tasks (filtered by current workspace if set)
    pub fn list_tasks(&self) -> Result<Vec<ScheduledTask>> {
        let all_tasks = self.read_file_data()?.tasks;

        let filtered = if let Some(workspace) = &self.current_workspace {
            let workspace_path = workspace.to_string_lossy().to_string();
            all_tasks
                .into_iter()
                .filter(|task| task.workspace_path.as_deref() == Some(workspace_path.as_str()))
                .collect()
        } else {
            all_tasks
        };

        Ok(filtered)
    }

    /// Get a single task by ID
    pub fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let data = self.read_file_data()?;
        Ok(data.tasks.into_iter().find(|task| task.id == id))
    }

    /// Create a new task
    pub fn create_task(&self, params: CreateTaskParams) -> Result<ScheduledTask> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("任务名称不能为空".to_string()));
        }

        let mut data = self.read_file_data()?;
        let now = Utc::now().timestamp();
        let id = Uuid::new_v4().to_string();

        let (workspace_path, workspace_name) = if let Some(workspace) = &self.current_workspace {
            (
                Some(workspace.to_string_lossy().to_string()),
                self.current_workspace_name.clone(),
            )
        } else {
            (None, None)
        };

        // Calculate next run time before moving values
        let next_run_at = params.trigger_type.calculate_next_run(&params.trigger_value, now);

        let task = ScheduledTask {
            id: id.clone(),
            name: name.to_string(),
            enabled: params.enabled,
            trigger_type: params.trigger_type,
            trigger_value: params.trigger_value,
            engine_id: params.engine_id,
            prompt: params.prompt,
            work_dir: sanitize_optional_string(params.work_dir),
            description: sanitize_optional_string(params.description),
            last_run_at: None,
            last_run_status: None,
            next_run_at,
            created_at: now,
            updated_at: now,
            workspace_path,
            workspace_name,
            document_config: params.document_config,
        };

        data.tasks.push(task.clone());
        self.write_file_data(&mut data)?;
        Ok(task)
    }

    /// Update a task
    pub fn update_task(&self, id: &str, updates: TaskUpdateParams) -> Result<ScheduledTask> {
        let mut data = self.read_file_data()?;
        let task = data
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("任务不存在: {}", id)))?;

        if let Some(name) = updates.name.as_ref() {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                task.name = trimmed.to_string();
            }
        }

        if let Some(enabled) = updates.enabled {
            task.enabled = enabled;
        }

        if let Some(trigger_type) = updates.trigger_type {
            task.trigger_type = trigger_type;
        }

        if let Some(trigger_value) = updates.trigger_value.as_ref() {
            task.trigger_value = trigger_value.clone();
        }

        if let Some(engine_id) = updates.engine_id.as_ref() {
            task.engine_id = engine_id.clone();
        }

        if let Some(prompt) = updates.prompt.as_ref() {
            task.prompt = prompt.clone();
        }

        if updates.work_dir.is_some() {
            task.work_dir = sanitize_optional_string(updates.work_dir);
        }

        if updates.description.is_some() {
            task.description = sanitize_optional_string(updates.description);
        }

        if updates.document_config.is_some() {
            task.document_config = updates.document_config;
        }

        task.updated_at = Utc::now().timestamp();
        task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, task.updated_at);

        let result = task.clone();
        self.write_file_data(&mut data)?;
        Ok(result)
    }

    /// Delete a task
    pub fn delete_task(&self, id: &str) -> Result<ScheduledTask> {
        let mut data = self.read_file_data()?;
        let index = data
            .tasks
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("任务不存在: {}", id)))?;
        let removed = data.tasks.remove(index);
        self.write_file_data(&mut data)?;
        Ok(removed)
    }

    /// Update task execution status
    pub fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<ScheduledTask> {
        let mut data = self.read_file_data()?;
        let task = data
            .tasks
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("任务不存在: {}", id)))?;

        let now = Utc::now().timestamp();
        task.last_run_at = Some(now);
        task.last_run_status = Some(status);
        task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, now);

        let result = task.clone();
        self.write_file_data(&mut data)?;
        Ok(result)
    }

    /// Toggle task enabled state
    pub fn toggle_task(&self, id: &str, enabled: bool) -> Result<ScheduledTask> {
        self.update_task(id, TaskUpdateParams {
            enabled: Some(enabled),
            ..Default::default()
        })
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let tasks = self.read_file_data()?.tasks;
        let mut breakdown = BTreeMap::new();

        for task in tasks {
            let key = task.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn read_file_data(&self) -> Result<TaskStore> {
        let file_path = self.storage_dir.join(TASKS_FILE_NAME);

        if !file_path.exists() {
            let mut empty = create_empty_task_store();
            self.write_file_data(&mut empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        Ok(normalize_file_data(raw_json))
    }

    fn write_file_data(&self, data: &mut TaskStore) -> Result<()> {
        if let Some(parent) = self.storage_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&self.storage_dir)?;

        let file_path = self.storage_dir.join(TASKS_FILE_NAME);
        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
        Ok(())
    }

    fn read_workspaces_file(&self, path: &std::path::Path) -> Result<WorkspacesFile> {
        if !path.exists() {
            return Ok(WorkspacesFile {
                version: SCHEDULER_FILE_VERSION.to_string(),
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

fn create_empty_task_store() -> TaskStore {
    TaskStore::default()
}

fn normalize_file_data(raw_json: serde_json::Value) -> TaskStore {
    let tasks = raw_json
        .get("tasks")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(normalize_task_item).collect::<Vec<_>>())
        .unwrap_or_default();

    TaskStore { tasks }
}

fn normalize_task_item(value: &serde_json::Value) -> Option<ScheduledTask> {
    let object = value.as_object()?;
    let id = object.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }

    let name = object.get("name").and_then(|v| v.as_str()).unwrap_or(id).trim().to_string();
    let now = Utc::now().timestamp();

    Some(ScheduledTask {
        id: id.to_string(),
        name,
        enabled: object.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true),
        trigger_type: parse_trigger_type(object.get("triggerType")).unwrap_or_default(),
        trigger_value: object
            .get("triggerValue")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        engine_id: object
            .get("engineId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        prompt: object
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        work_dir: optional_string_field(object.get("workDir")),
        description: optional_string_field(object.get("description")),
        last_run_at: object.get("lastRunAt").and_then(|v| v.as_i64()),
        last_run_status: parse_task_status(object.get("lastRunStatus")),
        next_run_at: object.get("nextRunAt").and_then(|v| v.as_i64()),
        created_at: object.get("createdAt").and_then(|v| v.as_i64()).unwrap_or(now),
        updated_at: object.get("updatedAt").and_then(|v| v.as_i64()).unwrap_or(now),
        workspace_path: optional_string_field(object.get("workspacePath")),
        workspace_name: optional_string_field(object.get("workspaceName")),
        document_config: None,
    })
}

fn parse_trigger_type(value: Option<&serde_json::Value>) -> Option<TriggerType> {
    match value.and_then(|v| v.as_str()) {
        Some("once") => Some(TriggerType::Once),
        Some("cron") => Some(TriggerType::Cron),
        Some("interval") => Some(TriggerType::Interval),
        _ => None,
    }
}

fn parse_task_status(value: Option<&serde_json::Value>) -> Option<TaskStatus> {
    match value.and_then(|v| v.as_str()) {
        Some("running") => Some(TaskStatus::Running),
        Some("success") => Some(TaskStatus::Success),
        Some("failed") => Some(TaskStatus::Failed),
        _ => None,
    }
}

fn optional_string_field(value: Option<&serde_json::Value>) -> Option<String> {
    value
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn sanitize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|v| {
        let trimmed = v.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

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
                work_dir: None,
                description: None,
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
                work_dir: None,
                description: None,
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
                work_dir: None,
                description: None,
            })
            .unwrap();

        assert!(created.enabled);

        let toggled = repo.toggle_task(&created.id, false).unwrap();
        assert!(!toggled.enabled);

        let _ = std::fs::remove_dir_all(&config_dir);
    }
}
