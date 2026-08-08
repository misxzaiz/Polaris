/*! 插件引擎管理命令
 *
 * 提供插件引擎的注册/注销/查询接口。
 * 前端插件系统通过 `contributes.engines` 声明动态引擎后，
 * 调用此命令在后端注册该引擎到 EngineRegistry。
 */

use crate::ai::PluginEngineConfig;
use crate::error::Result;
use crate::state::AppState;
#[cfg(feature = "tauri-app")]
use tauri::State;

/// 注册插件引擎。
///
/// 由前端插件系统在加载 plugin manifest 时调用。
/// 注册后引擎立即可用，出现在引擎选择器和元数据列表中。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn register_plugin_engine(
    state: State<'_, AppState>,
    engine: PluginEngineConfig,
) -> Result<()> {
    tracing::info!("[PluginEngineCmd] 注册插件引擎: id={}, name={}, cli={}", engine.id, engine.name, engine.cli.command);
    let mut registry = state.engine_registry.lock().await;
    let result = registry.register_plugin_engine(engine);
    match &result {
        Ok(()) => tracing::info!("[PluginEngineCmd] 插件引擎注册成功"),
        Err(e) => tracing::error!("[PluginEngineCmd] 插件引擎注册失败: {}", e),
    }
    result
}

/// 注销插件引擎。
///
/// 由前端插件系统在卸载插件时调用。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn unregister_plugin_engine(
    state: State<'_, AppState>,
    engine_id: String,
) -> Result<()> {
    let mut registry = state.engine_registry.lock().await;
    registry.unregister_plugin_engine(&engine_id)
}

/// 列出所有已注册的插件引擎 ID。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn list_plugin_engines(
    state: State<'_, AppState>,
) -> Result<Vec<String>> {
    let registry = state.engine_registry.lock().await;
    Ok(registry.list_plugin_engines())
}