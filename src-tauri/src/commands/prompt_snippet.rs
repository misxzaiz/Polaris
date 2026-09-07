//! 快捷片段 Tauri 命令

use crate::error::Result;
use crate::models::prompt_snippet::{
    CreateSnippetParams, PromptSnippet, UpdateSnippetParams,
};
use crate::services::prompt_snippet_service::PromptSnippetService;
#[cfg(feature = "tauri-app")]
use tauri::AppHandle;

#[cfg(feature = "tauri-app")]
fn get_snippet_service(_app: &AppHandle) -> Result<PromptSnippetService> {
    // 统一到数据存储根（DataRoot），与 ConfigStore 一致
    let config_dir = crate::services::data_root::data_root().config_dir();
    Ok(PromptSnippetService::new(&config_dir))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_list(app: AppHandle) -> Result<Vec<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.list_all_snippets()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_get(app: AppHandle, id: String) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.get_snippet(&id)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_create(app: AppHandle, params: CreateSnippetParams) -> Result<PromptSnippet> {
    let service = get_snippet_service(&app)?;
    service.create_snippet(params)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_update(
    app: AppHandle,
    id: String,
    params: UpdateSnippetParams,
) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&app)?;
    service.update_snippet(&id, params)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_delete(app: AppHandle, id: String) -> Result<bool> {
    let service = get_snippet_service(&app)?;
    service.delete_snippet(&id)
}
