//! Router Dispatch Tauri Commands（第三步 P2：dispatch 对前端可用；第五步：Source 收紧 + 审计可见）
//!
//! - `router_dispatch`：构造 Envelope 走 dispatch 全链路（权限 gate → 找句柄 → invoke → 广播）
//! - `router_list_caps`：列出已注册能力（面板展示）
//! - `audit_tail` / `audit_verify`：审计链尾部读取与 tamper-evident 校验（第五步阶段 B）
//!
//! # Source 注入收紧（第五步阶段 A）
//!
//! 契约铁律：Source 由传输层注入，调用方不可自填。历史版本曾读前端自报的
//! `source` 字符串（不传默认 Bootstrap），本命令已废弃该通道：
//! 来源由**后端按 caller webview 判定**——主窗口 `main`（本地信任域，Polaris
//! 对 sky 契约的显式裁决，见 step5-permission-audit.md §1.3）→ `Bootstrap`；
//! 其余 webview（内置浏览器 tab 等）与 Web/HTTP → `Remote`。

use crate::contracts::{CapabilityId, Envelope, MsgId, Source, TraceId};
use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use crate::contracts::Router as _; // dispatch / subscribe / register_handle

/// 主窗口 label（本地信任域；tauri.conf.json 主窗口配置）
pub const MAIN_WINDOW_LABEL: &str = "main";

/// 按 caller webview label 判定契约 Source（纯函数，单测覆盖）。
///
/// - `main` → `Bootstrap`：桌面主窗口与 Core 同进程同信任域
/// - 其他（`browser-<tabId>`、未知 label）→ `Remote`（token 空占位，
///   真实鉴权接入后由传输层注入，见 step5 §5 遗留风险）
pub fn resolve_ipc_source(webview_label: &str) -> Source {
    if webview_label == MAIN_WINDOW_LABEL {
        Source::Bootstrap
    } else {
        Source::Remote { token: String::new() }
    }
}

/// dispatch 请求（前端 → 后端，构造 Envelope）
///
/// 注：历史版本的 `source` 自报字段已废弃——前端即使传了也会被 serde 忽略，
/// 真实来源由后端按 caller webview 判定（`resolve_ipc_source`）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDispatchRequest {
    /// 目标能力 id（如 `cap.kv`）
    pub target: String,
    /// 能力入参（payload）
    pub payload: serde_json::Value,
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

/// 经统一总线 dispatch 一个 Envelope（第一个真实接线入口）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn router_dispatch(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    req: RouterDispatchRequest,
) -> Result<RouterDispatchResponse> {
    let env = Envelope {
        id: MsgId(format!("ipc-{}", uuid::Uuid::new_v4())),
        // Source 由传输层（此处 = Tauri IPC 通道）注入，前端不可自填
        source: resolve_ipc_source(window.label()),
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

/// 流式 dispatch 应答（第六步：token 经事件通道推送，此处仅 ack）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouterDispatchStreamResponse {
    pub msg_id: String,
    pub trace: String,
}

/// 经统一总线流式 dispatch（第六步：cap.ai.chat / cap.stream.echo 等流式能力）
///
/// 事件流走既有广播通道（`chat-event` 等 kind 经 EventAdapter → WS），
/// 流结束时广播 `dispatch.end(stream)`。
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn router_dispatch_stream(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    req: RouterDispatchRequest,
) -> Result<RouterDispatchStreamResponse> {
    let env = Envelope {
        id: MsgId(format!("ipc-{}", uuid::Uuid::new_v4())),
        source: resolve_ipc_source(window.label()),
        target: CapabilityId(req.target),
        payload: req.payload,
        trace: TraceId(format!("trace-{}", uuid::Uuid::new_v4())),
    };
    let ack = state
        .router
        .dispatch_stream(env)
        .map_err(|e| AppError::Unknown(e))?;
    Ok(RouterDispatchStreamResponse {
        msg_id: ack.msg_id.0,
        trace: ack.trace.0,
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

// ============================================================================
// 审计链可见性（第五步阶段 B：JSONL tail + tamper-evident 校验）
// ============================================================================

/// 审计尾部响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditTailResponse {
    /// 倒数 N 条原始 JSONL（写入时已脱敏：source 只存变体名，token 不落盘）
    pub lines: Vec<String>,
    /// 文件总条数
    pub total: u64,
}

/// 审计链校验响应
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditVerifyResponse {
    pub ok: bool,
    /// 校验失败时的行号（1-based）
    pub broken_line: Option<u64>,
    /// 参与校验的总行数
    pub total: u64,
}

/// 审计链尾部（契约测试面板"审计链"块用）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn audit_tail(count: Option<usize>) -> Result<AuditTailResponse> {
    let path = crate::services::router::audit_sink::audit_file_path();
    let (lines, total) =
        crate::services::router::audit_sink::tail_lines(&path, count.unwrap_or(20))
            .map_err(|e| AppError::Unknown(e))?;
    Ok(AuditTailResponse { lines, total })
}

/// 审计链校验（逐条重算 sha256 链，篡改定位到行号）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn audit_verify() -> Result<AuditVerifyResponse> {
    let path = crate::services::router::audit_sink::audit_file_path();
    match crate::services::router::audit_sink::verify_chain(&path) {
        Ok(total) => Ok(AuditVerifyResponse { ok: true, broken_line: None, total }),
        Err(broken) => Ok(AuditVerifyResponse { ok: false, broken_line: Some(broken as u64), total: broken as u64 }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_maps_to_bootstrap() {
        assert_eq!(resolve_ipc_source("main"), Source::Bootstrap);
    }

    #[test]
    fn browser_webview_maps_to_remote() {
        // 内置浏览器动态 webview（label 恒为 browser-<tabId>）不可得 Bootstrap
        assert_eq!(
            resolve_ipc_source("browser-42"),
            Source::Remote { token: String::new() }
        );
    }

    #[test]
    fn unknown_label_maps_to_remote() {
        assert_eq!(
            resolve_ipc_source(""),
            Source::Remote { token: String::new() }
        );
        assert_eq!(
            resolve_ipc_source("Main"),
            Source::Remote { token: String::new() },
            "label 判定大小写敏感，防伪造"
        );
    }

    #[test]
    fn request_ignores_legacy_source_field() {
        // 前端自报的 source 字段被 serde 忽略（向后兼容旧前端，语义上无效）
        let req: RouterDispatchRequest = serde_json::from_value(serde_json::json!({
            "target": "cap.kv",
            "payload": { "action": "list" },
            "source": "bootstrap"
        }))
        .unwrap();
        assert_eq!(req.target, "cap.kv");
    }
}
