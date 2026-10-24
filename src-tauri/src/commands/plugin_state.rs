//! Plugin state commands for Tauri IPC.

#[cfg(feature = "tauri-app")]
use tauri::AppHandle;
#[cfg(feature = "tauri-app")]
use tauri::Manager;

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
    let config_dir = crate::services::data_root::data_root().config_dir();
    let service = PluginStateService::new(config_dir.clone());
    service.save(&states)?;

    // 后端统一感知：diff 旧状态 → 广播 plugin.lifecycle(state_changed)
    let broadcaster = {
        // AppState 经 once_cell 从 app.state() 取事件广播器（与 Web ipc 同源 channel）
        use tauri::State;
        let state_guard: State<'_, crate::state::AppState> = app.state();
        state_guard.inner().event_broadcast.clone()
    };
    let _overview = crate::services::plugin_events::handle_plugin_state_change(
        &config_dir,
        &states,
        &broadcaster,
    );

    // P2-d：启停切换 → 插件 cap 贡献增量同步（幂等全量重算）
    if let Some(router) = crate::services::plugin_capability_assembly::router_bus() {
        let discovery =
            crate::services::plugin_service::PluginService::discover_installed_plugins(&config_dir, None);
        crate::services::plugin_capability_assembly::sync_plugin_contributions(
            &router,
            &discovery.plugins,
            &states,
        );
    }

    Ok(())
}
