//! 上游请求转发器
//!
//! 负责将转换后的 OpenAI Chat Completions 请求发送到上游 API 端点，
//! 处理认证注入和流式/非流式响应。

use super::error::ProxyError;
use bytes::Bytes;
use futures_util::stream::Stream;
use reqwest::Response;
use serde_json::Value;

/// 上游转发器配置
#[derive(Debug, Clone)]
pub struct ForwarderConfig {
    /// 上游 API 端点 URL（如 `https://api.deepseek.com/v1/chat/completions`）
    pub upstream_url: String,
    /// API 密钥
    pub api_key: String,
    /// 请求超时时间（秒）
    pub timeout_secs: u64,
}

impl ForwarderConfig {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        // 确保 URL 指向 /v1/chat/completions
        let url = build_chat_completions_url(base_url);
        Self {
            upstream_url: url,
            api_key: api_key.to_string(),
            timeout_secs: 120,
        }
    }
}

/// 构建完整的 chat/completions URL
fn build_chat_completions_url(base_url: &str) -> String {
    let base = base_url.trim_end_matches('/');
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{}/chat/completions", base)
    } else {
        format!("{}/v1/chat/completions", base)
    }
}

/// 转发非流式请求到上游
pub async fn forward_request(
    config: &ForwarderConfig,
    body: &Value,
) -> Result<Value, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    let response = client
        .post(&config.upstream_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        return Err(ProxyError::UpstreamError {
            status: status.as_u16(),
            body: body_text,
        });
    }

    let json: Value = response.json().await?;
    Ok(json)
}

/// 转发流式请求到上游，返回字节流
pub async fn forward_streaming_request(
    config: &ForwarderConfig,
    body: &Value,
) -> Result<impl Stream<Item = Result<Bytes, reqwest::Error>> + Send, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    // 记录请求体大小（不记录完整内容以避免日志过大）
    let body_str = serde_json::to_string(body).unwrap_or_default();
    tracing::info!(
        "[Forwarder] 发送请求到 {}: model={}, messages={}, tools={}, body_size={}bytes",
        config.upstream_url,
        body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
        body.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0),
        body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0),
        body_str.len()
    );

    let response = client
        .post(&config.upstream_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        tracing::error!(
            "[Forwarder] 上游错误: status={}, body={}",
            status,
            body_text
        );
        return Err(ProxyError::UpstreamError {
            status: status.as_u16(),
            body: body_text,
        });
    }

    Ok(response.bytes_stream())
}

/// 转发请求，返回原始 Response（用于流式处理的底层方法）
pub async fn forward_raw_response(
    config: &ForwarderConfig,
    body: &Value,
) -> Result<Response, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    let response = client
        .post(&config.upstream_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body_text = response.text().await.unwrap_or_default();
        return Err(ProxyError::UpstreamError {
            status: status.as_u16(),
            body: body_text,
        });
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_chat_completions_url() {
        assert_eq!(
            build_chat_completions_url("https://api.deepseek.com"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("https://api.deepseek.com/v1"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_chat_completions_url("https://api.deepseek.com/v1/"),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }
}
