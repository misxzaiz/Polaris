//! Unified Requirement Repository
//!
//! Single storage for all requirements in config_dir/requirements/requirements.json.
//! Workspace filtering via workspacePath field.

use crate::error::{AppError, Result};
use crate::models::requirement::{
    QueryScope, RequirementCreateParams, RequirementExecuteConfig, RequirementFileData,
    RequirementItem, RequirementPriority, RequirementSource, RequirementStatus,
    RequirementUpdateParams,
};
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const REQUIREMENTS_FILE_NAME: &str = "requirements.json";
const PROTOTYPES_DIR_NAME: &str = "prototypes";
const REQUIREMENTS_FILE_VERSION: &str = "1.0.0";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing requirements in a single global storage
pub struct UnifiedRequirementRepository {
    /// Global storage directory (config_dir/requirements)
    storage_dir: PathBuf,
    /// Prototypes directory
    prototypes_dir: PathBuf,
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

impl UnifiedRequirementRepository {
    /// Create a new unified requirement repository
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        let storage_dir = config_dir.join("requirements");
        let prototypes_dir = storage_dir.join(PROTOTYPES_DIR_NAME);

        Self {
            storage_dir,
            prototypes_dir,
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

    /// List requirements based on scope
    pub fn list_requirements(&self, scope: QueryScope) -> Result<Vec<RequirementItem>> {
        let all_requirements = self.read_file_data()?.requirements;

        let filtered = match scope {
            QueryScope::Workspace => {
                if let Some(workspace) = &self.current_workspace {
                    let workspace_path = workspace.to_string_lossy().to_string();
                    all_requirements
                        .into_iter()
                        .filter(|req| req.workspace_path.as_deref() == Some(workspace_path.as_str()))
                        .collect()
                } else {
                    all_requirements
                        .into_iter()
                        .filter(|req| req.workspace_path.is_none())
                        .collect()
                }
            }
            QueryScope::All => all_requirements,
        };

        Ok(filtered)
    }

    /// Get a single requirement by ID
    pub fn get_requirement(&self, id: &str) -> Result<Option<RequirementItem>> {
        let data = self.read_file_data()?;
        Ok(data.requirements.into_iter().find(|req| req.id == id))
    }

    /// Create a new requirement
    pub fn create_requirement(&self, params: RequirementCreateParams) -> Result<RequirementItem> {
        let title = params.title.trim();
        if title.is_empty() {
            return Err(AppError::ValidationError("需求标题不能为空".to_string()));
        }

        let description = params.description.trim();
        if description.is_empty() {
            return Err(AppError::ValidationError("需求描述不能为空".to_string()));
        }

        let mut data = self.read_file_data()?;
        if data.requirements.iter().any(|item| item.title.trim() == title) {
            return Err(AppError::ValidationError(format!("已存在同名需求: {}", title)));
        }

        let now = now_millis();
        let id = Uuid::new_v4().to_string();
        let has_prototype = params.has_prototype.unwrap_or(false);

        let (workspace_path, workspace_name) = if let Some(workspace) = &self.current_workspace {
            (
                Some(workspace.to_string_lossy().to_string()),
                self.current_workspace_name.clone(),
            )
        } else {
            (None, None)
        };

        let item = RequirementItem {
            id: id.clone(),
            title: title.to_string(),
            description: description.to_string(),
            status: match params.generated_by.clone().unwrap_or_default() {
                RequirementSource::Ai => RequirementStatus::Pending,
                RequirementSource::User => RequirementStatus::Draft,
            },
            priority: params.priority.unwrap_or_default(),
            tags: sanitize_tags(params.tags),
            prototype_path: has_prototype.then(|| format!("prototypes/{}.html", id)),
            has_prototype,
            generated_by: params.generated_by.unwrap_or_default(),
            generated_at: now,
            generator_task_id: sanitize_optional_string(params.generator_task_id),
            reviewed_at: None,
            review_note: None,
            execute_config: None,
            execute_log: None,
            executed_at: None,
            completed_at: None,
            session_id: None,
            execute_error: None,
            created_at: now,
            updated_at: now,
            workspace_path,
            workspace_name,
        };

        data.requirements.push(item.clone());
        self.write_file_data(&mut data)?;
        Ok(item)
    }

    /// Update a requirement
    pub fn update_requirement(&self, id: &str, updates: RequirementUpdateParams) -> Result<RequirementItem> {
        let mut data = self.read_file_data()?;
        let requirement = data
            .requirements
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("需求不存在: {}", id)))?;

