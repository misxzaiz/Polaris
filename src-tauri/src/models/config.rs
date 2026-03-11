use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// Claude Code 引擎配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeCodeConfig {
    /// Claude CLI 命令路径
    pub cli_path: String,
}

impl Default for ClaudeCodeConfig {
    fn default() -> Self {
        Self {
            cli_path: "claude".to_string(),
        }
    }
}

/// IFlow 引擎配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IFlowConfig {
    /// IFlow CLI 命令路径（可选，默认为 "iflow"）
    pub cli_path: Option<String>,
}

impl Default for IFlowConfig {
    fn default() -> Self {
        Self {
            cli_path: None,
        }
    }
}

/// Codex 引擎配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexConfig {
    /// Codex CLI 命令路径（可选，默认为 "codex"）
    pub cli_path: Option<String>,
    /// Codex sandbox 模式（workspace-write/read-only/danger-full-access）
    #[serde(default = "default_codex_sandbox_mode")]
    pub sandbox_mode: String,
    /// Codex 审批策略（never/on-request/on-failure/untrusted）
    #[serde(default = "default_codex_approval_policy")]
    pub approval_policy: String,
    /// 是否启用危险全开放（跳过审批和沙箱）
    #[serde(default)]
    pub dangerous_bypass: bool,
}

fn default_codex_sandbox_mode() -> String {
    "workspace-write".to_string()
}

fn default_codex_approval_policy() -> String {
    "never".to_string()
}

impl Default for CodexConfig {
    fn default() -> Self {
        Self {
            cli_path: None,
            sandbox_mode: default_codex_sandbox_mode(),
            approval_policy: default_codex_approval_policy(),
            dangerous_bypass: false,
        }
    }
}

/// OpenAI Provider 配置
///
/// 支持任何 OpenAI 协议兼容的 API 服务
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAIProvider {
    /// 唯一标识符（用于区分不同配置）
    pub id: String,

    /// 显示名称（用户可自定义）
    pub name: String,

    /// API Key
    #[serde(default)]
    pub api_key: String,

    /// API Base URL
    #[serde(default = "default_openai_api_base")]
    pub api_base: String,

    /// 模型名称（完全由用户决定）
    #[serde(default = "default_openai_model")]
    pub model: String,

    /// 温度参数 (0-2)
    #[serde(default = "default_openai_temperature")]
    pub temperature: f64,

    /// 最大 Token 数
    #[serde(default = "default_openai_max_tokens")]
    pub max_tokens: usize,

    /// 是否启用
    #[serde(default = "default_openai_enabled")]
    pub enabled: bool,

    /// 是否支持工具调用（Function Calling）
    ///
    /// 部分OpenAI兼容API不支持tools参数，需要禁用
    #[serde(default = "default_openai_supports_tools")]
    pub supports_tools: bool,
}

fn default_openai_api_base() -> String {
    "https://api.openai.com/v1".to_string()
}

fn default_openai_model() -> String {
    "gpt-4o-mini".to_string()
}

fn default_openai_temperature() -> f64 {
    0.7
}

fn default_openai_max_tokens() -> usize {
    8192
}

fn default_openai_enabled() -> bool {
    true
}

fn default_openai_supports_tools() -> bool {
    false // 默认不启用工具调用，因为很多 API 不支持
}

impl Default for OpenAIProvider {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "New Provider".to_string(),
            api_key: String::new(),
            api_base: default_openai_api_base(),
            model: default_openai_model(),
            temperature: default_openai_temperature(),
            max_tokens: default_openai_max_tokens(),
            enabled: default_openai_enabled(),
            supports_tools: default_openai_supports_tools(),
        }
    }
}

/// 引擎 ID 类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum EngineId {
    /// Claude Code 引擎
    ClaudeCode,
    /// IFlow 引擎
    IFlow,
    /// DeepSeek 引擎
    DeepSeek,
    /// OpenAI Codex 引擎
    Codex,
}

impl Default for EngineId {
    fn default() -> Self {
        Self::ClaudeCode
    }
}

impl EngineId {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::IFlow => "iflow",
            Self::DeepSeek => "deepseek",
            Self::Codex => "codex",
        }
    }

    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude-code" => Some(Self::ClaudeCode),
            "iflow" => Some(Self::IFlow),
            "deepseek" => Some(Self::DeepSeek),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }
}

/// 悬浮窗模式
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FloatingWindowMode {
    /// 自动模式：鼠标移出主窗口自动切换到悬浮窗
    Auto,
    /// 手动模式：需要手动触发悬浮窗
    Manual,
}

impl Default for FloatingWindowMode {
    fn default() -> Self {
        Self::Auto
    }
}

impl FloatingWindowMode {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Manual => "manual",
        }
    }

    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "auto" => Some(Self::Auto),
            "manual" => Some(Self::Manual),
            _ => None,
        }
    }
}

/// 悬浮窗配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloatingWindowConfig {
    /// 是否启用悬浮窗
    #[serde(default = "default_floating_window_enabled")]
    pub enabled: bool,

    /// 悬浮窗模式
    #[serde(default)]
    pub mode: FloatingWindowMode,

    /// 鼠标移到悬浮窗时是否自动展开主窗口
    #[serde(default = "default_floating_window_expand_on_hover")]
    pub expand_on_hover: bool,

    /// 鼠标移出主窗口后切换到悬浮窗的延迟时长（毫秒）
    #[serde(default = "default_floating_window_collapse_delay")]
    pub collapse_delay: u64,
}

