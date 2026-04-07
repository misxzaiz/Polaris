/*! AI 引擎 Trait 定义
 *
 * 定义所有 AI 引擎必须实现的统一接口。
 */

use crate::error::Result;
use crate::models::AIEvent;
use std::sync::Arc;

/// 引擎 ID
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EngineId {
    ClaudeCode,
    /// OpenAI 兼容引擎，可选指定具体的 provider_id
    OpenAI {
        /// Provider ID，None 表示使用激活的 provider
        provider_id: Option<String>,
    },
}

impl EngineId {
    /// 从字符串解析
    ///
    /// 支持格式：
    /// - "claude", "claude-code", "claudecode" → ClaudeCode
    /// - "openai" → OpenAI { provider_id: None }
    /// - "provider-xxx" → OpenAI { provider_id: Some("xxx") }
    pub fn from_str(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        match lower.as_str() {
            "claude" | "claude-code" | "claudecode" => Some(Self::ClaudeCode),
            "openai" => Some(Self::OpenAI { provider_id: None }),
            _ => {
                // 尝试解析 provider-xxx 格式
                if lower.starts_with("provider-") {
                    let provider_id = lower.strip_prefix("provider-").unwrap();
                    Some(Self::OpenAI {
                        provider_id: Some(provider_id.to_string()),
                    })
                } else {
                    None
                }
            }
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> String {
        match self {
            Self::ClaudeCode => "claude".to_string(),
            Self::OpenAI { provider_id: None } => "openai".to_string(),
            Self::OpenAI { provider_id: Some(id) } => format!("provider-{}", id),
        }
    }

    /// 获取简短显示名称（用于日志和 UI）
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::OpenAI { .. } => "OpenAI",
        }
    }

    /// 是否是 OpenAI 引擎
    pub fn is_openai(&self) -> bool {
        matches!(self, Self::OpenAI { .. })
    }

    /// 获取 OpenAI provider_id（如果是 OpenAI 引擎）
    pub fn provider_id(&self) -> Option<&str> {
        match self {
            Self::OpenAI { provider_id } => provider_id.as_deref(),
            _ => None,
        }
    }
}

impl std::fmt::Display for EngineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// 会话选项
pub struct SessionOptions {
    /// 工作目录
    pub work_dir: Option<String>,
    /// 系统提示词（用户自定义，会覆盖默认部分）
    pub system_prompt: Option<String>,
    /// 追加到默认系统提示词的内容（工作区信息等，始终追加）
    pub append_system_prompt: Option<String>,
    /// Claude Code MCP 配置文件路径
    pub mcp_config_path: Option<String>,
    /// 事件回调（接收标准化的 AIEvent）
    pub event_callback: Arc<dyn Fn(AIEvent) + Send + Sync>,
    /// 完成回调
    pub on_complete: Option<Arc<dyn Fn(i32) + Send + Sync>>,
    /// 错误回调
    pub on_error: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// Session ID 更新回调（当引擎返回真实 session_id 时调用）
    pub on_session_id_update: Option<Arc<dyn Fn(String) + Send + Sync>>,
    /// 消息历史（用于无状态引擎继续对话）
    pub message_history: Vec<HistoryEntry>,
}

/// 历史消息条目
#[derive(Debug, Clone)]
pub struct HistoryEntry {
    pub role: String,
    pub content: String,
}

impl SessionOptions {
    /// 创建默认选项
    pub fn new<F>(event_callback: F) -> Self
    where
        F: Fn(AIEvent) + Send + Sync + 'static,
    {
        Self {
            work_dir: None,
            system_prompt: None,
            append_system_prompt: None,
            mcp_config_path: None,
            event_callback: Arc::new(event_callback),
            on_complete: None,
            on_error: None,
            on_session_id_update: None,
            message_history: Vec::new(),
        }
    }

    /// 设置工作目录
    pub fn with_work_dir(mut self, work_dir: impl Into<String>) -> Self {
        self.work_dir = Some(work_dir.into());
        self
    }

    /// 设置系统提示词（用户自定义，会覆盖默认部分）
    pub fn with_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.system_prompt = Some(prompt.into());
        self
    }

    /// 设置追加系统提示词（工作区信息等，始终追加到默认提示词后）
    pub fn with_append_system_prompt(mut self, prompt: impl Into<String>) -> Self {
        self.append_system_prompt = Some(prompt.into());
        self
    }

    /// 设置 Claude Code MCP 配置路径
    pub fn with_mcp_config_path(mut self, path: impl Into<String>) -> Self {
        self.mcp_config_path = Some(path.into());
        self
    }

    /// 设置完成回调
    pub fn with_on_complete<F>(mut self, callback: F) -> Self
    where
        F: Fn(i32) + Send + Sync + 'static,
    {
        self.on_complete = Some(Arc::new(callback));
        self
    }

    /// 设置错误回调
    pub fn with_on_error<F>(mut self, callback: F) -> Self
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        self.on_error = Some(Arc::new(callback));
        self
    }

    /// 设置 Session ID 更新回调
    pub fn with_on_session_id_update<F>(mut self, callback: F) -> Self
    where
        F: Fn(String) + Send + Sync + 'static,
    {
        self.on_session_id_update = Some(Arc::new(callback));
        self
    }

    /// 设置消息历史
    pub fn with_message_history(mut self, history: Vec<HistoryEntry>) -> Self {
        self.message_history = history;
        self
    }
}

/// AI 引擎 Trait
pub trait AIEngine: Send + Sync {
    /// 获取引擎 ID
    fn id(&self) -> EngineId;

    /// 获取引擎名称
    fn name(&self) -> &'static str;

    /// 获取引擎描述
    fn description(&self) -> &'static str {
        ""
    }

    /// 检查引擎是否可用
    fn is_available(&self) -> bool;

    /// 获取不可用原因
    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    /// 启动新会话
    ///
    /// 返回临时会话 ID，引擎可能会在后续事件中提供真实的会话 ID
    fn start_session(
        &mut self,
        message: &str,
        options: SessionOptions,
    ) -> Result<String>;

    /// 继续已有会话
    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()>;

    /// 中断会话
    fn interrupt(&mut self, session_id: &str) -> Result<()>;

    /// 向会话发送输入
    ///
    /// 返回值：
    /// - Ok(true): 发送成功
    /// - Ok(false): 会话不存在或不支持 stdin 输入
    fn send_input(&mut self, _session_id: &str, _input: &str) -> Result<bool> {
        Ok(false)
    }

    /// 获取活动会话数量
    fn active_session_count(&self) -> usize {
        0
    }
}
