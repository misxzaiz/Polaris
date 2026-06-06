/*! AI 引擎 Trait 定义
 *
 * 定义所有 AI 引擎必须实现的统一接口。
 */

use crate::error::Result;
use crate::models::config::Config;
use crate::models::AIEvent;
use std::collections::HashMap;
use std::sync::Arc;

/// 引擎 ID
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EngineId {
    ClaudeCode,
    Codex,
    SimpleAI,
}

impl EngineId {
    /// 从字符串解析
    ///
    /// 支持格式：
    /// - "claude", "claude-code", "claudecode" → ClaudeCode
    pub fn parse(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        match lower.as_str() {
            "claude" | "claude-code" | "claudecode" => Some(Self::ClaudeCode),
            "codex" | "openai-codex" | "openai_codex" => Some(Self::Codex),
            "simple-ai" | "simpleai" | "simple_ai" => Some(Self::SimpleAI),
            _ => None,
        }
    }

    /// 转换为字符串
    pub fn as_str(&self) -> String {
        match self {
            Self::ClaudeCode => "claude".to_string(),
            Self::Codex => "codex".to_string(),
            Self::SimpleAI => "simple-ai".to_string(),
        }
    }

    /// 获取简短显示名称（用于日志和 UI）
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "OpenAI Codex",
            Self::SimpleAI => "Simple AI",
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
    /// 额外目录列表（通过 --add-dir 传递给 Claude CLI）
    pub additional_dirs: Vec<String>,
    /// CLI Agent 选择（--agent 参数）
    pub agent: Option<String>,
    /// 模型选择（--model 参数）
    pub model: Option<String>,
    /// 努力级别（--effort 参数）
    pub effort: Option<String>,
    /// 权限模式（--permission-mode 参数）
    pub permission_mode: Option<String>,
    /// 允许的工具列表（通过 --allowedTools 传递）
    pub allowed_tools: Vec<String>,
    /// 图片附件列表（非空时切换到 stream-json 输入模式）
    pub image_attachments: Vec<ImageAttachment>,
    /// Fork 来源会话 ID（配合 --resume 使用 --fork-session 创建分支会话）
    pub fork_session_id: Option<String>,
    /// Settings overlay 文件路径（--settings 参数值）
    /// 由 model_profile_service 根据当前激活的 Profile 生成
    pub settings_overlay_path: Option<String>,
    /// Codex CLI 配置参数（-c key=value），用于动态注入 MCP 等配置
    pub codex_config_args: Vec<String>,
    /// 环境变量覆盖（ANTHROPIC_BASE_URL / AUTH_TOKEN / MODEL 等）
    /// 用于将请求路由到第三方 Anthropic 兼容端点
    pub env_overrides: HashMap<String, String>,
}

/// 图片附件（用于 stream-json 模式原生传递给模型）
#[derive(Debug, Clone)]
pub struct ImageAttachment {
    /// MIME 类型（如 "image/png"）
    pub media_type: String,
    /// 纯 base64 数据（不含 data: 前缀）
    pub data: String,
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
            additional_dirs: Vec::new(),
            agent: None,
            model: None,
            effort: None,
            permission_mode: None,
            allowed_tools: Vec::new(),
            image_attachments: Vec::new(),
            fork_session_id: None,
            settings_overlay_path: None,
            codex_config_args: Vec::new(),
            env_overrides: HashMap::new(),
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

    /// 设置 Agent
    pub fn with_agent(mut self, agent: impl Into<String>) -> Self {
        self.agent = Some(agent.into());
        self
    }

    /// 设置模型
    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }

    /// 设置努力级别
    pub fn with_effort(mut self, effort: impl Into<String>) -> Self {
        self.effort = Some(effort.into());
        self
    }

    /// 设置权限模式
    pub fn with_permission_mode(mut self, mode: impl Into<String>) -> Self {
        self.permission_mode = Some(mode.into());
        self
    }

    /// 设置允许的工具列表
    pub fn with_allowed_tools(mut self, tools: Vec<String>) -> Self {
        self.allowed_tools = tools;
        self
    }

    /// 设置图片附件列表
    pub fn with_image_attachments(mut self, images: Vec<ImageAttachment>) -> Self {
        self.image_attachments = images;
        self
    }

    /// 设置 settings overlay 文件路径
    pub fn with_settings_overlay_path(mut self, path: impl Into<String>) -> Self {
        self.settings_overlay_path = Some(path.into());
        self
    }

    /// 设置 Codex CLI 配置参数
    pub fn with_codex_config_args(mut self, args: Vec<String>) -> Self {
        self.codex_config_args = args;
        self
    }

    /// 设置环境变量覆盖
    pub fn with_env_overrides(mut self, overrides: HashMap<String, String>) -> Self {
        self.env_overrides = overrides;
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
    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String>;

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

    /// 应用最新配置(并失效内部缓存)
    ///
    /// 当用户通过设置页面修改 CLI 路径或其他配置时,引擎需要
    /// 重新读取最新配置,而不是继续使用启动时的快照.
    ///
    /// 默认实现是空操作;引擎可以按需覆盖.
    fn update_config(&mut self, _new_config: Config) {}
}
