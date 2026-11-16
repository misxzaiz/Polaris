//! WireProtocol 协议枚举（K-R1 拆分）

// ============================================================================
// 线路协议
// ============================================================================

/// 线路协议（由 `Profile.wireApi` 决定）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireProtocol {
    /// OpenAI Chat Completions（`/chat/completions`）。
    OpenAIChat,
    /// Anthropic Messages（`/v1/messages`）。
    Anthropic,
    /// OpenAI Responses（`/responses`）。
    Responses,
}

/// Anthropic API 版本头（与 model_profile_service 保持一致）。
pub const ANTHROPIC_VERSION: &str = "2023-06-01";

impl WireProtocol {
    /// 从 Profile 的 `wireApi` 字符串解析。
    ///
    /// `None` / `"anthropic-messages"` → [`WireProtocol::Anthropic`]，
    /// 与 `ModelProfile` 的默认线路（anthropic-messages）保持一致。
    pub fn from_wire_api(s: Option<&str>) -> Self {
        match s {
            Some("openai-chat-completions") => WireProtocol::OpenAIChat,
            Some("openai-responses") => WireProtocol::Responses,
            _ => WireProtocol::Anthropic,
        }
    }

    /// 人类可读标识（日志用）。
    pub fn as_str(&self) -> &'static str {
        match self {
            WireProtocol::OpenAIChat => "openai-chat-completions",
            WireProtocol::Anthropic => "anthropic-messages",
            WireProtocol::Responses => "openai-responses",
        }
    }

    /// 构建完整上游 URL（智能补全路径后缀，与 model_profile_service 约定一致）。
    pub fn build_url(&self, base_url: &str) -> String {
        let base = base_url.trim_end_matches('/');
        match self {
            WireProtocol::OpenAIChat => {
                if base.ends_with("/chat/completions") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/chat/completions", base)
                } else {
                    format!("{}/v1/chat/completions", base)
                }
            }
            WireProtocol::Anthropic => {
                if base.ends_with("/messages") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/messages", base)
                } else {
                    format!("{}/v1/messages", base)
                }
            }
            WireProtocol::Responses => {
                if base.ends_with("/responses") {
                    base.to_string()
                } else if base.ends_with("/v1") {
                    format!("{}/responses", base)
                } else {
                    format!("{}/v1/responses", base)
                }
            }
        }
    }

    /// 该协议的鉴权请求头（键值对）。空 api_key 时不注入。
    pub fn auth_headers(&self, api_key: &str) -> Vec<(String, String)> {
        if api_key.is_empty() {
            return Vec::new();
        }
        match self {
            WireProtocol::Anthropic => vec![
                ("x-api-key".to_string(), api_key.to_string()),
                ("anthropic-version".to_string(), ANTHROPIC_VERSION.to_string()),
            ],
            WireProtocol::OpenAIChat | WireProtocol::Responses => {
                vec![("Authorization".to_string(), format!("Bearer {}", api_key))]
            }
        }
    }
}