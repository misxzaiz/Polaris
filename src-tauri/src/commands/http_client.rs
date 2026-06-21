//! HTTP Client Tauri 命令
//!
//! - http_request: 发起 HTTP 请求
//! - http_client_read / http_client_write: 持久化请求集合与环境变量

use crate::error::Result;
use crate::services::http_client_service::{self, HttpRequestSpec, HttpResponseInfo};
use crate::services::http_client_storage;

/// 执行一次 HTTP 请求
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub async fn http_request(spec: HttpRequestSpec) -> Result<HttpResponseInfo> {
    http_client_service::execute_request(&spec).await
}

/// 读取持久化文件（collection.json / environments.json）
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn http_client_read(name: String) -> Result<Option<String>> {
    http_client_storage::read_file(&name)
}

/// 原子写入持久化文件
#[cfg(feature = "tauri-app")]
#[tauri::command]
pub fn http_client_write(name: String, content: String) -> Result<()> {
    http_client_storage::write_file(&name, &content)
}
