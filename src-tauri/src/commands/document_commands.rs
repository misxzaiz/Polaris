//! Document Workspace Tauri Commands
//!
//! Commands for managing task document workspaces.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use crate::error::Result;
use crate::models::document_workspace::{
    CreateWorkspaceParams, DocumentWorkspace, RenderResult, VariableInstance, WorkspaceDocument,
};
use crate::models::task_template::TaskTemplate;
use crate::services::document_workspace_repository::DocumentWorkspaceRepository;
use crate::services::template_repository::TemplateRepository;

// ============================================================================
// Helper
// ============================================================================

fn get_config_dir(app: &AppHandle) -> Result<PathBuf> {
    app.path()
        .app_config_dir()
        .map_err(|e| crate::error::AppError::ProcessError(format!("获取配置目录失败: {}", e)))
}

fn get_workspace_repository(app: &AppHandle) -> Result<DocumentWorkspaceRepository> {
    let config_dir = get_config_dir(app)?;
    Ok(DocumentWorkspaceRepository::new(config_dir))
}

fn get_template_repository(app: &AppHandle) -> Result<TemplateRepository> {
    let config_dir = get_config_dir(app)?;
    Ok(TemplateRepository::new(config_dir))
}

// ============================================================================
// Workspace Commands
// ============================================================================

/// 获取任务的文档工作区
#[tauri::command]
pub async fn document_get_workspace(
    task_id: String,
    app: AppHandle,
) -> Result<Option<DocumentWorkspace>> {
    let repository = get_workspace_repository(&app)?;
    repository.get_workspace(&task_id)
}

/// 创建文档工作区
#[tauri::command]
pub async fn document_create_workspace(
    params: CreateWorkspaceParams,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let workspace_repo = get_workspace_repository(&app)?;

    // Load template if specified
    let template: Option<TaskTemplate> = if let Some(template_id) = &params.template_id {
        let template_repo = get_template_repository(&app)?;
        template_repo.get_template(template_id)?
    } else {
        None
    };

    workspace_repo.create_workspace(params, template.as_ref())
}

/// 更新文档工作区
#[tauri::command]
pub async fn document_update_workspace(
    task_id: String,
    documents: Option<Vec<WorkspaceDocument>>,
    variables: Option<Vec<VariableInstance>>,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let repository = get_workspace_repository(&app)?;
    repository.update_workspace(&task_id, documents, variables)
}

/// 删除文档工作区
#[tauri::command]
pub async fn document_delete_workspace(task_id: String, app: AppHandle) -> Result<()> {
    let repository = get_workspace_repository(&app)?;
    repository.delete_workspace(&task_id)
}

// ============================================================================
// Document Commands
// ============================================================================

/// 渲染文档（变量替换）
#[tauri::command]
pub async fn document_render(
    task_id: String,
    task_name: String,
    workspace_path: Option<String>,
    workspace_name: Option<String>,
    run_count: usize,
    last_run_time: Option<i64>,
    app: AppHandle,
) -> Result<RenderResult> {
    let repository = get_workspace_repository(&app)?;
    repository.render_documents(
        &task_id,
        &task_name,
        workspace_path.as_deref(),
        workspace_name.as_deref(),
        run_count,
        last_run_time,
    )
}

/// 更新单个文档
#[tauri::command]
pub async fn document_update(
    task_id: String,
    filename: String,
    content: String,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let repository = get_workspace_repository(&app)?;
    repository.update_document(&task_id, &filename, &content)
}

/// 添加用户补充
#[tauri::command]
pub async fn document_add_user_supplement(
    task_id: String,
    content: String,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let repository = get_workspace_repository(&app)?;
    repository.append_to_user_document(&task_id, &content)
}

/// 归档用户补充
#[tauri::command]
pub async fn document_archive_user_supplement(
    task_id: String,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let repository = get_workspace_repository(&app)?;
    repository.archive_user_document(&task_id)
}

/// 记录执行摘要
#[tauri::command]
pub async fn document_record_execution(
    task_id: String,
    status: String,
    duration: Option<f64>,
    summary: Option<String>,
    app: AppHandle,
) -> Result<DocumentWorkspace> {
    let repository = get_workspace_repository(&app)?;
    repository.add_execution_summary(&task_id, &status, duration, summary.as_deref())
}
