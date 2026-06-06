//! 上游请求转发器
//!
//! 负责将转换后的 OpenAI Chat Completions 请求发送到上游 API 端点，
//! 处理认证注入和流式/非流式响应。

use super::error::ProxyError;
use bytes::Bytes;
use futures_util::stream::Stream;
use reqwest::Response;
use serde_json::Value;

/// 上游线路格式（决定 URL 与请求/响应转换方式）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyWireApi {
    /// OpenAI Chat Completions（/v1/chat/completions）
    ChatCompletions,
    /// OpenAI Responses（/v1/responses）
    Responses,
    /// Codex 客户端使用 Responses，本地代理转换到上游 Chat Completions
    CodexResponsesToChatCompletions,
}

impl ProxyWireApi {
    /// 从 Profile 的 wireApi 字符串解析（None / 其他 → Chat Completions）
    pub fn from_profile_wire_api(s: Option<&str>) -> Self {
        match s {
            Some("openai-responses") => ProxyWireApi::Responses,
            _ => ProxyWireApi::ChatCompletions,
        }
    }
}

/// 上游转发器配置
#[derive(Debug, Clone)]
pub struct ForwarderConfig {
    /// 上游 API 端点 URL（如 `https://api.deepseek.com/v1/chat/completions`）
    pub upstream_url: String,
    /// API 密钥
    pub api_key: String,
    /// 线路格式（Chat Completions / Responses）
    pub wire_api: ProxyWireApi,
    /// 附加的自定义请求头
    pub custom_headers: std::collections::HashMap<String, String>,
    /// 请求超时时间（秒）
    pub timeout_secs: u64,
}

impl ForwarderConfig {
    pub fn new(base_url: &str, api_key: &str) -> Self {
        Self::with_options(
            base_url,
            api_key,
            ProxyWireApi::ChatCompletions,
            std::collections::HashMap::new(),
        )
    }

    /// 完整构造：指定线路格式与自定义请求头
    pub fn with_options(
        base_url: &str,
        api_key: &str,
        wire_api: ProxyWireApi,
        custom_headers: std::collections::HashMap<String, String>,
    ) -> Self {
        let url = build_upstream_url(base_url, wire_api);
        Self {
            upstream_url: url,
            api_key: api_key.to_string(),
            wire_api,
            custom_headers,
            // 大 payload（100KB+ 含 28+ tools）的上游响应可能需要 55s+，
            // 设置 180s 超时以覆盖最坏情况
            timeout_secs: 180,
        }
    }

    /// 将自定义请求头应用到 reqwest 请求构建器
    fn apply_custom_headers(&self, mut builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        for (k, v) in &self.custom_headers {
            builder = builder.header(k.as_str(), v.as_str());
        }
        builder
    }
}

/// 根据线路格式构建完整上游 URL
fn build_upstream_url(base_url: &str, wire_api: ProxyWireApi) -> String {
    let base = base_url.trim_end_matches('/');
    match wire_api {
        ProxyWireApi::Responses => {
            if base.ends_with("/responses") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/responses", base)
            } else {
                format!("{}/v1/responses", base)
            }
        }
        ProxyWireApi::ChatCompletions | ProxyWireApi::CodexResponsesToChatCompletions => {
            if base.ends_with("/chat/completions") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/chat/completions", base)
            } else {
                format!("{}/v1/chat/completions", base)
            }
        }
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

        let mut req_builder = client
            .post(&config.upstream_url)
            .header("Authorization", format!("Bearer {}", config.api_key))
            .header("Content-Type", "application/json")
            .body(body_str.clone());
        req_builder = config.apply_custom_headers(req_builder);
        let response = match req_builder.send().await
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
    fn test_build_upstream_url_chat() {
        assert_eq!(
            build_upstream_url("https://api.deepseek.com", ProxyWireApi::ChatCompletions),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_upstream_url("https://api.deepseek.com/v1", ProxyWireApi::ChatCompletions),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_upstream_url(
                "https://api.deepseek.com/v1/chat/completions",
                ProxyWireApi::ChatCompletions
            ),
            "https://api.deepseek.com/v1/chat/completions"
        );
        assert_eq!(
            build_upstream_url("https://api.deepseek.com/v1/", ProxyWireApi::ChatCompletions),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_build_upstream_url_responses() {
        assert_eq!(
            build_upstream_url("https://api.openai.com", ProxyWireApi::Responses),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            build_upstream_url("https://api.openai.com/v1", ProxyWireApi::Responses),
            "https://api.openai.com/v1/responses"
        );
        assert_eq!(
            build_upstream_url("https://api.openai.com/v1/responses", ProxyWireApi::Responses),
            "https://api.openai.com/v1/responses"
        );
    }
}
