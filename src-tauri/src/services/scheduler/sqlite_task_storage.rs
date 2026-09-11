//! Sqlite Task Storage（契约 `Storage` 后端）
//!
//! 实现 `TaskStorage` trait 的 SQLite 变体：底层委托契约 `Storage`（SqliteStorage，
//! domain=`scheduler`）。与 `LocalFileStorage` 并存，作为双轨裁决2的可选后端。
//!
//! # 键空间
//!
//! 一个 `stores/scheduler.db` 承载三类实体，用 domain 内复合 key 区分：
//! - `task/<id>`      → 任务（ScheduledTask）
//! - `tmpl/<id>`      → 模板（PromptTemplate）
//! - `ws/<path>`      → 工作区注册（WorkspaceInfo）
//!
//! # 设计
//!
//! - 任务/模板/工作区各自独立 key 空间，避免冲突。
//! - 复用契约 `store/load/query/delete`；枚举式读全表用空 filter 全扫描。
//! - 领域逻辑（trigger 校验、next_run 计算、模板 apply）与 `LocalFileStorage`
//!   对齐，不走契约 `Storage`——契约只管持久化。

use crate::contracts::{Id as ContractId, Item as ContractItem, Query as ContractQuery, Storage};
use crate::error::{AppError, Result};
use crate::models::scheduler::{
    apply_template, CreateTaskParams, CreateTemplateParams, PromptTemplate, ScheduledTask, TaskCategory,
    TaskMode, TaskStatus, TriggerType,
};
use crate::services::scheduler::storage::{TaskStorage, TaskUpdateParams, WorkspaceInfo};
use crate::services::storage::SqliteStorage;
use chrono::Utc;
use std::collections::BTreeMap;
use std::path::PathBuf;
use uuid::Uuid;

/// 域内 key 前缀（避免任务/模板/工作区冲突）
const KEY_TASK: &str = "task/";
const KEY_TEMPLATE: &str = "tmpl/";
const KEY_WORKSPACE: &str = "ws/";

/// 基于契约 `Storage`（SqliteStorage）的任务存储
pub struct SqliteTaskStorage {
    /// 契约 Storage 抽象（SqliteStorage，domain=scheduler）
    storage: Box<dyn Storage>,
}

impl SqliteTaskStorage {
    /// Create a new sqlite task storage with the given config dir as data_root
    ///
    /// # Arguments
    /// * `config_dir` - 应用配置根；SqliteStorage 以它为 data_root，在其下建
    ///   `stores/scheduler.db`。不在此处调 data_root()——MCP 独立进程可能未初始化
    ///   全局 DataRoot。
    pub fn new(config_dir: PathBuf) -> Result<Self> {
        let storage: Box<dyn Storage> = Box::new(
            SqliteStorage::new(&config_dir)
                .map_err(|e| AppError::ValidationError(format!("SqliteStorage 初始化失败: {}", e)))?,
        );
        Ok(Self { storage })
    }

    // =====================================================================
    // 私有 helper：key 构造 / 反序列化
    // =====================================================================

    fn deserialize<T: serde::de::DeserializeOwned>(value: serde_json::Value) -> Result<T> {
        serde_json::from_value(value)
            .map_err(|e| AppError::ValidationError(format!("反序列化失败: {}", e)))
    }

    fn read_all_by_prefix<T: serde::de::DeserializeOwned>(&self, prefix: &str) -> Result<Vec<T>> {
        let items = self
            .storage
            .query("scheduler", &ContractQuery { filter: serde_json::json!({}), limit: None })
            .map_err(|e| AppError::ValidationError(format!("读取失败: {}", e)))?;

        Ok(items
            .into_iter()
            .filter(|item| item.id.0.starts_with(prefix))
            .filter_map(|item| serde_json::from_value::<T>(item.data).ok())
            .collect())
    }
}

impl TaskStorage for SqliteTaskStorage {
    // =========================================================================
    // Task Operations
    // =========================================================================

    fn list_tasks(&self, workspace_path: Option<&str>) -> Result<Vec<ScheduledTask>> {
        let all = self.read_all_by_prefix::<ScheduledTask>(KEY_TASK)?;
        Ok(if let Some(workspace) = workspace_path {
            all.into_iter()
                .filter(|task| task.workspace_path.as_deref() == Some(workspace))
                .collect()
        } else {
            all
        })
    }