/// 百度翻译配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BaiduTranslateConfig {
    /// 百度翻译 App ID
    #[serde(default)]
    pub app_id: String,

    /// 百度翻译密钥
    #[serde(default)]
    pub secret_key: String,
}

/// 钉钉集成配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkConfig {
    /// 是否启用钉钉集成
    #[serde(default)]
    pub enabled: bool,

    /// 钉钉应用的 AppKey
    #[serde(default)]
    pub app_key: String,

    /// 钉钉应用的 AppSecret
    #[serde(default)]
    pub app_secret: String,

    /// 测试群会话 ID (用于测试连接)
    #[serde(default)]
    pub test_conversation_id: String,

    /// Webhook 服务器端口 (用于接收钉钉消息)
    #[serde(default = "default_dingtalk_webhook_port")]
    pub webhook_port: u16,
}

fn default_dingtalk_webhook_port() -> u16 {
    3456
}

impl Default for DingTalkConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_key: String::new(),
            app_secret: String::new(),
            test_conversation_id: String::new(),
            webhook_port: 3456,
        }
    }
}

impl Default for BaiduTranslateConfig {
    fn default() -> Self {
        Self {
            app_id: String::new(),
            secret_key: String::new(),
        }
    }
}

fn default_floating_window_enabled() -> bool {
    false
}

fn default_floating_window_expand_on_hover() -> bool {
    true
}

fn default_floating_window_collapse_delay() -> u64 {
    500
}

impl Default for FloatingWindowConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: FloatingWindowMode::Auto,
            expand_on_hover: true,
            collapse_delay: 500,
        }
    }
}

/// 应用配置（新版本）
///
/// 使用嵌套结构，支持多个 AI 引擎
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// 默认引擎
    #[serde(default = "default_default_engine")]
    pub default_engine: String,

    /// 界面语言
    #[serde(default)]
    pub language: Option<String>,

    /// Claude Code 引擎配置
    #[serde(default)]
    pub claude_code: ClaudeCodeConfig,

    /// IFlow 引擎配置
    #[serde(default)]
    pub iflow: IFlowConfig,

    /// Codex 引擎配置
    #[serde(default)]
    pub codex: CodexConfig,

    /// OpenAI Providers 列表
    #[serde(default)]
    pub openai_providers: Vec<OpenAIProvider>,

    /// 当前选中的 Provider ID
    #[serde(default)]
    pub active_provider_id: Option<String>,

    /// 工作目录
    pub work_dir: Option<PathBuf>,

    /// 会话保存路径
    pub session_dir: Option<PathBuf>,

    /// Git 二进制路径 (Windows)
    pub git_bin_path: Option<String>,

    /// 悬浮窗配置
    #[serde(default)]
    pub floating_window: FloatingWindowConfig,

    /// 百度翻译配置
    #[serde(default)]
    pub baidu_translate: Option<BaiduTranslateConfig>,

    /// 钉钉集成配置
    #[serde(default)]
    pub dingtalk: DingTalkConfig,

    // === 旧字段，保持向后兼容 ===
    /// @deprecated 请使用 claude_code.cli_path
    #[serde(default)]
    pub claude_cmd: Option<String>,
}

fn default_default_engine() -> String {
    "claude-code".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            default_engine: default_default_engine(),
            language: None,
            claude_code: ClaudeCodeConfig::default(),
            iflow: IFlowConfig::default(),
            codex: CodexConfig::default(),
            openai_providers: Vec::new(),
            active_provider_id: None,
            work_dir: None,
            session_dir: None,
            git_bin_path: None,
            floating_window: FloatingWindowConfig::default(),
            baidu_translate: None,
            dingtalk: DingTalkConfig::default(),
            claude_cmd: None,
        }
    }
}

impl Config {
    /// 获取 Claude CLI 命令路径（优先使用新字段）
    pub fn get_claude_cmd(&self) -> String {
        // 首先检查旧字段（用于迁移）
        if let Some(ref cmd) = self.claude_cmd {
            if !cmd.is_empty() {
                return cmd.clone();
            }
        }
        // 使用新字段
        self.claude_code.cli_path.clone()
    }

    /// 确保 default_engine 有效
    pub fn validate(&mut self) {
        if EngineId::from_str(&self.default_engine).is_none() {
            self.default_engine = "claude-code".to_string();
        }
    }

    /// 获取当前引擎 ID
    pub fn get_engine_id(&self) -> EngineId {
        EngineId::from_str(&self.default_engine)
            .unwrap_or(EngineId::ClaudeCode)
    }

    /// 设置默认引擎
    pub fn set_engine_id(&mut self, engine_id: EngineId) {
        self.default_engine = engine_id.as_str().to_string();
    }
}

/// 健康状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthStatus {
    /// Claude CLI 是否可用
    pub claude_available: bool,

    /// Claude 版本
    pub claude_version: Option<String>,

    /// IFlow CLI 是否可用
    pub iflow_available: Option<bool>,

    /// IFlow 版本
    pub iflow_version: Option<String>,

    /// Codex CLI 是否可用
    pub codex_available: Option<bool>,

    /// Codex 版本
    pub codex_version: Option<String>,

    /// OpenAI Providers 配置数量
    pub openai_providers_count: Option<usize>,

    /// 是否配置了 OpenAI Providers
    pub openai_providers_configured: Option<bool>,

    /// 工作目录
    pub work_dir: Option<String>,

    /// 配置是否有效
    pub config_valid: bool,
}