        if let Some(title) = updates.title.clone() {
            let title = title.trim();
            if !title.is_empty() {
                requirement.title = title.to_string();
            }
        }

        if let Some(description) = updates.description.clone() {
            let description = description.trim();
            if !description.is_empty() {
                requirement.description = description.to_string();
            }
        }

        if let Some(status) = updates.status.clone() {
            let previous = requirement.status.clone();
            requirement.status = status.clone();
            apply_status_side_effects(requirement, &previous, &status);
        }

        if let Some(priority) = updates.priority {
            requirement.priority = priority;
        }

        if let Some(tags) = updates.tags {
            requirement.tags = sanitize_tags(Some(tags));
        }

        if let Some(prototype_path) = updates.prototype_path {
            requirement.prototype_path = sanitize_optional_string(Some(prototype_path));
        }

        if let Some(has_prototype) = updates.has_prototype {
            requirement.has_prototype = has_prototype;
            if !has_prototype {
                requirement.prototype_path = None;
            }
        }

        if let Some(review_note) = updates.review_note {
            requirement.review_note = sanitize_optional_string(Some(review_note));
        }

        if let Some(execute_config) = updates.execute_config {
            requirement.execute_config = Some(sanitize_execute_config(execute_config));
        }

        if let Some(execute_log) = updates.execute_log {
            requirement.execute_log = sanitize_optional_string(Some(execute_log));
        }

        if let Some(execute_error) = updates.execute_error {
            requirement.execute_error = sanitize_optional_string(Some(execute_error));
        }

        if let Some(generated_by) = updates.generated_by {
            requirement.generated_by = generated_by;
        }

        if let Some(session_id) = updates.session_id {
            requirement.session_id = sanitize_optional_string(Some(session_id));
        }

        requirement.updated_at = now_millis();
        let result = requirement.clone();
        self.write_file_data(&mut data)?;
        Ok(result)
    }

    /// Delete a requirement
    pub fn delete_requirement(&self, id: &str) -> Result<RequirementItem> {
        let mut data = self.read_file_data()?;
        let index = data
            .requirements
            .iter()
            .position(|item| item.id == id)
            .ok_or_else(|| AppError::ValidationError(format!("需求不存在: {}", id)))?;
        let removed = data.requirements.remove(index);
        self.write_file_data(&mut data)?;

        // Also delete prototype file if exists
        if let Some(prototype_path) = &removed.prototype_path {
            let full_path = self.storage_dir.join(prototype_path);
            if full_path.exists() {
                let _ = std::fs::remove_file(&full_path);
            }
        }

        Ok(removed)
    }

    /// Save prototype HTML
    pub fn save_prototype(&self, id: &str, html: &str) -> Result<String> {
        std::fs::create_dir_all(&self.prototypes_dir)?;

        let relative_path = format!("prototypes/{}.html", id);
        let full_path = self.storage_dir.join(&relative_path);
        std::fs::write(&full_path, html)?;

        // Update requirement
        let _ = self.update_requirement(
            id,
            RequirementUpdateParams {
                prototype_path: Some(relative_path.clone()),
                has_prototype: Some(true),
                ..Default::default()
            },
        );

        Ok(relative_path)
    }

    /// Read prototype HTML
    pub fn read_prototype(&self, prototype_path: &str) -> Result<String> {
        let full_path = self.storage_dir.join(prototype_path);
        if !full_path.exists() {
            return Err(AppError::ValidationError(format!("原型文件不存在: {}", prototype_path)));
        }
        Ok(std::fs::read_to_string(&full_path)?)
    }

    /// Get workspace breakdown summary
    pub fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let requirements = self.read_file_data()?.requirements;
        let mut breakdown = BTreeMap::new();

