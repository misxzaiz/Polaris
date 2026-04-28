//! Plugin 管理 Tauri 命令
//!
//! 提供插件管理的 API 接口

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::Result;
use crate::models::plugin::{
    Marketplace, PluginListResult, PluginOperationResult, PluginScope,
};
use crate::services::plugin_service::PluginService;
use crate::state::AppState;

/// 获取 Claude CLI 路径
#[cfg(feature = "tauri-app")]
fn get_claude_path(state: &State<'_, AppState>) -> Result<String> {
    let store = state.config_store.lock()
        .map_err(|e| crate::error::AppError::Unknown(e.to_string()))?;
    Ok(store.get().get_claude_cmd())
}

/// 列出插件
///
/// 获取已安装和可选的可用的插件列表
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_list(
    state: State<'_, AppState>,
    available: bool,
) -> Result<PluginListResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    service.list_plugins(available)
}

/// 安装插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_install(
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
) -> Result<PluginOperationResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    let scope = match scope.as_str() {
        "user" => PluginScope::User,
        "project" => PluginScope::Project,
        "local" => PluginScope::Local,
        _ => PluginScope::User, // 默认 user
    };

    service.install_plugin(&plugin_id, scope)
}

/// 启用插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_enable(
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
) -> Result<PluginOperationResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    let scope = match scope.as_str() {
        "user" => PluginScope::User,
        "project" => PluginScope::Project,
        "local" => PluginScope::Local,
        _ => PluginScope::User,
    };

    service.enable_plugin(&plugin_id, scope)
}

/// 禁用插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_disable(
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
) -> Result<PluginOperationResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    let scope = match scope.as_str() {
        "user" => PluginScope::User,
        "project" => PluginScope::Project,
        "local" => PluginScope::Local,
        _ => PluginScope::User,
    };

    service.disable_plugin(&plugin_id, scope)
}

/// 更新插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_update(
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
) -> Result<PluginOperationResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    let scope = match scope.as_str() {
        "user" => PluginScope::User,
        "project" => PluginScope::Project,
        "local" => PluginScope::Local,
        _ => PluginScope::User,
    };

    service.update_plugin(&plugin_id, scope)
}

/// 卸载插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_uninstall(
    state: State<'_, AppState>,
    plugin_id: String,
    scope: String,
    keep_data: bool,
) -> Result<PluginOperationResult> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    let scope = match scope.as_str() {
        "user" => PluginScope::User,
        "project" => PluginScope::Project,
        "local" => PluginScope::Local,
        _ => PluginScope::User,
    };

    service.uninstall_plugin(&plugin_id, scope, keep_data)
}

/// 列出市场
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn marketplace_list(state: State<'_, AppState>) -> Result<Vec<Marketplace>> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    service.list_marketplaces()
}

/// 添加市场
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn marketplace_add(
    state: State<'_, AppState>,
    source: String,
) -> Result<Marketplace> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    service.add_marketplace(&source)
}

/// 移除市场
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn marketplace_remove(
    state: State<'_, AppState>,
    name: String,
) -> Result<()> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    service.remove_marketplace(&name)
}

/// 更新市场
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn marketplace_update(
    state: State<'_, AppState>,
    name: Option<String>,
) -> Result<()> {
    let claude_path = get_claude_path(&state)?;
    let service = PluginService::new(claude_path);

    service.update_marketplace(name.as_deref())
}