    fn get_task(&self, id: &str) -> Result<Option<ScheduledTask>> {
        let item = self.storage.load("scheduler", &ContractId(format!("{}{}", KEY_TASK, id)));
        match item {
            Ok(item) => Ok(Some(Self::deserialize::<ScheduledTask>(item.data)?)),
            Err(_) => Ok(None),
        }
    }

    fn create_task(&self, params: CreateTaskParams, workspace_path: Option<String>, workspace_name: Option<String>) -> Result<ScheduledTask> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("任务名称不能为空".to_string()));
        }

        // Validate trigger value
        if params.trigger_value.trim().is_empty() {
            return Err(AppError::ValidationError("触发表达式不能为空".to_string()));
        }

        // Validate trigger value format
        validate_trigger_value(&params.trigger_type, &params.trigger_value)?;

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
            executor_type: params.executor_type,
            executor_params: params.executor_params,
        };

        insert_task(&*self.storage, &task)?;
        Ok(task)
    }

    fn update_task(&self, id: &str, updates: TaskUpdateParams) -> Result<ScheduledTask> {
        let mut task = self
            .get_task(id)?
            .ok_or_else(|| AppError::task_error(id, "任务不存在"))?;

        if let Some(name) = updates.name.as_ref() {
            let trimmed = name.trim();
            if trimmed.is_empty() {
                return Err(AppError::ValidationError("任务名称不能为空".to_string()));
            }
            task.name = trimmed.to_string();
        }

        if let Some(enabled) = updates.enabled {
            task.enabled = enabled;
        }

        // Validate trigger value if being updated
        if let (Some(trigger_type), Some(trigger_value)) = (&updates.trigger_type, &updates.trigger_value) {
            validate_trigger_value(trigger_type, trigger_value)?;
        }

        if let Some(trigger_type) = updates.trigger_type {
            task.trigger_type = trigger_type;
        }

        if let Some(trigger_value) = updates.trigger_value.as_ref() {
            let trimmed = trigger_value.trim();
            if trimmed.is_empty() {
                return Err(AppError::ValidationError("触发表达式不能为空".to_string()));
            }
            task.trigger_value = trimmed.to_string();
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

        if updates.last_run_status.is_some() {
            task.last_run_status = updates.last_run_status;
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

        if let Some(ref executor_type) = updates.executor_type {
            task.executor_type = executor_type.clone();
        }

        if updates.executor_params.is_some() {
            task.executor_params = updates.executor_params.clone();
        }

        task.updated_at = Utc::now().timestamp();

        // next_run_at 重算规则（与 LocalFileStorage 对齐）
        if updates.next_run_at.is_none() {
            let is_running = task.last_run_status == Some(TaskStatus::Running);
            if task.trigger_type == TriggerType::AfterCompletion && is_running {
                task.next_run_at = None;
            } else {
                task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, task.updated_at);
            }
        }

        let result = task.clone();
        insert_task(&*self.storage, &task)?;
        Ok(result)
    }

    fn delete_task(&self, id: &str) -> Result<ScheduledTask> {
        let task = self
            .get_task(id)?
            .ok_or_else(|| AppError::task_error(id, "任务不存在"))?;

        self.storage
            .delete("scheduler", &ContractId(format!("{}{}", KEY_TASK, id)))
            .map_err(|e| AppError::ValidationError(format!("删除任务失败: {}", e)))?;
        Ok(task)
    }

    fn update_task_status(&self, id: &str, status: TaskStatus) -> Result<ScheduledTask> {
        let mut task = self
            .get_task(id)?
            .ok_or_else(|| AppError::task_error(id, "任务不存在"))?;

        let now = Utc::now().timestamp();
        task.last_run_at = Some(now);
        task.last_run_status = Some(status);

        if task.trigger_type == TriggerType::AfterCompletion && status == TaskStatus::Running {
            task.next_run_at = None;
        } else {
            task.next_run_at = task.trigger_type.calculate_next_run(&task.trigger_value, now);
        }

        let result = task.clone();
        insert_task(&*self.storage, &task)?;
        Ok(result)
    }

    fn toggle_task(&self, id: &str, enabled: bool) -> Result<ScheduledTask> {
        self.update_task(id, TaskUpdateParams {
            enabled: Some(enabled),
            ..Default::default()
        })
    }

    fn get_workspace_breakdown(&self) -> Result<BTreeMap<String, usize>> {
        let tasks = self.list_tasks(None)?;
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
        self.read_all_by_prefix::<PromptTemplate>(KEY_TEMPLATE)
    }

    fn get_template(&self, id: &str) -> Result<Option<PromptTemplate>> {
        let item = self.storage.load("scheduler", &ContractId(format!("{}{}", KEY_TEMPLATE, id)));
        match item {
            Ok(item) => Ok(Some(Self::deserialize::<PromptTemplate>(item.data)?)),
            Err(_) => Ok(None),
        }
    }

    fn create_template(&self, params: CreateTemplateParams) -> Result<PromptTemplate> {
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        // Validate template content
        if params.content.trim().is_empty() {
            return Err(AppError::ValidationError("模板内容不能为空".to_string()));
        }

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

        insert_template(&*self.storage, &template)?;
        Ok(template)
    }

    fn update_template(&self, template: PromptTemplate) -> Result<PromptTemplate> {
        let name = template.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        if template.content.trim().is_empty() {
            return Err(AppError::ValidationError("模板内容不能为空".to_string()));
        }

        let existing = self
            .get_template(&template.id)?
            .ok_or_else(|| AppError::template_error(&template.id, "模板不存在"))?;

        let mut updated = existing;
        updated.name = name.to_string();
        updated.description = template.description;
        updated.content = template.content;
        updated.enabled = template.enabled;
        updated.updated_at = Utc::now().timestamp();

        let result = updated.clone();
        insert_template(&*self.storage, &updated)?;
        Ok(result)
    }

    fn delete_template(&self, id: &str) -> Result<()> {
        self.storage
            .delete("scheduler", &ContractId(format!("{}{}", KEY_TEMPLATE, id)))
            .map_err(|e| AppError::ValidationError(format!("删除模板失败: {}", e)))?;
        Ok(())
    }

    fn toggle_template(&self, id: &str, enabled: bool) -> Result<PromptTemplate> {
        let mut template = self
            .get_template(id)?
            .ok_or_else(|| AppError::template_error(id, "模板不存在"))?;
        template.enabled = enabled;
        template.updated_at = Utc::now().timestamp();
        let result = template.clone();
        insert_template(&*self.storage, &template)?;
        Ok(result)
    }

    fn build_prompt_with_template(&self, template_id: &str, task_name: &str, user_prompt: &str) -> Result<String> {
        let template = self
            .get_template(template_id)?
            .ok_or_else(|| AppError::template_error(template_id, "模板不存在"))?;

        if !template.enabled {
            return Err(AppError::template_error(template_id, "模板已禁用"));
        }

        Ok(apply_template(&template.content, task_name, user_prompt))
    }

    // =========================================================================
    // Workspace Operations
    // =========================================================================

    fn register_workspace(&self, path: &str, name: &str) -> Result<()> {
        let key = format!("{}{}", KEY_WORKSPACE, path);
        let info = WorkspaceInfo {
            path: path.to_string(),
            name: name.to_string(),
            last_accessed_at: now_iso(),
        };
        let data = serde_json::to_value(&info)
            .map_err(|e| AppError::ValidationError(format!("序列化工作区失败: {}", e)))?;
        self.storage
            .store("scheduler", &ContractItem { id: ContractId(key), data })
            .map_err(|e| AppError::ValidationError(format!("注册工作区失败: {}", e)))?;
        Ok(())
    }

    fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
        self.read_all_by_prefix::<WorkspaceInfo>(KEY_WORKSPACE)
    }

    fn unregister_workspace(&self, path: &str) -> Result<()> {
        self.storage
            .delete("scheduler", &ContractId(format!("{}{}", KEY_WORKSPACE, path)))
            .map_err(|e| AppError::ValidationError(format!("注销工作区失败: {}", e)))?;
        Ok(())
    }
}

