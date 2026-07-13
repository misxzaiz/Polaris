//! 上游请求转发器
//!
//! 负责将转换后的 OpenAI Chat Completions 请求发送到上游 API 端点，
//! 处理认证注入和流式/非流式响应。

use super::error::ProxyError;
use bytes::Bytes;
use futures_util::stream::Stream;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::Response;
use serde_json::Value;

/// 每请求透传上下文（Anthropic 直通模式）
///
/// Claude CLI 依赖 `anthropic-beta`（如 `context-1m-2025-08-07` 开启 1M 上下文）、
/// `user-agent` / `x-app` 等原始请求头以及 `?beta=true` query 与上游协商能力；
/// 部分中转站还会对这些特征做校验。直通模式必须原样透传，否则上游行为不一致
/// （例如 1M 上下文被判定为未启用）。
#[derive(Debug, Clone, Default)]
pub struct RequestPassthrough {
    /// 已过滤的入站请求头（不含 hop-by-hop 与认证头）
    pub headers: Vec<(String, String)>,
    /// 入站请求的原始 query string（不含 `?`）
    pub query: Option<String>,
}

/// 上游线路格式（决定 URL 与请求/响应转换方式）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProxyWireApi {
    /// Anthropic Messages（/v1/messages），净化后直通转发
    AnthropicMessages,
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
            Some("anthropic-messages") => ProxyWireApi::AnthropicMessages,
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

    /// 构建上游请求头
    ///
    /// 合并顺序（后者覆盖前者）：
    /// 1. 透传的客户端原始头（已在 handler 层过滤 hop-by-hop / 认证头）
    /// 2. 认证与内容类型（Authorization / Content-Type，始终以 Profile 配置为准）
    /// 3. 协议头（anthropic-version，仅在透传头未携带时补充）
    /// 4. Profile 的自定义头（最高优先级）
    fn build_request_headers(&self, passthrough: Option<&RequestPassthrough>) -> HeaderMap {
        let mut headers = HeaderMap::new();

        if let Some(p) = passthrough {
            for (k, v) in &p.headers {
                if let (Ok(name), Ok(value)) = (
                    HeaderName::from_bytes(k.as_bytes()),
                    HeaderValue::from_str(v),
                ) {
                    headers.append(name, value);
                } else {
                    tracing::warn!("[Forwarder] 跳过无效透传头: {}", k);
                }
            }
        }

        if let Ok(auth) = HeaderValue::from_str(&format!("Bearer {}", self.api_key)) {
            headers.insert(reqwest::header::AUTHORIZATION, auth);
        }
        headers.insert(
            reqwest::header::CONTENT_TYPE,
            HeaderValue::from_static("application/json"),
        );

        if self.wire_api == ProxyWireApi::AnthropicMessages
            && !headers.contains_key("anthropic-version")
        {
            headers.insert("anthropic-version", HeaderValue::from_static("2023-06-01"));
        }

        for (k, v) in &self.custom_headers {
            if let (Ok(name), Ok(value)) = (
                HeaderName::from_bytes(k.as_bytes()),
                HeaderValue::from_str(v),
            ) {
                headers.insert(name, value);
            } else {
                tracing::warn!("[Forwarder] 跳过无效自定义头: {}", k);
            }
        }

        headers
    }

    /// 目标 URL：附加透传的原始 query string（如 Claude CLI 的 `?beta=true`）
    fn request_url(&self, passthrough: Option<&RequestPassthrough>) -> String {
        match passthrough.and_then(|p| p.query.as_deref()) {
            Some(q) if !q.is_empty() => format!("{}?{}", self.upstream_url, q),
            _ => self.upstream_url.clone(),
        }
    }
}

