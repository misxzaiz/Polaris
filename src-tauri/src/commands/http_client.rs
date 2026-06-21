//! HTTP Client Tauri 命令
//!
//! 提供发起 HTTP 请求的 API 接口，供前端 API 调试器面板调用。

use crate::error::Result;
use crate::services::http_client_service::{self, HttpRequestSpec, HttpResponseInfo};

/// 执行一次 HTTP 请求
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn http_request(spec: HttpRequestSpec) -> Result<HttpResponseInfo> {
    http_client_service::execute_request(&spec).await
}
