//! Plugin state commands for Tauri IPC.

use crate::error::{AppError, Result};
use crate::models::plugin_state::PluginStateMap;
use crate::services::plugin_state_service::PluginStateService;
use crate::state::AppState;

#[cfg(feature = "tauri-app")]
fn make_service(state: &AppState) -> Result<PluginStateService> {
    let config_dir = state.data_root.lock().unwrap().config_dir();
    Ok(PluginStateService::new(config_dir))
}

/// Load plugin state
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_state_load(
    state: tauri::State<'_, AppState>,
) -> Result<PluginStateMap> {
    make_service(&state)?.load()
}

/// Save plugin state
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_state_save(
    states: PluginStateMap,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    let _ = state; // keep parameter for consistency
    make_service(&state)?.save(&states)
}
