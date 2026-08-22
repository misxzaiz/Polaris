use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::AppState;
use super::WebError;

/// Get current application configuration.
pub async fn handle_get_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let config = state.clone_config_web()?;
    Ok(Json(config))
}

/// Patch application configuration by top-level keys.
///
/// 与 Tauri 模式 `update_config_patch`(lib.rs)对齐：patch 落盘后刷新引擎配置缓存，
/// 使后续会话使用新配置。Web 模式无 app_handle，不广播 `config-changed` 事件
/// （前端 configStore 在本请求响应后自行 set + applyConfig，单窗口一致；
/// 多 Tab 同步由 visibilitychange 时 re-fetch 兜底）。
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<serde_json::Value>,
) -> Result<impl IntoResponse, WebError> {
    let next_config = {
        let mut config_store = state.lock_config()?;
        config_store.patch(patch)?
    };
    // 刷新引擎配置缓存（与 Tauri 模式 refresh_engine_configs 对齐）
    {
        let mut registry = state.engine_registry.lock().await;
        registry.refresh_all_configs(next_config.clone());
    }
    Ok(Json(next_config))
}
