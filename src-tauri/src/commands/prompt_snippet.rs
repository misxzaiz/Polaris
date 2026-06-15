//! 快捷片段 Tauri 命令

use crate::error::{AppError, Result};
use crate::models::prompt_snippet::{
    CreateSnippetParams, PromptSnippet, UpdateSnippetParams,
};
use crate::services::prompt_snippet_service::PromptSnippetService;
use crate::state::AppState;

#[cfg(feature = "tauri-app")]
fn get_snippet_service(state: &AppState) -> Result<PromptSnippetService> {
    let config_dir = state.data_root.lock().unwrap().config_dir();
    Ok(PromptSnippetService::new(&config_dir))
}

/// List all snippets
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_list(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<PromptSnippet>> {
    let service = get_snippet_service(&state)?;
    service.list_all_snippets()
}

/// Get a single snippet
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_get(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&state)?;
    service.get_snippet(&id)
}

/// Create a snippet
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_create(
    params: CreateSnippetParams,
    state: tauri::State<'_, AppState>,
) -> Result<PromptSnippet> {
    let service = get_snippet_service(&state)?;
    service.create_snippet(params)
}

/// Update a snippet
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_update(
    id: String,
    params: UpdateSnippetParams,
    state: tauri::State<'_, AppState>,
) -> Result<Option<PromptSnippet>> {
    let service = get_snippet_service(&state)?;
    service.update_snippet(&id, params)
}

/// Delete a snippet
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn snippet_delete(
    id: String,
    state: tauri::State<'_, AppState>,
) -> Result<bool> {
    let service = get_snippet_service(&state)?;
    service.delete_snippet(&id)
}
