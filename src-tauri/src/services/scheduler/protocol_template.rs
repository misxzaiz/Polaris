//! Protocol Template Service
//!
//! Manages protocol templates for document-driven task workflows.
//! Supports both built-in templates and user-defined custom templates.

use crate::error::{AppError, Result};
use crate::models::scheduler::{
    get_builtin_protocol_templates, CreateProtocolTemplateParams, ProtocolTemplate,
    ProtocolTemplateStore, TaskCategory,
};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

/// Protocol template storage service
pub struct ProtocolTemplateService {
    /// Storage file path
    store_path: PathBuf,
    /// In-memory cache
    cache: Arc<Mutex<Option<ProtocolTemplateStore>>>,
}

impl ProtocolTemplateService {
    /// Create a new template service
    pub fn new(config_dir: &Path) -> Self {
        let store_path = config_dir.join("protocol-templates.json");
        Self {
            store_path,
            cache: Arc::new(Mutex::new(None)),
        }
    }

    /// Load template store from disk
    fn load_store(&self) -> Result<ProtocolTemplateStore> {
        // Check cache first
        if let Some(ref cache) = *self.cache.lock().unwrap() {
            return Ok(cache.clone());
        }

        // Load from file
        let store = if self.store_path.exists() {
            let content = fs::read_to_string(&self.store_path)?;
            serde_json::from_str(&content).unwrap_or_else(|_| ProtocolTemplateStore::default())
        } else {
            ProtocolTemplateStore::default()
        };

        // Update cache
        *self.cache.lock().unwrap() = Some(store.clone());

        Ok(store)
    }

    /// Save template store to disk
    fn save_store(&self, store: &ProtocolTemplateStore) -> Result<()> {
        // Ensure parent directory exists
        if let Some(parent) = self.store_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // Write to file
        let content = serde_json::to_string_pretty(store)?;
        fs::write(&self.store_path, content)?;

        // Update cache
        *self.cache.lock().unwrap() = Some(store.clone());

        Ok(())
    }

    /// Get all templates (built-in + custom)
    pub fn list_templates(&self) -> Result<Vec<ProtocolTemplate>> {
        let store = self.load_store()?;
        let builtins = get_builtin_protocol_templates();
        let mut all = builtins;
        all.extend(store.templates);
        Ok(all)
    }

    /// Get templates by category
    pub fn list_templates_by_category(
        &self,
        category: TaskCategory,
    ) -> Result<Vec<ProtocolTemplate>> {
        let all = self.list_templates()?;
        Ok(all.into_iter().filter(|t| t.category == category).collect())
    }

    /// Get a single template by ID
    pub fn get_template(&self, id: &str) -> Result<Option<ProtocolTemplate>> {
        let all = self.list_templates()?;
        Ok(all.into_iter().find(|t| t.id == id))
    }

    /// Check if a template is built-in
    pub fn is_builtin_template(&self, id: &str) -> bool {
        let builtins = get_builtin_protocol_templates();
        builtins.iter().any(|t| t.id == id)
    }

    /// Create a custom template
    pub fn create_template(
        &self,
        params: CreateProtocolTemplateParams,
    ) -> Result<ProtocolTemplate> {
        // Validate template name
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        // Validate protocol config mission template
        let mission_template = params.protocol_config.mission_template.trim();
        if mission_template.is_empty() {
            return Err(AppError::ValidationError(
                "任务目标模板不能为空".to_string(),
            ));
        }

        let mut store = self.load_store()?;

        // Generate ID
        let now = chrono::Utc::now().timestamp();
        let id = format!("custom-{}", now);

        let template = ProtocolTemplate {
            id: id.clone(),
            name: name.to_string(),
            description: params.description,
            category: params.category,
            builtin: false,
            protocol_config: params.protocol_config,
            prompt_template: params.prompt_template,
            params: params.params,
            default_trigger_type: params.default_trigger_type,
            default_trigger_value: params.default_trigger_value,
            default_engine_id: params.default_engine_id,
            default_max_runs: params.default_max_runs,
            default_timeout_minutes: params.default_timeout_minutes,
            enabled: params.enabled,
            created_at: now,
            updated_at: now,
        };

        store.templates.push(template.clone());
        self.save_store(&store)?;

        Ok(template)
    }

