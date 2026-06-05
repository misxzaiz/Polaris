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
            // 大 payload（100KB+ 含 28+ tools）的上游响应可能需要 55s+，
            // 设置 180s 超时以覆盖最坏情况
            timeout_secs: 180,
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

/// 最大重试次数
const MAX_RETRIES: u32 = 2;

/// 转发请求，返回原始 Response（用于流式处理的底层方法）
///
/// 对超时和 5xx 错误自动重试（最多 MAX_RETRIES 次），
/// 解决上游 API 偶尔超时的问题。
pub async fn forward_raw_response(
    config: &ForwarderConfig,
    body: &Value,
) -> Result<Response, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    let body_str = serde_json::to_string(body).unwrap_or_default();
    tracing::info!(
        "[Forwarder] 发送请求到 {}: model={}, messages={}, tools={}, body_size={}bytes, timeout={}s",
        config.upstream_url,
        body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
        body.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0),
        body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0),
        body_str.len(),
        config.timeout_secs
    );

    let mut last_error: Option<ProxyError> = None;

    for attempt in 0..=MAX_RETRIES {
        if attempt > 0 {
            let delay = std::time::Duration::from_secs(attempt as u64);
            tracing::warn!(
                "[Forwarder] 重试 {}/{}，等待 {:?}...",
                attempt,
                MAX_RETRIES,
                delay
            );
            tokio::time::sleep(delay).await;
        }

        let response = match client
            .post(&config.upstream_url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .body(body_str.clone())
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(e) => {
                tracing::warn!("[Forwarder] 请求发送失败 (attempt {}): {}", attempt + 1, e);
                last_error = Some(ProxyError::Http(e));
                continue;
            }
        };

        let status = response.status();

        // 成功：直接返回
        if status.is_success() {
            if attempt > 0 {
                tracing::info!("[Forwarder] 重试成功 (attempt {})", attempt + 1);
            }
            return Ok(response);
        }

        // 4xx 客户端错误：不重试
        if status.is_client_error() {
            let body_text = response.text().await.unwrap_or_default();
            tracing::error!(
                "[Forwarder] 上游客户端错误: status={}, body={}",
                status,
                body_text
            );
            return Err(ProxyError::UpstreamError {
                status: status.as_u16(),
                body: body_text,
            });
        }

        // 5xx 服务端错误：可重试
        let body_text = response.text().await.unwrap_or_default();
        tracing::warn!(
            "[Forwarder] 上游服务端错误 (attempt {}): status={}, body={}",
            attempt + 1,
            status,
            body_text
        );
        last_error = Some(ProxyError::UpstreamError {
            status: status.as_u16(),
            body: body_text,
        });
    }

    // 所有重试都失败
    tracing::error!("[Forwarder] 所有 {} 次重试都失败", MAX_RETRIES + 1);
    Err(last_error.unwrap_or(ProxyError::Server("未知错误".to_string())))
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
