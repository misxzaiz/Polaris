use thiserror::Error;

/// 应用结果类型别名
pub type Result<T> = std::result::Result<T, AppError>;

/// 将 AppError 转换为 Tauri InvokeError
#[cfg(feature = "tauri-app")]
impl From<AppError> for tauri::ipc::InvokeError {
    fn from(error: AppError) -> Self {
        tauri::ipc::InvokeError::from(error.to_message())
    }
}

/// 将 Tauri Error 转换为 AppError
#[cfg(feature = "tauri-app")]
impl From<tauri::Error> for AppError {
    fn from(error: tauri::Error) -> Self {
        AppError::Unknown(error.to_string())
    }
}

/// 应用错误类型
#[derive(Error, Debug)]
pub enum AppError {
    /// Claude CLI 未找到
    #[error("Claude CLI not found at: {0}")]
    ClaudeNotFound(String),

    /// Claude 进程错误
    #[error("Claude process error: {0}")]
    ProcessError(String),

    /// JSON 解析错误
    #[error("Failed to parse JSON: {0}")]
    ParseError(String),

    /// IO 错误
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),

    /// 序列化错误
    #[error("Serialization error: {0}")]
    SerializationError(#[from] serde_json::Error),

    /// 配置错误
    #[error("Configuration error: {0}")]
    ConfigError(String),

    /// 会话未找到
    #[error("Session not found: {0}")]
    SessionNotFound(String),

    /// 权限被拒绝
    #[error("Permission denied: {0}")]
    PermissionDenied(String),

    /// 无效路径
    #[error("Invalid path: {0}")]
    InvalidPath(String),

    /// 超时
    #[error("Operation timed out")]
    Timeout,

    /// 网络错误
    #[error("Network error: {0}")]
    NetworkError(String),

    /// 认证错误
    #[error("Authentication error: {0}")]
    AuthError(String),

    /// API 错误
    #[error("API error: {0}")]
    ApiError(String),

    /// 验证错误
    #[error("Validation error: {0}")]
    ValidationError(String),

    /// 状态错误
    #[error("State error: {0}")]
    StateError(String),

    /// 调度器错误
    #[error("Scheduler error: {0}")]
    SchedulerError(String),

    /// 任务错误
    #[error("Task error: {task_id}: {message}")]
    TaskError {
        /// 任务 ID
        task_id: String,
        /// 错误信息
        message: String,
    },

    /// 模板错误
    #[error("Template error: {template_id}: {message}")]
    TemplateError {
        /// 模板 ID
        template_id: String,
        /// 错误信息
        message: String,
    },

    /// 协议错误
    #[error("Protocol error: {message}")]
    ProtocolError {
        /// 错误信息
        message: String,
        /// 任务路径（可选）
        task_path: Option<String>,
    },

    /// 前端可识别的业务错误码（i18n key）
    ///
    /// 与其他变体不同，`to_message()` 会**原样返回**该字符串（不加任何中文前缀），
    /// 使前端能直接拿到形如 `errors:modelProfile.notFoundRuntime` 的 i18n key 并翻译。
    #[error("{0}")]
    ClientError(String),

    /// 其他错误
    #[error("Unknown error: {0}")]
    Unknown(String),
}

impl AppError {
    /// 将错误转换为可发送给前端的字符串
    pub fn to_message(&self) -> String {
        match self {
            AppError::ClaudeNotFound(_) => "Claude CLI 未安装或不在 PATH 中".to_string(),
            AppError::ProcessError(e) => format!("进程错误: {}", e),
            AppError::ParseError(e) => format!("解析错误: {}", e),
            AppError::IoError(e) => format!("IO 错误: {}", e),
            AppError::SerializationError(e) => format!("序列化错误: {}", e),
            AppError::ConfigError(e) => format!("配置错误: {}", e),
            AppError::SessionNotFound(id) => format!("会话不存在: {}", id),
            AppError::PermissionDenied(e) => format!("权限被拒绝: {}", e),
            AppError::InvalidPath(path) => format!("无效路径: {}", path),
            AppError::Timeout => "操作超时".to_string(),
            AppError::NetworkError(e) => format!("网络错误: {}", e),
            AppError::AuthError(e) => format!("认证错误: {}", e),
            AppError::ApiError(e) => format!("API 错误: {}", e),
            AppError::ValidationError(e) => format!("验证错误: {}", e),
            AppError::StateError(e) => format!("状态错误: {}", e),
            AppError::SchedulerError(e) => format!("调度器错误: {}", e),
            AppError::TaskError { task_id, message } => format!("任务错误 [{}]: {}", task_id, message),
            AppError::TemplateError { template_id, message } => format!("模板错误 [{}]: {}", template_id, message),
            AppError::ProtocolError { message, task_path } => {
                if let Some(path) = task_path {
                    format!("协议错误 [{}]: {}", path, message)
                } else {
                    format!("协议错误: {}", message)
                }
            }
            // 业务错误码原样透传（前端按 i18n key 翻译，不加前缀）
            AppError::ClientError(code) => code.clone(),
            AppError::Unknown(e) => format!("未知错误: {}", e),
        }
    }

    /// 创建任务错误
    pub fn task_error(task_id: impl Into<String>, message: impl Into<String>) -> Self {
        AppError::TaskError {
            task_id: task_id.into(),
            message: message.into(),
        }
    }

    /// 创建模板错误
    pub fn template_error(template_id: impl Into<String>, message: impl Into<String>) -> Self {
        AppError::TemplateError {
            template_id: template_id.into(),
            message: message.into(),
        }
    }

    /// 创建协议错误
    pub fn protocol_error(message: impl Into<String>, task_path: Option<String>) -> Self {
        AppError::ProtocolError {
            message: message.into(),
            task_path,
        }
    }
}