/// 根据线路格式构建完整上游 URL
fn build_upstream_url(base_url: &str, wire_api: ProxyWireApi) -> String {
    let base = base_url.trim_end_matches('/');
    match wire_api {
        ProxyWireApi::AnthropicMessages => {
            if base.ends_with("/messages") {
                base.to_string()
            } else if base.ends_with("/v1") {
                format!("{}/messages", base)
            } else {
                format!("{}/v1/messages", base)
            }
        }
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
pub async fn forward_request(config: &ForwarderConfig, body: &Value) -> Result<Value, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    let req_builder = client
        .post(&config.upstream_url)
        .headers(config.build_request_headers(None))
        .json(body);
    let response = req_builder.send().await?;

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
        body.get("messages")
            .and_then(|m| m.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        body.get("tools")
            .and_then(|t| t.as_array())
            .map(|a| a.len())
            .unwrap_or(0),
        body_str.len()
    );

    let req_builder = client
        .post(&config.upstream_url)
        .headers(config.build_request_headers(None))
        .json(body);
    let response = req_builder.send().await?;

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
///
/// `passthrough` 仅在 Anthropic 直通模式下传入：携带客户端原始请求头与 query，
/// 使代理转发的请求与 CLI 直连时一致。
pub async fn forward_raw_response(
    config: &ForwarderConfig,
    body: &Value,
    passthrough: Option<&RequestPassthrough>,
) -> Result<Response, ProxyError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(config.timeout_secs))
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| ProxyError::Server(format!("创建 HTTP 客户端失败: {}", e)))?;

    let url = config.request_url(passthrough);
    let headers = config.build_request_headers(passthrough);

    let body_str = serde_json::to_string(body).unwrap_or_default();
    tracing::info!(
        "[Forwarder] 发送请求到 {}: model={}, messages={}, tools={}, body_size={}bytes, timeout={}s, 透传头={}",
        url,
        body.get("model").and_then(|v| v.as_str()).unwrap_or("?"),
        body.get("messages").and_then(|m| m.as_array()).map(|a| a.len()).unwrap_or(0),
        body.get("tools").and_then(|t| t.as_array()).map(|a| a.len()).unwrap_or(0),
        body_str.len(),
        config.timeout_secs,
        passthrough.map(|p| p.headers.len()).unwrap_or(0)
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

        let req_builder = client
            .post(&url)
            .headers(headers.clone())
            .body(body_str.clone());
        let response = match req_builder.send().await {
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
            build_upstream_url(
                "https://api.deepseek.com/v1/",
                ProxyWireApi::ChatCompletions
            ),
            "https://api.deepseek.com/v1/chat/completions"
        );
    }

    #[test]
    fn test_build_upstream_url_anthropic_messages() {
        assert_eq!(
            build_upstream_url("https://api.anthropic.com", ProxyWireApi::AnthropicMessages),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_upstream_url(
                "https://api.anthropic.com/v1",
                ProxyWireApi::AnthropicMessages
            ),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            build_upstream_url(
                "https://api.anthropic.com/v1/messages",
                ProxyWireApi::AnthropicMessages
            ),
            "https://api.anthropic.com/v1/messages"
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
            build_upstream_url(
                "https://api.openai.com/v1/responses",
                ProxyWireApi::Responses
            ),
            "https://api.openai.com/v1/responses"
        );
    }

    fn anthropic_config() -> ForwarderConfig {
        ForwarderConfig::with_options(
            "https://relay.example.com",
            "sk-test",
            ProxyWireApi::AnthropicMessages,
            std::collections::HashMap::new(),
        )
    }

    #[test]
    fn passthrough_headers_are_forwarded() {
        let config = anthropic_config();
        let passthrough = RequestPassthrough {
            headers: vec![
                (
                    "anthropic-beta".to_string(),
                    "context-1m-2025-08-07".to_string(),
                ),
                ("user-agent".to_string(), "claude-cli/2.0.0".to_string()),
            ],
            query: None,
        };

        let headers = config.build_request_headers(Some(&passthrough));

        assert_eq!(
            headers.get("anthropic-beta").unwrap(),
            "context-1m-2025-08-07"
        );
        assert_eq!(headers.get("user-agent").unwrap(), "claude-cli/2.0.0");
    }

    #[test]
    fn auth_always_overrides_passthrough() {
        let config = anthropic_config();
        let passthrough = RequestPassthrough {
            headers: vec![("anthropic-version".to_string(), "2024-01-01".to_string())],
            query: None,
        };

        let headers = config.build_request_headers(Some(&passthrough));

        assert_eq!(headers.get("authorization").unwrap(), "Bearer sk-test");
        assert_eq!(headers.get("content-type").unwrap(), "application/json");
        // 透传的 anthropic-version 优先于默认值
        assert_eq!(headers.get("anthropic-version").unwrap(), "2024-01-01");
    }

    #[test]
    fn anthropic_version_defaults_when_absent() {
        let config = anthropic_config();
        let headers = config.build_request_headers(None);
        assert_eq!(headers.get("anthropic-version").unwrap(), "2023-06-01");
    }

    #[test]
    fn custom_headers_override_passthrough() {
        let mut custom = std::collections::HashMap::new();
        custom.insert("anthropic-beta".to_string(), "custom-beta".to_string());
        let config = ForwarderConfig::with_options(
            "https://relay.example.com",
            "sk-test",
            ProxyWireApi::AnthropicMessages,
            custom,
        );
        let passthrough = RequestPassthrough {
            headers: vec![(
                "anthropic-beta".to_string(),
                "context-1m-2025-08-07".to_string(),
            )],
            query: None,
        };

        let headers = config.build_request_headers(Some(&passthrough));
        assert_eq!(headers.get("anthropic-beta").unwrap(), "custom-beta");
    }

    #[test]
    fn request_url_appends_query() {
        let config = anthropic_config();
        let passthrough = RequestPassthrough {
            headers: Vec::new(),
            query: Some("beta=true".to_string()),
        };

        assert_eq!(
            config.request_url(Some(&passthrough)),
            "https://relay.example.com/v1/messages?beta=true"
        );
        assert_eq!(
            config.request_url(None),
            "https://relay.example.com/v1/messages"
        );
    }
}
