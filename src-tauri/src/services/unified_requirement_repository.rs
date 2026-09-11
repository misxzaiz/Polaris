//! Unified Requirement Repository（SqliteStorage 后端）
//!
//! 保持公开 API（`new(config_dir, workspace)` + list/get/create/update/delete +
//! register_workspace + save_prototype/read_prototype + get_workspace_breakdown）不变，
//! 命令层零改动。
//!
//! 存储后端：契约 `Storage::SqliteStorage`（domain=`requirement`）。每个 `RequirementItem`
//! 是一条 `Item { id: req.id, data: RequirementItem 的 camelCase JSON }`，存于
//! `<config_dir>/stores/requirement.db` 的 `items` 表（SqliteStorage 以传入 config_dir
//! 为 data_root，在其下建 stores/）。
//!
//! 关键设计（裁决3：blob 落盘 + 存引用路径）：
//! - requirement 元数据（含 executeConfig 等嵌套）→ SQLite `items` 表。
//! - 原型 HTML 属于大 blob，不入 SQLite 单表 `data TEXT`，继续落盘到
//!   `<config_dir>/requirements/prototypes/<id>.html`，SQLite 只存 `prototypePath` 引用。
//! - `workspaces.json` 注册逻辑保留原实现。
//! - workspace 过滤保留原内存过滤语义。

use crate::contracts::{Id as ContractId, Item as ContractItem, Query as ContractQuery, Storage};
use crate::error::{AppError, Result};
use crate::models::requirement::{
    QueryScope, RequirementCreateParams, RequirementExecuteConfig, RequirementItem,
    RequirementSource, RequirementStatus, RequirementUpdateParams,
};
use crate::services::storage::SqliteStorage;
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use uuid::Uuid;

const REQUIREMENTS_FILE_VERSION: &str = "1.0.0";
const PROTOTYPES_DIR_NAME: &str = "prototypes";
const WORKSPACES_FILE_NAME: &str = "workspaces.json";

/// Unified repository for managing requirements in a single global storage
pub struct UnifiedRequirementRepository {
    /// 全局存储目录（config_dir/requirements）——保留字段以维持原型落盘与 workspaces.json 落点
    storage_dir: PathBuf,
    /// Prototypes directory（blob 落盘目录，不入 SQLite）
    prototypes_dir: PathBuf,
    /// 契约 Storage 抽象（当前实现 SqliteStorage，domain=requirement）
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

impl UnifiedRequirementRepository {
    /// Create a new unified requirement repository
    ///
    /// # Arguments
    /// * `config_dir` - 应用配置根（命令层传 app_config_dir / MCP 传外部显式路径）。
    ///   SqliteStorage 以它为 data_root，在其下建 `stores/requirement.db`；
    ///   原型 HTML 落盘到 `<config_dir>/requirements/prototypes/`。
    ///   保持此参数语义不变 → 命令层零改动。
    /// * `current_workspace` - Current workspace path (optional, for filtering)
    pub fn new(config_dir: PathBuf, current_workspace: Option<PathBuf>) -> Self {
        let current_workspace_name = current_workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());

        let storage_dir = config_dir.join("requirements");
        let prototypes_dir = storage_dir.join(PROTOTYPES_DIR_NAME);

        // 存储根：尊重调用方传入的 config_dir 作为 data_root（SqliteStorage 内部建 stores/）。
        // 不在此处调 data_root()——MCP 独立进程可能未初始化全局 DataRoot，会 panic。
        let storage: Box<dyn Storage> = Box::new(
            SqliteStorage::new(&config_dir)
                .expect("SqliteStorage 初始化失败（config_dir 不可用）"),
        );

        Self {
            storage_dir,
            prototypes_dir,
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
        let all_requirements = self.read_all_requirements()?;

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
        let item = self.storage.load("requirement", &ContractId(id.to_string()));
        match item {
            Ok(item) => {
                let req: RequirementItem = serde_json::from_value(item.data)
                    .map_err(|e| AppError::ValidationError(format!("反序列化需求失败: {}", e)))?;
                Ok(Some(req))
            }
            Err(_) => Ok(None),
        }
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

        // 同名标题校验（保留原语义）
        if self
            .read_all_requirements()?
            .iter()
            .any(|item| item.title.trim() == title)
        {
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

        self.insert_item(&item)?;
        Ok(item)
    }

    /// Update a requirement
    pub fn update_requirement(&self, id: &str, updates: RequirementUpdateParams) -> Result<RequirementItem> {
        let mut requirement = self
            .get_requirement(id)?
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
            apply_status_side_effects(&mut requirement, &previous, &status);
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
        self.insert_item(&requirement)?;
        Ok(result)
    }

    /// Delete a requirement
    pub fn delete_requirement(&self, id: &str) -> Result<RequirementItem> {
        let requirement = self
            .get_requirement(id)?
            .ok_or_else(|| AppError::ValidationError(format!("需求不存在: {}", id)))?;

        self.storage
            .delete("requirement", &ContractId(id.to_string()))
            .map_err(|e| AppError::ValidationError(format!("删除失败: {}", e)))?;

        // Also delete prototype file if exists
        if let Some(prototype_path) = &requirement.prototype_path {
            let full_path = self.storage_dir.join(prototype_path);
            if full_path.exists() {
                let _ = std::fs::remove_file(&full_path);
            }
        }

        Ok(requirement)
    }

    /// Save prototype HTML（blob 落盘，不入 SQLite）
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
        let requirements = self.read_all_requirements()?;
        let mut breakdown = BTreeMap::new();

        for req in requirements {
            let key = req.workspace_name.clone().unwrap_or_else(|| "全局".to_string());
            *breakdown.entry(key).or_insert(0) += 1;
        }

        Ok(breakdown)
    }

