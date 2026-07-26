//! 代理服务错误类型

use thiserror::Error;

/// 代理服务错误
#[derive(Debug, Error)]
pub enum ProxyError {
    #[error("HTTP 请求失败: {0}")]
    Http(#[from] reqwest::Error),

    #[error("JSON 解析失败: {0}")]
    Json(#[from] serde_json::Error),

    #[error("格式转换失败: {0}")]
    Transform(String),

    #[error("上游返回错误: {status} - {body}")]
    UpstreamError { status: u16, body: String },

    #[error("流式响应超时")]
    StreamTimeout,

    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("代理服务器错误: {0}")]
    Server(String),
}

impl ProxyError {
    /// 获取 HTTP 状态码（用于返回给 Claude CLI）
    pub fn status_code(&self) -> u16 {
        match self {
            ProxyError::UpstreamError { status, .. } => *status,
            ProxyError::Transform(_) => 500,
            ProxyError::Http(_) => 502,
            ProxyError::StreamTimeout => 504,
            _ => 500,
        }
    }

    /// 获取上游原始响应体(仅 `UpstreamError` 变体有)。
    ///
    /// 用于 P3:错误体透传。上游 4xx 时,`forward_raw_response` 已把上游原始
    /// body 读到 `UpstreamError.body`,handler 层应原样透传给客户端(而非
    /// 包装成 `api_error`),保留上游结构化错误码(如 `invalid_request_error`
    /// + `tool_use ids were found without tool_result blocks`),排查友好。
    pub fn upstream_body(&self) -> Option<&str> {
        match self {
            ProxyError::UpstreamError { body, .. } => Some(body.as_str()),
            _ => None,
        }
    }
}
