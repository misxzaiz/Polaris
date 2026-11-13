//! Plugin state commands for Tauri IPC.

#[cfg(feature = "tauri-app")]
use tauri::AppHandle;
#[cfg(feature = "tauri-app")]
use tauri::Manager;

use crate::error::Result;
use crate::models::plugin_state::PluginStateMap;
#[cfg(feature = "tauri-app")]
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
    // 后端统一感知：保存 + diff 旧状态广播 plugin.lifecycle(state_changed) + cap 贡献
    // 同步——保存核已抽到 save_states_with_events（与 cap.pluginState set_states 共享，
    // 插件管理中心 P0），此命令只负责取 broadcaster 后委托，杜绝双写路径漂移。
    let broadcaster = {
        // AppState 经 once_cell 从 app.state() 取事件广播器（与 Web ipc 同源 channel）
        use tauri::State;
        let state_guard: State<'_, crate::state::AppState> = app.state();
        state_guard.inner().event_broadcast.clone()
    };
    let _overview = crate::services::router::save_states_with_events(
        &config_dir,
        &states,
        &broadcaster,
    );
    Ok(())
}
