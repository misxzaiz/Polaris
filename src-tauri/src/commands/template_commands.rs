//! Template Tauri Commands
//!
//! Commands for managing document templates.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::task_template::{CreateTemplateParams, TaskTemplate};
use crate::services::template_repository::TemplateRepository;

// ============================================================================
// Helper
// ============================================================================

fn get_config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))
}

fn get_repository(app: &AppHandle) -> Result<TemplateRepository> {
    let config_dir = get_config_dir(app)?;
    Ok(TemplateRepository::new(config_dir))
}

// ============================================================================
// Template CRUD Commands
// ============================================================================

/// 列出所有模板（包含内置和自定义）
#[tauri::command]
pub async fn template_list(app: AppHandle) -> Result<Vec<TaskTemplate>> {
    let repository = get_repository(&app)?;
    repository.list_templates()
}

/// 获取单个模板
#[tauri::command]
pub async fn template_get(id: String, app: AppHandle) -> Result<Option<TaskTemplate>> {
    let repository = get_repository(&app)?;
    repository.get_template(&id)
}

/// 创建自定义模板
#[tauri::command]
pub async fn template_create(
    params: CreateTemplateParams,
    app: AppHandle,
) -> Result<TaskTemplate> {
    let repository = get_repository(&app)?;
    repository.create_template(params)
}

/// 更新自定义模板
#[tauri::command]
pub async fn template_update(
    id: String,
    params: CreateTemplateParams,
    app: AppHandle,
) -> Result<TaskTemplate> {
    let repository = get_repository(&app)?;
    repository.update_template(&id, params)
}

/// 删除自定义模板
#[tauri::command]
pub async fn template_delete(id: String, app: AppHandle) -> Result<()> {
    let repository = get_repository(&app)?;
    repository.delete_template(&id)
}

/// 复制模板（从内置模板创建自定义副本）
#[tauri::command]
pub async fn template_duplicate(
    id: String,
    new_name: String,
    app: AppHandle,
) -> Result<TaskTemplate> {
    let repository = get_repository(&app)?;
    repository.duplicate_template(&id, &new_name)
}

/// 导出模板
#[tauri::command]
pub async fn template_export(id: String, app: AppHandle) -> Result<String> {
    let repository = get_repository(&app)?;
    repository.export_template(&id)
}

/// 导入模板
#[tauri::command]
pub async fn template_import(json: String, app: AppHandle) -> Result<TaskTemplate> {
    let repository = get_repository(&app)?;
    repository.import_template(&json)
}