        for req in requirements {
            let key = req.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers
    // =========================================================================

    fn read_file_data(&self) -> Result<RequirementFileData> {
        let file_path = self.storage_dir.join(REQUIREMENTS_FILE_NAME);

        if !file_path.exists() {
            let mut empty = create_empty_requirement_file_data();
            self.write_file_data(&mut empty)?;
            return Ok(empty);
        }

        let content = std::fs::read_to_string(&file_path)?;
        let raw_json: serde_json::Value = serde_json::from_str(&content).unwrap_or_else(|_| serde_json::json!({}));

        Ok(normalize_file_data(raw_json))
    }

    fn write_file_data(&self, data: &mut RequirementFileData) -> Result<()> {
        let file_path = self.storage_dir.join(REQUIREMENTS_FILE_NAME);

        data.version = REQUIREMENTS_FILE_VERSION.to_string();
        data.updated_at = now_iso();

        if let Some(parent) = file_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let content = serde_json::to_string_pretty(data)?;
        std::fs::write(&file_path, format!("{}\n", content))?;
        Ok(())
    }

    fn read_workspaces_file(&self, path: &Path) -> Result<WorkspacesFile> {
        if !path.exists() {
            return Ok(WorkspacesFile {
                version: REQUIREMENTS_FILE_VERSION.to_string(),
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

// =========================================================================
// Helper functions
// =========================================================================

fn create_empty_requirement_file_data() -> RequirementFileData {
    RequirementFileData {
        version: REQUIREMENTS_FILE_VERSION.to_string(),
        updated_at: now_iso(),
        requirements: Vec::new(),
    }
}

fn normalize_file_data(raw_json: serde_json::Value) -> RequirementFileData {
    let version = raw_json
        .get("version")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(REQUIREMENTS_FILE_VERSION)
        .to_string();

    let updated_at = raw_json
        .get("updatedAt")
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(str::to_string)
        .unwrap_or_else(now_iso);

    let requirements = raw_json
        .get("requirements")
        .and_then(|value| value.as_array())
        .map(|items| items.iter().filter_map(normalize_requirement_item).collect())
        .unwrap_or_default();

    RequirementFileData {
        version,
        updated_at,
        requirements,
    }
}

fn normalize_requirement_item(raw: &serde_json::Value) -> Option<RequirementItem> {
    let object = raw.as_object()?;
    let id = object.get("id")?.as_str()?.trim();
    if id.is_empty() {
        return None;
    }

    let now = now_millis();
    let title = object.get("title").and_then(|value| value.as_str()).unwrap_or(id).trim().to_string();
    let description = object.get("description").and_then(|value| value.as_str()).unwrap_or_default().to_string();

    Some(RequirementItem {
        id: id.to_string(),
        title,
        description,
        status: object.get("status").and_then(parse_status).unwrap_or_default(),
        priority: object.get("priority").and_then(parse_priority).unwrap_or_default(),
        tags: object
            .get("tags")
            .and_then(|value| value.as_array())
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        prototype_path: object.get("prototypePath").and_then(|value| value.as_str()).map(str::to_string),
        has_prototype: object.get("hasPrototype").and_then(|value| value.as_bool()).unwrap_or(false),
        generated_by: object.get("generatedBy").and_then(parse_source).unwrap_or_default(),
        generated_at: object.get("generatedAt").and_then(|value| value.as_i64()).unwrap_or(now),
        generator_task_id: object.get("generatorTaskId").and_then(|value| value.as_str()).map(str::to_string),
        reviewed_at: object.get("reviewedAt").and_then(|value| value.as_i64()),
        review_note: object.get("reviewNote").and_then(|value| value.as_str()).map(str::to_string),
        execute_config: object.get("executeConfig").and_then(normalize_execute_config),
        execute_log: object.get("executeLog").and_then(|value| value.as_str()).map(str::to_string),
        executed_at: object.get("executedAt").and_then(|value| value.as_i64()),
        completed_at: object.get("completedAt").and_then(|value| value.as_i64()),
        session_id: object.get("sessionId").and_then(|value| value.as_str()).map(str::to_string),
        execute_error: object.get("executeError").and_then(|value| value.as_str()).map(str::to_string),
        created_at: object.get("createdAt").and_then(|value| value.as_i64()).unwrap_or(now),
        updated_at: object.get("updatedAt").and_then(|value| value.as_i64()).unwrap_or(now),
        workspace_path: object.get("workspacePath").and_then(|value| value.as_str()).map(str::to_string),
        workspace_name: object.get("workspaceName").and_then(|value| value.as_str()).map(str::to_string),
    })
}

fn normalize_execute_config(raw: &serde_json::Value) -> Option<RequirementExecuteConfig> {
    let object = raw.as_object()?;
    Some(RequirementExecuteConfig {
        scheduled_at: object.get("scheduledAt").and_then(|value| value.as_i64()),
        engine_id: object.get("engineId").and_then(|value| value.as_str()).map(str::to_string),
        work_dir: object.get("workDir").and_then(|value| value.as_str()).map(str::to_string),
    })
}

fn apply_status_side_effects(
    requirement: &mut RequirementItem,
    previous: &RequirementStatus,
    next: &RequirementStatus,
) {
    let now = now_millis();

    if matches!(next, RequirementStatus::Approved | RequirementStatus::Rejected)
        && matches!(previous, RequirementStatus::Draft | RequirementStatus::Pending)
    {
        requirement.reviewed_at = Some(now);
    }

    if matches!(next, RequirementStatus::Executing) && !matches!(previous, RequirementStatus::Executing) {
        requirement.executed_at = Some(now);
    }

    if matches!(next, RequirementStatus::Completed) && !matches!(previous, RequirementStatus::Completed) {
        requirement.completed_at = Some(now);
    }

    if !matches!(next, RequirementStatus::Completed) {
        requirement.completed_at = requirement.completed_at.filter(|_| matches!(next, RequirementStatus::Completed));
    }
}

fn sanitize_tags(tags: Option<Vec<String>>) -> Vec<String> {
    tags.unwrap_or_default()
        .into_iter()
        .map(|item| item.trim().to_string())
        .filter(|item| !item.is_empty())
        .collect()
}

fn sanitize_optional_string(value: Option<String>) -> Option<String> {
    value.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
}

fn sanitize_execute_config(config: RequirementExecuteConfig) -> RequirementExecuteConfig {
    RequirementExecuteConfig {
        scheduled_at: config.scheduled_at,
        engine_id: sanitize_optional_string(config.engine_id),
        work_dir: sanitize_optional_string(config.work_dir),
    }
}

fn parse_status(value: &serde_json::Value) -> Option<RequirementStatus> {
    match value.as_str()? {
        "draft" => Some(RequirementStatus::Draft),
        "pending" => Some(RequirementStatus::Pending),
        "approved" => Some(RequirementStatus::Approved),
        "rejected" => Some(RequirementStatus::Rejected),
        "executing" => Some(RequirementStatus::Executing),
        "completed" => Some(RequirementStatus::Completed),
        "failed" => Some(RequirementStatus::Failed),
        _ => None,
    }
}

fn parse_priority(value: &serde_json::Value) -> Option<RequirementPriority> {
    match value.as_str()? {
        "low" => Some(RequirementPriority::Low),
        "normal" => Some(RequirementPriority::Normal),
        "high" => Some(RequirementPriority::High),
        "urgent" => Some(RequirementPriority::Urgent),
        _ => None,
    }
}

fn parse_source(value: &serde_json::Value) -> Option<RequirementSource> {
    match value.as_str()? {
        "ai" => Some(RequirementSource::Ai),
        "user" => Some(RequirementSource::User),
        _ => None,
    }
}

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-req-{}-{}", name, Uuid::new_v4()))
    }

    #[test]
    fn creates_and_lists_requirements() {
        let config_dir = temp_dir("config");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = UnifiedRequirementRepository::new(config_dir.clone(), Some(workspace.clone()));
        repo.register_workspace().unwrap();

        let created = repo
            .create_requirement(RequirementCreateParams {
                title: "测试需求".to_string(),
                description: "这是一个测试需求".to_string(),
                priority: Some(RequirementPriority::High),
                ..Default::default()
            })
            .unwrap();

        assert!(created.workspace_path.is_some());
        assert_eq!(created.status, RequirementStatus::Pending);

        let ws_reqs = repo.list_requirements(QueryScope::Workspace).unwrap();
        assert_eq!(ws_reqs.len(), 1);

        let all_reqs = repo.list_requirements(QueryScope::All).unwrap();
        assert_eq!(all_reqs.len(), 1);

        let _ = std::fs::remove_dir_all(&config_dir);
        let _ = std::fs::remove_dir_all(&workspace);
    }

    #[test]
    fn saves_and_reads_prototype() {
        let config_dir = temp_dir("prototype");
        std::fs::create_dir_all(&config_dir).unwrap();

        let repo = UnifiedRequirementRepository::new(config_dir.clone(), None);

        let created = repo
            .create_requirement(RequirementCreateParams {
                title: "原型测试".to_string(),
                description: "测试原型保存".to_string(),
                ..Default::default()
            })
            .unwrap();

        let html = "<html><body>Prototype</body></html>";
        let path = repo.save_prototype(&created.id, html).unwrap();
        assert_eq!(path, format!("prototypes/{}.html", created.id));

        let read_html = repo.read_prototype(&path).unwrap();
        assert_eq!(read_html, html);

        let _ = std::fs::remove_dir_all(&config_dir);
    }
}
