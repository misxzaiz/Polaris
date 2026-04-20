//! 快捷片段 Tauri 命令

use crate::error::{AppError, Result};
use crate::models::prompt_snippet::{
    CreateSnippetParams, PromptSnippet, UpdateSnippetParams,
};
use crate::services::prompt_snippet_service::PromptSnippetService;
use tauri::{AppHandle, Manager};

fn get_snippet_service(app: &AppHandle) -> Result<PromptSnippetService> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| AppError::ProcessError(format!("获取配置目录失败: {}", e)))?;
    Ok(PromptSnippetService::new(&config_dir))
}

#[tauri::command]
pub async fn snippet_list(app: AppHandle) -> Result<Vec<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.list_all_snippets()
}

#[tauri::command]
pub async fn snippet_get(app: AppHandle, id: String) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.get_snippet(&id)
}

#[tauri::command]
pub async fn snippet_create(app: AppHandle, params: CreateSnippetParams) -> Result<PromptSnippet> {
    let service = get_snippet_service(&app)?;
    service.create_snippet(params)
}

#[tauri::command]
pub async fn snippet_update(
    app: AppHandle,
    id: String,
    params: UpdateSnippetParams,
) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.update_snippet(&id, params)
}

#[tauri::command]
pub async fn snippet_delete(app: AppHandle, id: String) -> Result<bool> {
    let service = get_snippet_service(&app)?;
    service.delete_snippet(&id)
}
