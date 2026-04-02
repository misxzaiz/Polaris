//! Local File Storage Implementation
//!
//! Implements TaskStorage trait using local file system.
//! Tasks and templates are stored in JSON files within a config directory.

use crate::error::{AppError, Result};
use crate::models::scheduler::{
    apply_template, CreateTaskParams, CreateTemplateParams, PromptTemplate, ScheduledTask, TaskCategory, TaskMode,
    TaskStatus, TaskStore, TemplateStore, TriggerType,
};
use crate::services::scheduler::storage::{TaskStorage, TaskUpdateParams, WorkspaceInfo};
use chrono::Utc;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::path::PathBuf;
use uuid::Uuid;

use super::storage::StorageBackend;

const TASKS_FILE_NAME: &str = "tasks.json";
const TEMPLATES_FILE_NAME: &str = "templates.json";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";
const SCHEDULER_FILE_VERSION: &str = "1.1.0";

/// Local file-based storage for scheduled tasks
pub struct LocalFileStorage {
    /// Storage directory path
    storage_dir: PathBuf,
}

impl LocalFileStorage {
    /// Create a new local file storage instance
    pub fn new(storage_dir: PathBuf) -> Self {
        Self { storage_dir }
    }

    /// Get the storage directory path
    pub fn storage_dir(&self) -> &std::path::Path {
        &self.storage_dir
    }

    /// Get the storage backend type
    pub fn backend_type(&self) -> StorageBackend {
        StorageBackend::LocalFile
    }

    // =========================================================================
    // File Operations
    // =========================================================================

    fn read_tasks_file(&self) -> Result<TaskStore> {
        let file_path = self.storage_dir.join(TASKS_FILE_NAME);

        if !file_path.exists() {
            let empty = TaskStore::default();
            self.write_tasks_file(&empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        Ok(normalize_file_data(raw_json))
    }

    fn write_tasks_file(&self, data: &TaskStore) -> Result<()> {
        if let Some(parent) = self.storage_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&self.storage_dir)?;

        let file_path = self.storage_dir.join(TASKS_FILE_NAME);
        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
        Ok(())
    }

    fn read_templates_file(&self) -> Result<TemplateStore> {
        let file_path = self.storage_dir.join(TEMPLATES_FILE_NAME);

        if !file_path.exists() {
            let empty = create_empty_template_store();
            self.write_templates_file(&empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&file_path)?;
        let data: TemplateStore = serde_json::from_str(&content).unwrap_or_else(|_| create_empty_template_store());
        Ok(data)
    }

    fn write_templates_file(&self, data: &TemplateStore) -> Result<()> {
        if let Some(parent) = self.storage_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&self.storage_dir)?;

        let file_path = self.storage_dir.join(TEMPLATES_FILE_NAME);
        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
        Ok(())
    }

    fn read_workspaces_file(&self) -> Result<WorkspacesFile> {
        let file_path = self.storage_dir.join(WORKSPACES_FILE_NAME);

        if !file_path.exists() {
            return Ok(WorkspacesFile {
                version: SCHEDULER_FILE_VERSION.to_string(),
                workspaces: Vec::new(),
            });
        }

        let content = std::fs::read_to_string(&file_path)?;
        let data: WorkspacesFile = serde_json::from_str(&content).unwrap_or_default();
        Ok(data)
    }

    fn write_workspaces_file(&self, data: &WorkspacesFile) -> Result<()> {
        if let Some(parent) = self.storage_dir.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::create_dir_all(&self.storage_dir)?;

        let file_path = self.storage_dir.join(WORKSPACES_FILE_NAME);
        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
        Ok(())
    }
}

impl TaskStorage for LocalFileStorage {
    // =========================================================================
    // Task Operations
    // =========================================================================

    fn list_tasks(&self, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>> {
        let all_tasks = self.read_tasks_file()?.tasks;

        let filtered = if let Some(workspace) = workspace_path {
            all_tasks
                .into_iter()
                .filter(|task| task.workspace_path.as_deref() == Some(workspace))
                .collect()
        } else {
            all_tasks
        };

        Ok(filtered)
    }

    fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let data = self.read_tasks_file()?;
        Ok(data.tasks.into_iter().find(|task| task.id == id))
    }

