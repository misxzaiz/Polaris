use axum::extract::State;
use axum::response::IntoResponse;
use axum::Json;
use std::sync::Arc;

use crate::contracts::Router as _; // dispatch
use crate::AppState;
use super::WebError;

/// Web 侧 config 读写统一走 cap.config 总线（D 阶段摘旧：消除 settings.rs 直读
/// ConfigStore 的「第三份复刻」旁路）。保留 `/api/settings` 路由兼容旧客户端 /
/// 外部 HTTP 调用，但内部经 router_dispatch，获得与前端一致的权限 gate +
/// 审计 + 白名单 + 深层合并 + 脱敏。
///
/// source：Web/HTTP 调用一律 `Source::Remote`（不可自声明 Bootstrap，那是 Core
/// 内部专用），token 由传输层鉴权后注入，此处从 config.web.token 读取构 Remote。
fn remote_source(state: &AppState) -> crate::contracts::Source {
    let token = state
        .clone_config_web()
        .ok()
        .and_then(|cfg| cfg.web.token)
        .unwrap_or_default();
    crate::contracts::Source::Remote { token }
}

/// 经 router_dispatch 调 cap.config（payload 内嵌 action）
fn dispatch_config(state: &AppState, payload: serde_json::Value) -> Result<serde_json::Value, WebError> {
    let env = crate::contracts::Envelope {
        id: crate::contracts::MsgId(format!("web-settings-{}", uuid::Uuid::new_v4())),
        source: remote_source(state),
        target: crate::contracts::CapabilityId("cap.config".into()),
        payload,
        trace: crate::contracts::TraceId(format!("trace-{}", uuid::Uuid::new_v4())),
    };
    let reply = state
        .router
        .dispatch(env)
        .map_err(WebError::Internal)?;
    match reply.result {
        Ok(v) => Ok(v),
        // cap.config 写保护（远程拒绝）→ Forbidden；其余业务错误 → Internal。
        // 错误消息约定见 ConfigCapability::ensure_writable_source。
        Err(e) if e.contains("不允许远程来源") => Err(WebError::Forbidden(e)),
        Err(e) => Err(WebError::Internal(e)),
    }
}

/// Get current application configuration.
///
/// D 阶段：走 cap.config `get full`（完整 config，敏感字段脱敏），
/// 不再直读 ConfigStore。
pub async fn handle_get_settings(
    State(state): State<Arc<AppState>>,
) -> Result<impl IntoResponse, WebError> {
    let result = dispatch_config(&state, serde_json::json!({
        "action": "get",
        "section": "full",
    }))?;
    Ok(Json(result))
}

/// Patch application configuration by top-level keys.
///
/// D 阶段：走 cap.config `patch` 顶层对象（白名单 section 严格深层合并 +
/// 自由 key 透传 store.patch）。副作用链由 cap.config 的 on_patch 触发
/// （cascade/refresh/emit 于桌面；Web 无 app_handle，emit 缺——与前端
/// configStore 在响应后自行 set + applyConfig 的单窗口语义一致）。
pub async fn handle_update_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<serde_json::Value>,
) -> Result<impl IntoResponse, WebError> {
    let result = dispatch_config(&state, serde_json::json!({
        "action": "patch",
        "patch": patch,
    }))?;
    Ok(Json(result))
}
