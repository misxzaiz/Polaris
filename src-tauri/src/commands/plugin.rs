//! Plugin 管理 Tauri 命令
//!
//! 提供插件管理的 API 接口

#[cfg(feature = "tauri-app")]
use tauri::State;

use crate::error::Result;
use crate::models::plugin::{
    Marketplace, PluginDiscoveryResult, PluginListResult, PluginOperationResult,
    PluginInstallLocations, PluginManifestSourceKind, PluginManifestValidationResult, PluginScope,
    PluginUpdateCheckResult,
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

/// 发现已安装 Polaris 插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_discover(
    state: State<'_, AppState>,
    workspace_path: Option<String>,
) -> Result<PluginDiscoveryResult> {
    let config_dir = state.app_config_dir.get().cloned().or_else(|| {
        Some(crate::services::data_root::data_root().config_dir())
    }).ok_or_else(|| crate::error::AppError::ConfigError("无法获取配置目录".to_string()))?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    Ok(PluginService::discover_installed_plugins(
        &config_dir,
        workspace_path,
    ))
}

#[cfg(feature = "tauri-app")]
fn get_plugin_config_dir(state: &State<'_, AppState>) -> Result<std::path::PathBuf> {
    state.app_config_dir.get().cloned().or_else(|| {
        Some(crate::services::data_root::data_root().config_dir())
    }).ok_or_else(|| crate::error::AppError::ConfigError("无法获取配置目录".to_string()))
}

fn parse_local_plugin_scope(scope: &str) -> PluginManifestSourceKind {
    match scope {
        "project" => PluginManifestSourceKind::Project,
        _ => PluginManifestSourceKind::User,
    }
}

/// 获取 Polaris 本地插件安装目录
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_install_locations(
    state: State<'_, AppState>,
    workspace_path: Option<String>,
) -> Result<PluginInstallLocations> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    Ok(PluginService::install_locations(&config_dir, workspace_path))
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_validate_manifest(
    source_path: String,
) -> Result<PluginManifestValidationResult> {
    Ok(PluginService::validate_plugin_manifest(std::path::Path::new(&source_path)))
}

/// 从本地目录安装 Polaris 插件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_install_local(
    state: State<'_, AppState>,
    source_path: String,
    scope: String,
    workspace_path: Option<String>,
) -> Result<PluginOperationResult> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    PluginService::install_local_plugin(
        &config_dir,
        workspace_path,
        std::path::Path::new(&source_path),
        parse_local_plugin_scope(&scope),
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_install_package(
    state: State<'_, AppState>,
    package_path: String,
    scope: String,
    workspace_path: Option<String>,
) -> Result<PluginOperationResult> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    PluginService::install_plugin_package(
        &config_dir,
        workspace_path,
        std::path::Path::new(&package_path),
        parse_local_plugin_scope(&scope),
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_install_remote(
    state: State<'_, AppState>,
    source_url: String,
    scope: String,
    workspace_path: Option<String>,
) -> Result<PluginOperationResult> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    PluginService::install_remote_plugin(
        &config_dir,
        workspace_path,
        &source_url,
        parse_local_plugin_scope(&scope),
    )
    .await
}

/// 卸载已发现的 Polaris 本地插件目录
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_uninstall_local(
    state: State<'_, AppState>,
    install_path: String,
    workspace_path: Option<String>,
) -> Result<PluginOperationResult> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    PluginService::uninstall_local_plugin(
        &config_dir,
        workspace_path,
        std::path::Path::new(&install_path),
    )
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_check_update(
    install_path: String,
) -> Result<PluginUpdateCheckResult> {
    Ok(PluginService::check_local_plugin_update(std::path::Path::new(&install_path)).await)
}

#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_apply_update(
    state: State<'_, AppState>,
    install_path: String,
    workspace_path: Option<String>,
) -> Result<PluginOperationResult> {
    let config_dir = get_plugin_config_dir(&state)?;
    let workspace_path = workspace_path.as_deref().map(std::path::Path::new);

    PluginService::apply_local_plugin_update(
        &config_dir,
        workspace_path,
        std::path::Path::new(&install_path),
    )
    .await
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