    fn create_task(&self, params: CreateTaskParams, workspace_path: Option<String>, workspace_name: Option<String>) -> Result<ScheduledTask> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("任务名称不能为空".to_string()));
        }

        let mut data = self.read_tasks_file()?;
        let now = Utc::now().timestamp();
        let id = Uuid::new_v4().to_string();

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
            mode: params.mode,
            category: params.category,
            task_path: None,
            mission: sanitize_optional_string(params.mission),
            template_id: sanitize_optional_string(params.template_id),
            template_params: params.template_params,
            max_runs: params.max_runs,
            current_runs: 0,
            max_retries: params.max_retries,
            retry_count: 0,
            retry_interval: sanitize_optional_string(params.retry_interval),
            timeout_minutes: params.timeout_minutes,
            group: sanitize_optional_string(params.group),
            notify_on_complete: params.notify_on_complete,
        };

        data.tasks.push(task.clone());
        self.write_tasks_file(&data)?;
        Ok(task)
    }

    fn update_task(&self, id: &str, updates: TaskUpdateParams) -> Result<ScheduledTask> {
        let mut data = self.read_tasks_file()?;
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

        if updates.template_id.is_some() {
            task.template_id = sanitize_optional_string(updates.template_id);
        }

        if updates.next_run_at.is_some() {
            task.next_run_at = updates.next_run_at;
        }

        if updates.last_run_at.is_some() {
            task.last_run_at = updates.last_run_at;
        }

        if let Some(mode) = updates.mode {
            task.mode = mode;
        }

        if let Some(category) = updates.category {
            task.category = category;
        }

        if updates.task_path.is_some() {
            task.task_path = sanitize_optional_string(updates.task_path);
        }

        if updates.mission.is_some() {
            task.mission = sanitize_optional_string(updates.mission);
        }

        if updates.template_params.is_some() {
            task.template_params = updates.template_params;
        }

        if let Some(max_runs) = updates.max_runs {
            task.max_runs = Some(max_runs);
        }

        if let Some(current_runs) = updates.current_runs {
            task.current_runs = current_runs;
        }

        if let Some(max_retries) = updates.max_retries {
            task.max_retries = Some(max_retries);
        }

        if let Some(retry_count) = updates.retry_count {
            task.retry_count = retry_count;
        }

        if updates.retry_interval.is_some() {
            task.retry_interval = sanitize_optional_string(updates.retry_interval);
        }

        if let Some(timeout_minutes) = updates.timeout_minutes {
            task.timeout_minutes = Some(timeout_minutes);
        }

        if updates.group.is_some() {
            task.group = sanitize_optional_string(updates.group);
        }

        if let Some(notify_on_complete) = updates.notify_on_complete {
            task.notify_on_complete = notify_on_complete;
        }

        task.updated_at = Utc::now().timestamp();

        if updates.next_run_at.is_none() {
            task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, task.updated_at);
        }

        let result = task.clone();
        self.write_tasks_file(&data)?;
        Ok(result)
    }

    fn delete_task(&self, id: &str) -> Result<ScheduledTask> {
        let mut data = self.read_tasks_file()?;
        let index = data
            .tasks
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("任务不存在: {}", id)))?;
        let removed = data.tasks.remove(index);
        self.write_tasks_file(&data)?;
        Ok(removed)
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<ScheduledTask> {
        let mut data = self.read_tasks_file()?;
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
        self.write_tasks_file(&data)?;
        Ok(result)
    }

    fn toggle_task(&self, id: &str, enabled: bool) -> Result<ScheduledTask> {
        self.update_task(id, TaskUpdateParams {
            enabled: Some(enabled),
            ..Default::default()
        })
    }

    fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let tasks = self.read_tasks_file()?.tasks;
        let mut breakdown = BTreeMap::new();

        for task in tasks {
            let key = task.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    fn list_tasks_by_category(&self, category: TaskCategory, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>> {
        let tasks = self.list_tasks(workspace_path)?;
        Ok(tasks.into_iter().filter(|t| t.category == category).collect())
    }

    fn list_tasks_by_mode(&self, mode: TaskMode, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>> {
        let tasks = self.list_tasks(workspace_path)?;
        Ok(tasks.into_iter().filter(|t| t.mode == mode).collect())
    }

    fn list_tasks_by_group(&self, group: &str, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>> {
        let tasks = self.list_tasks(workspace_path)?;
        Ok(tasks.into_iter().filter(|t| t.group.as_deref() == Some(group)).collect())
    }

    // =========================================================================
    // Template Operations
    // =========================================================================

    fn list_templates(&self) -> Result<Vec<PromptTemplate>> {
        let templates_data = self.read_templates_file()?;
        Ok(templates_data.templates)
    }

    fn get_template(&self, id: &str) -> Result<Option<PromptTemplate>> {
        let templates_data = self.read_templates_file()?;
        Ok(templates_data.templates.into_iter().find(|t| t.id == id))
    }

    fn create_template(&self, params: CreateTemplateParams) -> Result<PromptTemplate> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        let mut templates_data = self.read_templates_file()?;
        let now = Utc::now().timestamp();
        let id = Uuid::new_v4().to_string();

        let template = PromptTemplate {
            id: id.clone(),
            name: name.to_string(),
            description: sanitize_optional_string(params.description),
            content: params.content,
            enabled: params.enabled,
            created_at: now,
            updated_at: now,
        };

        templates_data.templates.push(template.clone());
        self.write_templates_file(&templates_data)?;
        Ok(template)
    }

    fn update_template(&self, template: PromptTemplate) -> Result<PromptTemplate> {
        let mut templates_data = self.read_templates_file()?;
        let existing = templates_data
            .templates
            .iter_mut()
            .find(|t| t.id == template.id)
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", template.id)))?;

        existing.name = template.name;
        existing.description = template.description;
        existing.content = template.content;
        existing.enabled = template.enabled;
        existing.updated_at = Utc::now().timestamp();

        let result = existing.clone();
        self.write_templates_file(&templates_data)?;
        Ok(result)
    }

    fn delete_template(&self, id: &str) -> Result<()> {
        let mut templates_data = self.read_templates_file()?;
        let index = templates_data
            .templates
            .iter()
            .position(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        templates_data.templates.remove(index);
        self.write_templates_file(&templates_data)?;
        Ok(())
    }

    fn toggle_template(&self, id: &str, enabled: bool) -> Result<PromptTemplate> {
        let mut templates_data = self.read_templates_file()?;
        let template = templates_data
            .templates
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", id)))?;

        template.enabled = enabled;
        template.updated_at = Utc::now().timestamp();

        let result = template.clone();
        self.write_templates_file(&templates_data)?;
        Ok(result)
    }

    fn build_prompt_with_template(&self, template_id: &str, task_name: &str, user_prompt: &str) -> Result<String> {
        let template = self.get_template(template_id)?
            .ok_or_else(|| AppError::ValidationError(format!("模板不存在: {}", template_id)))?;

        Ok(apply_template(&template.content, task_name, user_prompt))
    }

    // =========================================================================
    // Workspace Operations
    // =========================================================================

    fn register_workspace(&self, path: &str, name: &str) -> Result<()> {
        let mut data = self.read_workspaces_file()?;
        let now = now_iso();

        if let Some(existing) = data.workspaces.iter_mut().find(|w| w.path == path) {
            existing.last_accessed_at = now;
        } else {
            data.workspaces.push(WorkspaceInfo {
                path: path.to_string(),
                name: name.to_string(),
                last_accessed_at: now,
            });
        }

        self.write_workspaces_file(&data)?;
        Ok(())
    }

    fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        let data = self.read_workspaces_file()?;
        Ok(data.workspaces)
    }

    fn unregister_workspace(&self, path: &str) -> Result<()> {
        let mut data = self.read_workspaces_file()?;
        data.workspaces.retain(|w| w.path != path);
        self.write_workspaces_file(&data)?;
        Ok(())
    }
}

// =========================================================================
// Helper Structures and Functions
// =========================================================================

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct WorkspacesFile {
    version: String,
    workspaces: Vec<WorkspaceInfo>,
}

fn create_empty_template_store() -> TemplateStore {
    TemplateStore {
        version: SCHEDULER_FILE_VERSION.to_string(),
        templates: Vec::new(),
    }
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
        mode: parse_task_mode(object.get("mode")).unwrap_or_default(),
        category: parse_task_category(object.get("category")).unwrap_or_default(),
        task_path: optional_string_field(object.get("taskPath")),
        mission: optional_string_field(object.get("mission")),
        template_id: optional_string_field(object.get("templateId")),
        template_params: parse_template_params(object.get("templateParams")),
        max_runs: object.get("maxRuns").and_then(|v| v.as_u64()).map(|n| n as u32),
        current_runs: object.get("currentRuns").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        max_retries: object.get("maxRetries").and_then(|v| v.as_u64()).map(|n| n as u32),
        retry_count: object.get("retryCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
        retry_interval: optional_string_field(object.get("retryInterval")),
        timeout_minutes: object.get("timeoutMinutes").and_then(|v| v.as_u64()).map(|n| n as u32),
        group: optional_string_field(object.get("group")),
        notify_on_complete: object.get("notifyOnComplete").and_then(|v| v.as_bool()).unwrap_or(true),
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

fn parse_task_mode(value: Option<&serde_json::Value>) -> Option<TaskMode> {
    match value.and_then(|v| v.as_str()) {
        Some("simple") => Some(TaskMode::Simple),
        Some("protocol") => Some(TaskMode::Protocol),
        _ => None,
    }
}

fn parse_task_category(value: Option<&serde_json::Value>) -> Option<TaskCategory> {
    match value.and_then(|v| v.as_str()) {
        Some("development") => Some(TaskCategory::Development),
        Some("review") => Some(TaskCategory::Review),
        Some("news") => Some(TaskCategory::News),
        Some("monitor") => Some(TaskCategory::Monitor),
        Some("custom") => Some(TaskCategory::Custom),
        _ => None,
    }
}

fn parse_template_params(value: Option<&serde_json::Value>) -> Option<HashMap<String, String>> {
    value.and_then(|v| v.as_object()).map(|obj| {
        obj.iter()
            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
            .collect()
    })
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
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-scheduler-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn creates_and_lists_tasks() {
        let storage_dir = temp_dir("create");
        std::fs::create_dir_all(&storage_dir).unwrap();

        let storage = LocalFileStorage::new(storage_dir.clone());

        let task = storage
            .create_task(
                CreateTaskParams {
                    name: "测试任务".to_string(),
                    enabled: true,
                    trigger_type: TriggerType::Interval,
                    trigger_value: "1h".to_string(),
                    engine_id: "claude-code".to_string(),
                    prompt: "测试提示词".to_string(),
                    work_dir: None,
                    description: None,
                },
                Some("/workspace/path".to_string()),
                Some("workspace".to_string()),
            )
            .unwrap();

        assert!(task.workspace_path.is_some());
        assert!(task.next_run_at.is_some());

        let tasks = storage.list_tasks(Some("/workspace/path")).unwrap();
        assert_eq!(tasks.len(), 1);

        let _ = std::fs::remove_dir_all(&storage_dir);
    }

    #[test]
    fn filters_by_category_and_mode() {
        let storage_dir = temp_dir("filter");
        std::fs::create_dir_all(&storage_dir).unwrap();

        let storage = LocalFileStorage::new(storage_dir.clone());

        storage
            .create_task(
                CreateTaskParams {
                    name: "开发任务".to_string(),
                    enabled: true,
                    trigger_type: TriggerType::Interval,
                    trigger_value: "1h".to_string(),
                    engine_id: "test".to_string(),
                    prompt: "test".to_string(),
                    work_dir: None,
                    description: None,
                    mode: TaskMode::Protocol,
                    category: TaskCategory::Development,
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();

        storage
            .create_task(
                CreateTaskParams {
                    name: "审查任务".to_string(),
                    enabled: true,
                    trigger_type: TriggerType::Interval,
                    trigger_value: "1h".to_string(),
                    engine_id: "test".to_string(),
                    prompt: "test".to_string(),
                    work_dir: None,
                    description: None,
                    mode: TaskMode::Simple,
                    category: TaskCategory::Review,
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();

        let dev_tasks = storage.list_tasks_by_category(TaskCategory::Development, None).unwrap();
        assert_eq!(dev_tasks.len(), 1);
        assert_eq!(dev_tasks[0].name, "开发任务");

        let protocol_tasks = storage.list_tasks_by_mode(TaskMode::Protocol, None).unwrap();
        assert_eq!(protocol_tasks.len(), 1);

        let _ = std::fs::remove_dir_all(&storage_dir);
    }

    #[test]
    fn manages_workspaces() {
        let storage_dir = temp_dir("workspace");
        std::fs::create_dir_all(&storage_dir).unwrap();

        let storage = LocalFileStorage::new(storage_dir.clone());

        storage.register_workspace("/path/to/ws1", "ws1").unwrap();
        storage.register_workspace("/path/to/ws2", "ws2").unwrap();

        let workspaces = storage.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);

        // Update last accessed
        storage.register_workspace("/path/to/ws1", "ws1").unwrap();
        let workspaces = storage.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 2);

        storage.unregister_workspace("/path/to/ws1").unwrap();
        let workspaces = storage.list_workspaces().unwrap();
        assert_eq!(workspaces.len(), 1);

        let _ = std::fs::remove_dir_all(&storage_dir);
    }
}