    /// Update a custom template
    pub fn update_template(
        &self,
        id: &str,
        params: CreateProtocolTemplateParams,
    ) -> Result<Option<ProtocolTemplate>> {
        // Cannot update built-in templates
        if self.is_builtin_template(id) {
            return Err(AppError::template_error(id, "内置模板不能修改"));
        }

        // Validate template name
        let name = params.name.trim();
        if name.is_empty() {
            return Err(AppError::ValidationError("模板名称不能为空".to_string()));
        }

        // Validate protocol config mission template
        let mission_template = params.protocol_config.mission_template.trim();
        if mission_template.is_empty() {
            return Err(AppError::ValidationError(
                "任务目标模板不能为空".to_string(),
            ));
        }

        let mut store = self.load_store()?;
        let now = chrono::Utc::now().timestamp();

        if let Some(template) = store.templates.iter_mut().find(|t| t.id == id) {
            template.name = name.to_string();
            template.description = params.description;
            template.category = params.category;
            template.protocol_config = params.protocol_config;
            template.prompt_template = params.prompt_template;
            template.params = params.params;
            template.default_trigger_type = params.default_trigger_type;
            template.default_trigger_value = params.default_trigger_value;
            template.default_engine_id = params.default_engine_id;
            template.default_max_runs = params.default_max_runs;
            template.default_timeout_minutes = params.default_timeout_minutes;
            template.updated_at = now;

            let updated = template.clone();
            self.save_store(&store)?;
            Ok(Some(updated))
        } else {
            Err(AppError::template_error(id, "模板不存在"))
        }
    }

    /// Delete a custom template
    pub fn delete_template(&self, id: &str) -> Result<bool> {
        // Cannot delete built-in templates
        if self.is_builtin_template(id) {
            return Err(AppError::template_error(id, "内置模板不能删除"));
        }

        let mut store = self.load_store()?;
        let original_len = store.templates.len();
        store.templates.retain(|t| t.id != id);

        if store.templates.len() < original_len {
            self.save_store(&store)?;
            Ok(true)
        } else {
            Err(AppError::template_error(id, "模板不存在"))
        }
    }

    /// Toggle template enabled state
    pub fn toggle_template(&self, id: &str, enabled: bool) -> Result<Option<ProtocolTemplate>> {
        // Built-in templates cannot be disabled (they're always enabled)
        if self.is_builtin_template(id) {
            if enabled {
                let builtins = get_builtin_protocol_templates();
                return Ok(builtins.into_iter().find(|t| t.id == id));
            } else {
                return Err(AppError::template_error(id, "内置模板不能禁用"));
            }
        }

        let mut store = self.load_store()?;
        let now = chrono::Utc::now().timestamp();

        if let Some(template) = store.templates.iter_mut().find(|t| t.id == id) {
            template.enabled = enabled;
            template.updated_at = now;

            let updated = template.clone();
            self.save_store(&store)?;
            Ok(Some(updated))
        } else {
            Err(AppError::template_error(id, "模板不存在"))
        }
    }

    /// Clear cache (useful for testing or forced reload)
    pub fn clear_cache(&self) {
        *self.cache.lock().unwrap() = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::scheduler::{
        ProtocolTemplateConfig, TemplateParam, TemplateParamType, TriggerType,
    };
    use tempfile::TempDir;

    fn temp_config_dir() -> (TempDir, PathBuf) {
        let temp_dir = TempDir::new().unwrap();
        let config_dir = temp_dir.path().to_path_buf();
        (temp_dir, config_dir)
    }

    fn create_test_params() -> CreateProtocolTemplateParams {
        CreateProtocolTemplateParams {
            name: "测试模板".to_string(),
            description: Some("测试描述".to_string()),
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "任务目标: {{task}}".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: Some("测试提示词模板".to_string()),
            params: vec![TemplateParam {
                key: "param1".to_string(),
                label: "参数1".to_string(),
                param_type: TemplateParamType::Text,
                required: false,
                default_value: None,
                placeholder: None,
                options: None,
            }],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        }
    }

    #[test]
    fn creates_custom_template() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        let params = create_test_params();
        let template = service.create_template(params).unwrap();
        assert_eq!(template.name, "测试模板");
        assert!(!template.builtin);
        assert!(template.id.starts_with("custom-"));

        // Verify template is persisted
        let all = service.list_templates().unwrap();
        let found = all.iter().find(|t| t.id == template.id);
        assert!(found.is_some());
    }

