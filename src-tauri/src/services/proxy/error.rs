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
}
