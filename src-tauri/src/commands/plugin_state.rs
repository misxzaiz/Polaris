//! Plugin state commands for Tauri IPC.

#[cfg(feature = "tauri-app")]
use tauri::{AppHandle, Manager};

use crate::error::{AppError, Result};
use crate::models::plugin_state::PluginStateMap;
use crate::services::plugin_state_service::PluginStateService;

#[cfg(feature = "tauri-app")]
fn make_service(app: &AppHandle) -> Result<PluginStateService> {
    let config_dir = app.path().app_config_dir().map_err(|e| {
        AppError::ProcessError(format!("Failed to get app config directory: {}", e))
    })?;

    Ok(PluginStateService::new(config_dir))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_state_load(app: AppHandle) -> Result<PluginStateMap> {
    make_service(&app)?.load()
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_state_save(app: AppHandle, states: PluginStateMap) -> Result<()> {
    make_service(&app)?.save(&states)
}
