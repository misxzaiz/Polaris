//! HTTP Client 服务
//!
//! 基于 reqwest + rustls 提供 HTTP 请求执行能力，供：
//! - 前端面板（API 调试器）通过 Tauri command 调用
//! - MCP server 通过 tokio runtime 调用，让 AI 能够发起 HTTP 请求
//!
//! 在后端执行请求可绕过浏览器 CORS 限制，并统一支持所有 HTTP 方法。

use std::collections::HashMap;
use std::time::{Duration, Instant};

use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};

/// 默认请求超时（30s）
const DEFAULT_TIMEOUT_MS: u64 = 30_000;
/// 最大响应体大小（10 MB），超过则截断并标记
const MAX_BODY_SIZE: usize = 10 * 1024 * 1024;

/// 单个请求头（顺序保留，便于前端展示）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpHeader {
    pub name: String,
    pub value: String,
}

/// 查询参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpQuery {
    pub name: String,
    pub value: String,
}

/// HTTP 请求规格
///
/// 字段统一使用 camelCase 序列化，供前端 TS 与 MCP schema 一致使用。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequestSpec {
    /// HTTP 方法：GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS ...
    pub method: String,
    /// 完整 URL
    pub url: String,
    /// 请求头
    #[serde(default)]
    pub headers: Vec<HttpHeader>,
    /// 查询参数
    #[serde(default)]
    pub query: Vec<HttpQuery>,
    /// 请求体（原始字符串）
    #[serde(default)]
    pub body: Option<String>,
    /// 请求体类型：json / text / form / none，用于自动补全 Content-Type
    #[serde(default)]
    pub body_type: Option<String>,
    /// 超时（毫秒），None 使用默认值
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    /// 是否跟随重定向，默认 true
    #[serde(default = "default_true")]
    pub follow_redirects: bool,
}

fn default_true() -> bool {
    true
}

/// HTTP 响应信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponseInfo {
    /// HTTP 状态码
    pub status: u16,
    /// 状态文本
    pub status_text: String,
    /// 响应头
    pub headers: Vec<HttpHeader>,
    /// 响应体（文本）
    pub body: String,
    /// 是否因超出大小限制被截断
    pub truncated: bool,
    /// 耗时（毫秒）
    pub elapsed_ms: u64,
    /// 最终 URL（重定向后）
    pub url: String,
    /// 响应体字节数
    pub size: usize,
}

/// 执行一次 HTTP 请求
pub async fn execute_request(spec: &HttpRequestSpec) -> Result<HttpResponseInfo> {
    let url = spec.url.trim();
    if url.is_empty() {
        return Err(AppError::ValidationError("URL 不能为空".to_string()));
    }

    let method = Method::from_bytes(spec.method.trim().to_uppercase().as_bytes())
        .map_err(|e| AppError::ValidationError(format!("无效的 HTTP 方法: {}", e)))?;

    let timeout_ms = spec.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS).max(1_000);
    let mut builder = Client::builder()
        .timeout(Duration::from_millis(timeout_ms))
        .danger_accept_invalid_certs(true) // 调试场景允许自签证书
        .user_agent("Polaris-HttpClient/0.1.0");

    if !spec.follow_redirects {
        builder = builder.redirect(reqwest::redirect::Policy::none());
    }

    let client = builder
        .build()
        .map_err(|e| AppError::NetworkError(format!("构建 HTTP 客户端失败: {}", e)))?;

    let mut request = client.request(method, url);

    // 查询参数
    if !spec.query.is_empty() {
        let query_pairs: Vec<(String, String)> = spec
            .query
            .iter()
            .map(|q| (q.name.clone(), q.value.clone()))
            .collect();
        request = request.query(&query_pairs);
    }

    // 请求头
    for header in &spec.headers {
        let name = header.name.trim();
        if name.is_empty() {
            continue;
        }
        let value = reqwest::header::HeaderValue::from_str(&header.value)
            .map_err(|e| AppError::ValidationError(format!("无效的请求头值 [{}]: {}", name, e)))?;
        request = request.header(name, value);
    }

    // 请求体 + 自动 Content-Type
    let body_type = spec.body_type.as_deref().unwrap_or("none");
    if let Some(body) = &spec.body {
        let body = body.trim();
        if !body.is_empty() && body_type != "none" {
            // 若用户未显式设置 Content-Type，根据 body_type 补全
            let has_content_type = spec
                .headers
                .iter()
                .any(|h| h.name.eq_ignore_ascii_case("content-type"));
            if !has_content_type {
                let ct = match body_type {
                    "json" => Some("application/json; charset=utf-8"),
                    "text" => Some("text/plain; charset=utf-8"),
                    "form" => Some("application/x-www-form-urlencoded; charset=utf-8"),
                    _ => None,
                };
                if let Some(ct) = ct {
                    request = request.header("Content-Type", ct);
                }
            }
            request = request.body(body.to_string());
        }
    }

    let start = Instant::now();
    let response = request
        .send()
        .await
        .map_err(|e| AppError::NetworkError(format!("请求失败: {}", e)))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("")
        .to_string();
    let final_url = response.url().to_string();

    // 响应头
    let mut headers: Vec<HttpHeader> = Vec::new();
    for (name, value) in response.headers().iter() {
        let value_str = value.to_str().unwrap_or("").to_string();
        headers.push(HttpHeader {
            name: name.as_str().to_string(),
            value: value_str,
        });
    }

    // 响应体（限制大小）
    let full_body = response
        .bytes()
        .await
        .map_err(|e| AppError::NetworkError(format!("读取响应体失败: {}", e)))?;
    let size = full_body.len();
    let truncated = size > MAX_BODY_SIZE;
    let body_bytes = if truncated {
        &full_body[..MAX_BODY_SIZE]
    } else {
        &full_body[..]
    };
    // 以 UTF-8 丢失性转换；非文本响应体会包含 replacement char，前端可据此判断
    let body = String::from_utf8_lossy(body_bytes).to_string();

    Ok(HttpResponseInfo {
        status,
        status_text,
        headers,
        body,
        truncated,
        elapsed_ms,
        url: final_url,
        size,
    })
}

/// 将响应信息折叠成简短文本摘要（供 MCP 工具返回的 text 字段使用）
pub fn summarize_response(resp: &HttpResponseInfo) -> String {
    let header_preview: HashMap<&str, &str> = resp
        .headers
        .iter()
        .map(|h| (h.name.as_str(), h.value.as_str()))
        .collect();
    let content_type = header_preview
        .get("content-type")
        .copied()
        .unwrap_or("unknown");
    let mut summary = format!(
        "HTTP {} {} | {} ms | {} bytes | content-type: {} | url: {}",
        resp.status, resp.status_text, resp.elapsed_ms, resp.size, content_type, resp.url
    );
    if resp.truncated {
        summary.push_str(" | (响应体已截断)");
    }
    let body_preview: String = resp.body.chars().take(1_500).collect();
    summary.push_str("\n\n--- body ---\n");
    summary.push_str(&body_preview);
    if resp.body.chars().count() > 1_500 {
        summary.push_str("\n... (truncated preview)");
    }
    summary
}