    #[test]
    fn lists_builtin_templates() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        let templates = service.list_templates().unwrap();
        // Should have at least 5 built-in templates
        let builtins: Vec<_> = templates.iter().filter(|t| t.builtin).collect();
        assert!(builtins.len() >= 5);

        // Verify built-in template IDs
        let ids: Vec<&str> = builtins.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&"dev-feature"));
        assert!(ids.contains(&"protocol-assist"));
        assert!(ids.contains(&"review-code"));
        assert!(ids.contains(&"news-search"));
        assert!(ids.contains(&"monitor-service"));
    }

    #[test]
    fn filters_by_category() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        let dev_templates = service
            .list_templates_by_category(TaskCategory::Development)
            .unwrap();
        assert!(dev_templates.iter().any(|t| t.id == "dev-feature"));

        let review_templates = service
            .list_templates_by_category(TaskCategory::Review)
            .unwrap();
        assert!(review_templates.iter().any(|t| t.id == "review-code"));
    }

    #[test]
    fn cannot_update_builtin_template() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        let params = CreateProtocolTemplateParams {
            name: "修改内置模板".to_string(),
            description: None,
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "测试任务目标".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        };

        let result = service.update_template("dev-feature", params);
        // Should return error for built-in template
        assert!(result.is_err());
    }

    #[test]
    fn cannot_delete_builtin_template() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        let result = service.delete_template("dev-feature");
        // Should return error for built-in template
        assert!(result.is_err());
    }

    #[test]
    fn updates_custom_template() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        // Create a template
        let create_params = CreateProtocolTemplateParams {
            name: "原始名称".to_string(),
            description: None,
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "任务目标: {{task}}".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        };
        let created = service.create_template(create_params).unwrap();

        // Update the template
        let update_params = CreateProtocolTemplateParams {
            name: "更新后的名称".to_string(),
            description: Some("更新描述".to_string()),
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "更新后的任务目标: {{task}}".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("2h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        };

        let updated = service.update_template(&created.id, update_params).unwrap();
        assert!(updated.is_some());
        assert_eq!(updated.unwrap().name, "更新后的名称");
    }

    #[test]
    fn deletes_custom_template() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        // Create a template
        let params = CreateProtocolTemplateParams {
            name: "待删除模板".to_string(),
            description: None,
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "任务目标: {{task}}".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        };
        let created = service.create_template(params).unwrap();

        // Delete the template
        let result = service.delete_template(&created.id);
        assert!(result.unwrap());

        // Verify it's deleted
        let found = service.get_template(&created.id).unwrap();
        assert!(found.is_none());
    }

    #[test]
    fn toggles_template_enabled_state() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        // Create a template
        let params = CreateProtocolTemplateParams {
            name: "测试模板".to_string(),
            description: None,
            category: TaskCategory::Development,
            protocol_config: ProtocolTemplateConfig {
                mission_template: "任务目标: {{task}}".to_string(),
                execution_rules: None,
                memory_rules: None,
                custom_sections: None,
            },
            prompt_template: None,
            params: vec![],
            default_trigger_type: Some(TriggerType::Interval),
            default_trigger_value: Some("1h".to_string()),
            default_engine_id: Some("claude-code".to_string()),
            default_max_runs: None,
            default_timeout_minutes: None,
            enabled: true,
        };
        let created = service.create_template(params).unwrap();
        assert!(created.enabled);

        // Disable the template
        let disabled = service.toggle_template(&created.id, false).unwrap();
        assert!(disabled.is_some());
        assert!(!disabled.unwrap().enabled);

        // Enable again
        let enabled = service.toggle_template(&created.id, true).unwrap();
        assert!(enabled.is_some());
        assert!(enabled.unwrap().enabled);
    }

    #[test]
    fn caches_templates() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        // First load - reads from file (or creates default)
        let _ = service.list_templates().unwrap();

        // Second load - should use cache
        let _ = service.list_templates().unwrap();

        // Clear cache
        service.clear_cache();

        // Third load - reads from file again
        let _ = service.list_templates().unwrap();
    }

    #[test]
    fn builtin_template_is_always_enabled() {
        let (_temp_dir, config_dir) = temp_config_dir();
        let service = ProtocolTemplateService::new(&config_dir);

        // Try to disable a built-in template - should return error
        let result = service.toggle_template("dev-feature", false);
        assert!(result.is_err());
    }
}
