//! Plugin state commands for Tauri IPC.

#[cfg(feature = "tauri-app")]
use tauri::AppHandle;

use crate::error::Result;
use crate::models::plugin_state::PluginStateMap;
use crate::services::plugin_state_service::PluginStateService;

#[cfg(feature = "tauri-app")]
fn make_service(_app: &AppHandle) -> Result<PluginStateService> {
    // 统一到数据存储根（DataRoot），与 MCP 端 plugin_state 读取一致
    let config_dir = crate::services::data_root::data_root().config_dir();
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
