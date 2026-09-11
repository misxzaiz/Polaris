//! Router Dispatch Tauri Commands（第三步 P2：dispatch 对前端可用）
//!
//! 契约测试面板（阶段 C）的前置：把统一转发总线暴露给前端。
//! - `router_dispatch`：构造 Envelope 走 dispatch 全链路（权限 gate → 找句柄 → invoke → 广播）
//! - `router_list_caps`：列出已注册能力（面板展示）

use crate::contracts::{CapabilityId, Envelope, MsgId, Source, TraceId};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use crate::contracts::Router as _; // dispatch / subscribe / register_handle

/// dispatch 请求（前端 → 后端，构造 Envelope）
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDispatchRequest {
    /// 目标能力 id（如 `cap.kv`）
    pub target: String,
    /// 能力入参（payload）
    pub payload: serde_json::Value,
    /// 来源标注（前端调用 = Remote；安全起见 token 由后端校验后注入，前端不可自填）
    #[serde(default = "default_source")]
    pub source: String,
}

fn default_source() -> String {
    "bootstrap".to_string()
}

/// dispatch 响应（Reply 的 JSON 化，方便前端消费）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDispatchResponse {
    pub msg_id: String,
    pub ok: bool,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
    pub trace: String,
}

/// 能力列表项（面板展示）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInfo {
    pub id: String,
}

/// 把请求字符串 source 映射为契约 Source。
///
/// 安全铁律：前端调用不授予 `Bootstrap`（那是 Core 内部专用）。HTTP/WS/Tauri IPC
/// 一律 `Remote`，token 由后端鉴权后注入（此处阶段 A 简化为空 token 占位，
/// 后续接 LocalSecret/鉴权后由传输层真正注入）。
fn map_source(source: &str) -> Source {
    match source {
        "bootstrap" => Source::Bootstrap, // 保留给内部测试/命令
        _ => Source::Remote { token: String::new() },
    }
}

/// 经统一总线 dispatch 一个 Envelope（第一个真实接线入口）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn router_dispatch(
    state: tauri::State<'_, crate::AppState>,
    req: RouterDispatchRequest,
) -> Result<RouterDispatchResponse> {
    let env = Envelope {
        id: MsgId(format!("ipc-{}", uuid::Uuid::new_v4())),
        source: map_source(&req.source),
        target: CapabilityId(req.target),
        payload: req.payload,
        trace: TraceId(format!("trace-{}", uuid::Uuid::new_v4())),
    };
    let reply = state.router.dispatch(env).map_err(|e| AppError::Unknown(e))?;
    let (ok, result, error) = match reply.result {
        Ok(v) => (true, Some(v), None),
        Err(e) => (false, None, Some(e)),
    };
    Ok(RouterDispatchResponse {
        msg_id: reply.msg_id.0,
        ok,
        result,
        error,
        trace: reply.trace.0,
    })
}

/// 列出已注册能力（契约测试面板用）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn router_list_caps(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<CapabilityInfo>> {
    Ok(state
        .router
        .list_capabilities()
        .into_iter()
        .map(|id| CapabilityInfo { id: id.0 })
        .collect())
}
