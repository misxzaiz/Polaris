//! 插件服务 Tauri 命令
//!
//! 提供前端调用插件服务管理器的入口。

#[cfg(feature = "tauri-app")]
use tauri::State;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use crate::error::Result;
use crate::models::plugin::{DiscoveredPluginManifest, PluginServiceManifestContribution};
use crate::services::plugin_service::PluginService;
use crate::services::plugin_service_manager::{ServiceStatus, StartContext};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStateSnapshot {
    /// 是否启用整个插件（默认按 enabledByDefault 判断）
    pub enabled: bool,
}

#[cfg(feature = "tauri-app")]
fn config_dir(state: &State<'_, AppState>) -> std::path::PathBuf {
    state
        .app_config_dir
        .get()
        .cloned()
        .unwrap_or_else(|| crate::services::data_root::data_root().config_dir())
}

#[cfg(feature = "tauri-app")]
fn build_ctx(state: &State<'_, AppState>, workspace_path: Option<String>) -> StartContext {
    StartContext {
        workspace_path,
        app_config_dir: Some(config_dir(state).to_string_lossy().to_string()),
    }
}

/// 启动单个服务
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_start(
    state: State<'_, AppState>,
    plugin_id: String,
    install_path: String,
    contribution: PluginServiceManifestContribution,
    workspace_path: Option<String>,
) -> Result<ServiceStatus> {
    let ctx = build_ctx(&state, workspace_path);
    state
        .plugin_service_manager
        .start_service(&plugin_id, contribution, install_path, ctx)
        .await
}

/// 停止单个服务
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_stop(
    state: State<'_, AppState>,
    plugin_id: String,
    service_id: String,
) -> Result<ServiceStatus> {
    state
        .plugin_service_manager
        .stop_service(&plugin_id, &service_id)
        .await
}

/// 重启单个服务
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_restart(
    state: State<'_, AppState>,
    plugin_id: String,
    service_id: String,
) -> Result<ServiceStatus> {
    state
        .plugin_service_manager
        .restart_service(&plugin_id, &service_id)
        .await
}

/// 列出所有服务状态
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_list_status(
    state: State<'_, AppState>,
) -> Result<Vec<ServiceStatus>> {
    Ok(state.plugin_service_manager.list_status().await)
}

/// 停止某个插件的所有服务
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_stop_for_plugin(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<Vec<ServiceStatus>> {
    state
        .plugin_service_manager
        .stop_services_for_plugin(&plugin_id)
        .await
}

/// 自动启动所有 autoStart 服务（应用启动 / 插件状态变化时触发）
///
/// 内部重新发现已安装插件 + 根据传入的 plugin_states 决定是否启动。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_service_autostart(
    state: State<'_, AppState>,
    workspace_path: Option<String>,
    plugin_states: HashMap<String, PluginStateSnapshot>,
) -> Result<Vec<ServiceStatus>> {
    let cfg_dir = config_dir(&state);
    let ws_path = workspace_path.as_deref().map(std::path::Path::new);
    let discovery = PluginService::discover_installed_plugins(&cfg_dir, ws_path);
    let plugins: Vec<DiscoveredPluginManifest> = discovery.plugins;
    let states_map: HashMap<String, bool> = plugin_states
        .into_iter()
        .map(|(k, v)| (k, v.enabled))
        .collect();
    let ctx = build_ctx(&state, workspace_path);
    Ok(state
        .plugin_service_manager
        .start_services_for_plugins(&plugins, &states_map, ctx)
        .await)
}