    // =========================================================================
    // Private helpers（SqliteStorage 后端）
    // =========================================================================

    /// 读全部 requirement（domain=requirement 的 items 全表）
    fn read_all_requirements(&self) -> Result<Vec<RequirementItem>> {
        let items = self
            .storage
            .query("requirement", &ContractQuery { filter: serde_json::json!({}), limit: None })
            .map_err(|e| AppError::ValidationError(format!("读取需求失败: {}", e)))?;

        let mut requirements = Vec::with_capacity(items.len());
        for item in items {
            if let Ok(req) = serde_json::from_value::<RequirementItem>(item.data) {
                requirements.push(req);
            }
        }
        Ok(requirements)
    }

    /// 写入 / 更新一个 requirement 项（INSERT OR REPLACE）
    fn insert_item(&self, requirement: &RequirementItem) -> Result<()> {
        let data = serde_json::to_value(requirement)
            .map_err(|e| AppError::ValidationError(format!("序列化需求失败: {}", e)))?;
        self.storage
            .store(
                "requirement",
                &ContractItem {
                    id: ContractId(requirement.id.clone()),
                    data,
                },
            )
            .map_err(|e| AppError::ValidationError(format!("写入失败: {}", e)))?;
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
// Helper functions（保留原 sanitize / normalize / side effects 逻辑）
// =========================================================================

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

fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::requirement::RequirementPriority;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-req-{}-{}", name, Uuid::new_v4()))
    }

    /// 测试构造：直接注入临时 config_dir 作 data_root（避开全局 data_root()）
    fn make_repo(workspace: Option<PathBuf>) -> UnifiedRequirementRepository {
        let config_dir = temp_dir("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let current_workspace_name = workspace
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .map(|s| s.to_string());
        UnifiedRequirementRepository {
            storage_dir: config_dir.join("requirements"),
            prototypes_dir: config_dir.join("requirements").join(PROTOTYPES_DIR_NAME),
            storage: Box::new(SqliteStorage::new(&config_dir).unwrap()),
            current_workspace: workspace,
            current_workspace_name,
        }
    }

    #[test]
    fn creates_and_lists_requirements() {
        let _tmp = temp_dir("list");
        let workspace = temp_dir("workspace");
        std::fs::create_dir_all(&workspace).unwrap();

        let repo = make_repo(Some(workspace.clone()));
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
    }

    #[test]
    fn rejects_duplicate_title() {
        let _tmp = temp_dir("dup");
        let repo = make_repo(None);

        repo.create_requirement(RequirementCreateParams {
            title: "唯一标题".to_string(),
            description: "描述".to_string(),
            ..Default::default()
        })
        .unwrap();

        let err = repo
            .create_requirement(RequirementCreateParams {
                title: "唯一标题".to_string(),
                description: "另一个描述".to_string(),
                ..Default::default()
            })
            .unwrap_err();
        assert!(err.to_string().contains("同名"));
    }

    #[test]
    fn saves_and_reads_prototype() {
        let _tmp = temp_dir("prototype");
        let repo = make_repo(None);

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

        // 原型落盘目录存在
        assert!(repo.prototypes_dir.join(format!("{}.html", created.id)).exists());
    }

    #[test]
    fn status_side_effects_apply() {
        let _tmp = temp_dir("status");
        let repo = make_repo(None);

        let created = repo
            .create_requirement(RequirementCreateParams {
                title: "状态测试".to_string(),
                description: "描述".to_string(),
                ..Default::default()
            })
            .unwrap();

        // Ai 生成 → Pending；approve → 副作用置 reviewed_at
        let approved = repo
            .update_requirement(
                &created.id,
                RequirementUpdateParams {
                    status: Some(RequirementStatus::Approved),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(approved.reviewed_at.is_some());

        // complete → completed_at
        let completed = repo
            .update_requirement(
                &created.id,
                RequirementUpdateParams {
                    status: Some(RequirementStatus::Completed),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(completed.completed_at.is_some());
    }
}