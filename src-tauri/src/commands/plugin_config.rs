//! 插件配置读写命令（Tauri IPC + Web HTTP）。
//!
//! 插件配置存储在 config.json 的 `plugins[pluginId]` 命名空间，跨设备同步。
//! 读写受 manifest.permissions.appConfigRead/appConfigWrite 权限约束。
//!
//! 权限模型：pluginId 必须是已注册插件且声明了对应权限。
//! 同插件只能读写自身配置（权限校验保证），故无需跨插件脱敏——
//! 插件读自己的配置本就该看到明文。

use crate::error::{AppError, Result};
use crate::AppState;
use serde_json::json;
use std::collections::BTreeMap;

/// 读取插件完整配置。
///
/// 权限：manifest.permissions.appConfigRead === true
/// 返回该插件的配置对象；无配置时返回 {}。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_get_config(
    plugin_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value> {
    // 权限校验
    check_permission(&plugin_id, PermissionKind::Read)?;
    let value = {
        let store = state
            .config_store
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        store
            .get()
            .plugins
            .get(&plugin_id)
            .cloned()
            .unwrap_or(json!({}))
    };
    Ok(value)
}

/// 写入插件配置（字段级 patch 合并）。
///
/// 权限：manifest.permissions.appConfigWrite === true
/// 返回合并后的完整配置对象。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn plugin_set_config(
    plugin_id: String,
    patch: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<serde_json::Value> {
    // 权限校验
    check_permission(&plugin_id, PermissionKind::Write)?;
    // patch 必须是对象
    let patch_obj = patch.as_object().ok_or_else(|| {
        AppError::ConfigError("插件配置 patch 必须是 JSON 对象".to_string())
    })?;
    // 读当前值 → 合并 patch → 写回
    let result = {
        let mut store = state
            .config_store
            .lock()
            .map_err(|e| AppError::Unknown(e.to_string()))?;
        let plugins: &mut BTreeMap<String, serde_json::Value> = &mut store.get_mut().plugins;
        let mut current = plugins.get(&plugin_id).cloned().unwrap_or(json!({}));
        if let Some(obj) = current.as_object_mut() {
            for (k, v) in patch_obj {
                obj.insert(k.clone(), v.clone());
            }
        }
        plugins.insert(plugin_id.clone(), current.clone());
        store.save()?;
        current
    };
    Ok(result)
}

#[derive(Clone, Copy)]
enum PermissionKind {
    Read,
    Write,
}

/// 校验插件是否声明了对应权限。
///
/// 通过 PluginService::discover_installed_plugins 发现已安装插件，
/// 查找 manifest 并校验 appConfigRead/appConfigWrite。
fn check_permission(plugin_id: &str, kind: PermissionKind) -> Result<()> {
    use crate::services::data_root::data_root;
    use crate::services::plugin_service::PluginService;
    let app_config_dir = data_root().config_dir();
    let discovery = PluginService::discover_installed_plugins(&app_config_dir, None);
    let manifest = discovery
        .plugins
        .iter()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| {
            AppError::ConfigError(format!("插件 {} 未安装，无法校验权限", plugin_id))
        })?;
    let has_perm = match kind {
        PermissionKind::Read => manifest.permissions.app_config_read.unwrap_or(false),
        PermissionKind::Write => manifest.permissions.app_config_write.unwrap_or(false),
    };
    if !has_perm {
        let perm_name = match kind {
            PermissionKind::Read => "appConfigRead",
            PermissionKind::Write => "appConfigWrite",
        };
        return Err(AppError::ConfigError(format!(
            "插件 {} 未声明 {} 权限，禁止操作配置",
            plugin_id, perm_name
        )));
    }
    Ok(())
}