// =========================================================================
// Helper functions（与 LocalFileStorage 对齐）
// =========================================================================

/// 写入 / 更新一个任务（INSERT OR REPLACE）
fn insert_task(storage: &dyn Storage, task: &ScheduledTask) -> Result<()> {
    let data = serde_json::to_value(task)
        .map_err(|e| AppError::ValidationError(format!("序列化任务失败: {}", e)))?;
    storage
        .store("scheduler", &ContractItem { id: ContractId(format!("{}{}", KEY_TASK, task.id)), data })
        .map_err(|e| AppError::ValidationError(format!("写入任务失败: {}", e)))?;
    Ok(())
}

/// 写入 / 更新一个模板（INSERT OR REPLACE）
fn insert_template(storage: &dyn Storage, template: &PromptTemplate) -> Result<()> {
    let data = serde_json::to_value(template)
        .map_err(|e| AppError::ValidationError(format!("序列化模板失败: {}", e)))?;
    storage
        .store("scheduler", &ContractItem { id: ContractId(format!("{}{}", KEY_TEMPLATE, template.id)), data })
        .map_err(|e| AppError::ValidationError(format!("写入模板失败: {}", e)))?;
    Ok(())
}

/// Validate trigger value based on trigger type
fn validate_trigger_value(trigger_type: &TriggerType, value: &str) -> Result<()> {
    match trigger_type {
        TriggerType::Interval | TriggerType::AfterCompletion => {
            let value = value.trim();
            if value.is_empty() {
                return Err(AppError::ValidationError("间隔时间不能为空".to_string()));
            }

            let num_part: String = value.chars().take_while(|c| c.is_ascii_digit()).collect();
            let unit_part: String = value.chars().skip_while(|c| c.is_ascii_digit()).collect();

            if num_part.is_empty() || unit_part.is_empty() {
                return Err(AppError::ValidationError(
                    "间隔时间格式无效，请使用如 '1h', '30m', '1d' 的格式".to_string()
                ));
            }

            let num: u64 = num_part.parse().map_err(|_| {
                AppError::ValidationError("间隔时间数字部分无效".to_string())
            })?;

            if num == 0 {
                return Err(AppError::ValidationError("间隔时间不能为零".to_string()));
            }

            if !matches!(unit_part.as_str(), "s" | "m" | "h" | "d" | "w") {
                return Err(AppError::ValidationError(
                    "间隔时间单位无效，请使用 s(秒), m(分), h(时), d(天), w(周)".to_string()
                ));
            }
        }
        TriggerType::Cron => {
            let value = value.trim();
            if value.is_empty() {
                return Err(AppError::ValidationError("Cron 表达式不能为空".to_string()));
            }

            let fields: Vec<&str> = value.split_whitespace().collect();
            if fields.len() < 5 || fields.len() > 6 {
                return Err(AppError::ValidationError(
                    "Cron 表达式格式无效，应为 5 或 6 个字段".to_string()
                ));
            }
        }
        TriggerType::Once => {
            let value = value.trim();
            if value.is_empty() {
                return Err(AppError::ValidationError("触发时间不能为空".to_string()));
            }
        }
    }
    Ok(())
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
    use crate::models::scheduler::TriggerType;
    use std::path::PathBuf;

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("polaris-sqlsch-{}-{}", name, Uuid::new_v4()))
    }

    fn make_storage() -> SqliteTaskStorage {
        let config_dir = temp_dir("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        SqliteTaskStorage::new(config_dir).unwrap()
    }

    #[test]
    fn creates_and_lists_tasks() {
        let storage = make_storage();

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
                    ..Default::default()
                },
                Some("/workspace/path".to_string()),
                Some("workspace".to_string()),
            )
            .unwrap();

        assert!(task.workspace_path.is_some());
        assert!(task.next_run_at.is_some());

        let tasks = storage.list_tasks(Some("/workspace/path")).unwrap();
        assert_eq!(tasks.len(), 1);

        let all = storage.list_tasks(None).unwrap();
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn keys_are_namespaced() {
        let storage = make_storage();

        // Create a task, then verify template/workspace key spaces don't collide
        storage
            .create_task(
                CreateTaskParams {
                    name: "任务".to_string(),
                    enabled: true,
                    trigger_type: TriggerType::Interval,
                    trigger_value: "1h".to_string(),
                    engine_id: "test".to_string(),
                    prompt: "test".to_string(),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();

        // No templates, no workspaces
        assert!(storage.list_templates().unwrap().is_empty());
        assert!(storage.list_workspaces().unwrap().is_empty());

        // Tasks present
        assert_eq!(storage.list_tasks(None).unwrap().len(), 1);
    }

    #[test]
    fn manages_templates() {
        let storage = make_storage();

        let created = storage
            .create_template(CreateTemplateParams {
                name: "模板".to_string(),
                description: None,
                content: "内容 {{prompt}}".to_string(),
                enabled: true,
            })
            .unwrap();

        let templates = storage.list_templates().unwrap();
        assert_eq!(templates.len(), 1);

        let prompt = storage.build_prompt_with_template(&created.id, "任务名", "用户提示").unwrap();
        assert!(prompt.contains("用户提示"));

        let toggled = storage.toggle_template(&created.id, false).unwrap();
        assert!(!toggled.enabled);

        storage.delete_template(&created.id).unwrap();
        assert!(storage.list_templates().unwrap().is_empty());
    }

    #[test]
    fn manages_workspaces() {
        let storage = make_storage();

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
    }
}