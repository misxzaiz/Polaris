//! Executor Tauri Commands
//!
//! Tauri command wrappers for executor operations.
//! The HTTP IPC bridge already provides `execute` and `executor_list` endpoints;
//! these commands expose the same functionality via Tauri IPC for desktop mode.

use crate::error::Result;
use crate::services::executor::{ExecutorParams, ExecutorContext};

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn executor_list(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<(String, String, String)>> {
    Ok(state.executor_registry.list())
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn executor_execute(
    state: tauri::State<'_, crate::AppState>,
    params: ExecutorParams,
) -> Result<crate::services::executor::ExecutorResult> {
    let ctx = ExecutorContext::from_ref(&*state);
    let result = state.executor_registry.execute(params, ctx).await;
    Ok(result)
}