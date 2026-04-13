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

/// 引擎 ID 类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum EngineId {
    /// Claude Code 引擎
    #[default]
    ClaudeCode,
}


impl EngineId {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
        }
    }

    /// 从字符串解析
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "claude-code" => Some(Self::ClaudeCode),
            _ => None,
        }
    }
}

/// 悬浮窗模式
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
#[derive(Default)]
pub enum FloatingWindowMode {
    /// 自动模式：鼠标移出主窗口自动切换到悬浮窗
    #[default]
    Auto,
    /// 手动模式：需要手动触发悬浮窗
    Manual,
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
#[derive(Default)]
pub struct BaiduTranslateConfig {
    /// 百度翻译 App ID
    #[serde(default)]
    pub app_id: String,

    /// 百度翻译密钥
    #[serde(default)]
    pub secret_key: String,
}

/// QQ Bot 实例配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QQBotInstanceConfig {
    /// 实例 ID
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 是否启用
    #[serde(default = "default_instance_enabled")]
    pub enabled: bool,
    /// 应用 ID
    #[serde(default)]
    pub app_id: String,
    /// 应用密钥
    #[serde(default)]
    pub client_secret: String,
    /// 是否沙箱环境
    #[serde(default)]
    pub sandbox: bool,
    /// 消息显示模式
    #[serde(default)]
    pub display_mode: IntegrationDisplayMode,
    /// 启动时自动连接
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
    /// 创建时间 (ISO 8601 格式)
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后活跃时间 (ISO 8601 格式)
    #[serde(default)]
    pub last_active: Option<String>,
    /// 默认工作目录（新会话自动使用）
    #[serde(default)]
    pub work_dir: Option<String>,
}

fn default_instance_enabled() -> bool { true }
fn default_auto_connect() -> bool { true }

impl Default for QQBotInstanceConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "QQ Bot".to_string(),
            enabled: true,
            app_id: String::new(),
            client_secret: String::new(),
            sandbox: false,
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            created_at: None,
            last_active: None,
            work_dir: None,
        }
    }
}

/// QQ Bot 单个实例运行时配置（用于适配器）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QQBotRuntimeConfig {
    /// 是否启用
    #[serde(default)]
    pub enabled: bool,
    /// 应用 ID
    #[serde(default)]
    pub app_id: String,
    /// 应用密钥
    #[serde(default)]
    pub client_secret: String,
    /// 是否沙箱环境
    #[serde(default)]
    pub sandbox: bool,
    /// 消息显示模式
    #[serde(default)]
    pub display_mode: IntegrationDisplayMode,
    /// 启动时自动连接
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
    /// 默认工作目录
    #[serde(default)]
    pub work_dir: Option<String>,
}

impl Default for QQBotRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: String::new(),
            client_secret: String::new(),
            sandbox: false,
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            work_dir: None,
        }
    }
}

impl From<&QQBotInstanceConfig> for QQBotRuntimeConfig {
    fn from(instance: &QQBotInstanceConfig) -> Self {
        Self {
            enabled: instance.enabled,
            app_id: instance.app_id.clone(),
            client_secret: instance.client_secret.clone(),
            sandbox: instance.sandbox,
            display_mode: instance.display_mode.clone(),
            auto_connect: instance.auto_connect,
            work_dir: instance.work_dir.clone(),
        }
    }
}

/// QQ Bot 集成配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QQBotConfig {
    /// 是否启用 QQ Bot 集成（全局开关）
    #[serde(default)]
    pub enabled: bool,

    /// QQ Bot 实例列表（统一存储）
    #[serde(default)]
    pub instances: Vec<QQBotInstanceConfig>,

    /// 当前激活的实例 ID
    #[serde(default)]
    pub active_instance_id: Option<String>,
}

/// 消息显示模式
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IntegrationDisplayMode {
    /// 在 AI 对话中显示
    #[default]
    Chat,
    /// 独立面板显示
    Separate,
    /// 两处都显示
    Both,
}

impl Default for QQBotConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            instances: Vec::new(),
            active_instance_id: None,
        }
    }
}

/// Feishu (飞书) 实例配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuInstanceConfig {
    /// 实例 ID
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 是否启用
    #[serde(default = "default_instance_enabled")]
    pub enabled: bool,
    /// 应用 ID (App ID)
    #[serde(default)]
    pub app_id: String,
    /// 应用密钥 (App Secret)
    #[serde(default)]
    pub app_secret: String,
    /// 事件验证 Token
    #[serde(default)]
    pub verification_token: String,
    /// 事件加密 Key
    #[serde(default)]
    pub encrypt_key: String,
    /// 消息显示模式
    #[serde(default)]
    pub display_mode: IntegrationDisplayMode,
    /// 启动时自动连接
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
    /// 创建时间 (ISO 8601 格式)
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后活跃时间 (ISO 8601 格式)
    #[serde(default)]
    pub last_active: Option<String>,
    /// 默认工作目录（新会话自动使用）
    #[serde(default)]
    pub work_dir: Option<String>,
}

impl Default for FeishuInstanceConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "Feishu Bot".to_string(),
            enabled: true,
            app_id: String::new(),
            app_secret: String::new(),
            verification_token: String::new(),
            encrypt_key: String::new(),
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            created_at: None,
            last_active: None,
            work_dir: None,
        }
    }
}

/// Feishu 单个实例运行时配置（用于适配器）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuRuntimeConfig {
    /// 是否启用
    #[serde(default)]
    pub enabled: bool,
    /// 应用 ID (App ID)
    #[serde(default)]
    pub app_id: String,
    /// 应用密钥 (App Secret)
    #[serde(default)]
    pub app_secret: String,
    /// 事件验证 Token
    #[serde(default)]
    pub verification_token: String,
    /// 事件加密 Key
    #[serde(default)]
    pub encrypt_key: String,
    /// 消息显示模式
    #[serde(default)]
    pub display_mode: IntegrationDisplayMode,
    /// 启动时自动连接
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
    /// 默认工作目录
    #[serde(default)]
    pub work_dir: Option<String>,
}

impl Default for FeishuRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: String::new(),
            app_secret: String::new(),
            verification_token: String::new(),
            encrypt_key: String::new(),
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            work_dir: None,
        }
    }
}

impl From<&FeishuInstanceConfig> for FeishuRuntimeConfig {
    fn from(instance: &FeishuInstanceConfig) -> Self {
        Self {
            enabled: instance.enabled,
            app_id: instance.app_id.clone(),
            app_secret: instance.app_secret.clone(),
            verification_token: instance.verification_token.clone(),
            encrypt_key: instance.encrypt_key.clone(),
            display_mode: instance.display_mode.clone(),
            auto_connect: instance.auto_connect,
            work_dir: instance.work_dir.clone(),
        }
    }
}

/// Feishu 集成配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeishuConfig {
    /// 是否启用飞书集成（全局开关）
    #[serde(default)]
    pub enabled: bool,
    /// 飞书实例列表
    #[serde(default)]
    pub instances: Vec<FeishuInstanceConfig>,
    /// 当前激活的实例 ID
    #[serde(default)]
    pub active_instance_id: Option<String>,
}

impl Default for FeishuConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            instances: Vec::new(),
            active_instance_id: None,
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

/// 窗口设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSettings {
    /// 大窗模式透明度 (0 - 100)
    #[serde(default = "default_normal_opacity")]
    pub normal_opacity: u8,

    /// 小屏模式透明度 (0 - 100)
    #[serde(default = "default_compact_opacity")]
    pub compact_opacity: u8,
}

fn default_normal_opacity() -> u8 {
    100
}

fn default_compact_opacity() -> u8 {
    100
}

impl Default for WindowSettings {
    fn default() -> Self {
        Self {
            normal_opacity: default_normal_opacity(),
            compact_opacity: default_compact_opacity(),
        }
    }
}

/// 语音识别配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeechConfig {
    /// 是否启用语音输入
    #[serde(default = "default_speech_enabled")]
    pub enabled: bool,

    /// 识别语言 (默认 "zh-CN")
    #[serde(default = "default_speech_language")]
    pub language: String,
}

fn default_speech_enabled() -> bool { true }
fn default_speech_language() -> String { "zh-CN".to_string() }

impl Default for SpeechConfig {
    fn default() -> Self {
        Self {
            enabled: default_speech_enabled(),
            language: default_speech_language(),
        }
    }
}

/// TTS 语音合成配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TTSConfig {
    /// 是否启用语音输出
    #[serde(default)]
    pub enabled: bool,

    /// 语音角色 (如 "zh-CN-XiaoxiaoNeural")
    #[serde(default = "default_tts_voice")]
    pub voice: String,

    /// 语速调整 (如 "+0%", "+20%", "-20%")
    #[serde(default = "default_tts_rate")]
    pub rate: String,

    /// 音量 (0-1)
    #[serde(default = "default_tts_volume")]
    pub volume: f64,

    /// 是否自动播放
    #[serde(default = "default_tts_auto_play")]
    pub auto_play: bool,
}

fn default_tts_voice() -> String { "zh-CN-XiaoxiaoNeural".to_string() }
fn default_tts_rate() -> String { "+0%".to_string() }
fn default_tts_volume() -> f64 { 1.0 }
fn default_tts_auto_play() -> bool { true }

impl Default for TTSConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            voice: default_tts_voice(),
            rate: default_tts_rate(),
            volume: default_tts_volume(),
            auto_play: default_tts_auto_play(),
        }
    }
}

/// 助手 LLM 配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantLLMConfig {
    /// API Base URL
    #[serde(default = "default_llm_base_url")]
    pub base_url: String,

    /// API Key
    #[serde(default)]
    pub api_key: String,

    /// 模型 ID
    #[serde(default = "default_llm_model")]
    pub model: String,

    /// 最大 Token
    #[serde(default = "default_llm_max_tokens")]
    pub max_tokens: u32,

    /// 温度
    #[serde(default = "default_llm_temperature")]
    pub temperature: f32,
}

fn default_llm_base_url() -> String { "https://api.openai.com/v1".to_string() }
fn default_llm_model() -> String { "gpt-4o".to_string() }
fn default_llm_max_tokens() -> u32 { 4096 }
fn default_llm_temperature() -> f32 { 0.7 }

impl Default for AssistantLLMConfig {
    fn default() -> Self {
        Self {
            base_url: default_llm_base_url(),
            api_key: String::new(),
            model: default_llm_model(),
            max_tokens: default_llm_max_tokens(),
            temperature: default_llm_temperature(),
        }
    }
}

/// Claude Code 调用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantClaudeCodeConfig {
    /// 默认执行模式
    #[serde(default = "default_claude_code_mode")]
    pub default_mode: String,

    /// 超时时间（毫秒）
    #[serde(default = "default_claude_code_timeout")]
    pub timeout: u64,
}

fn default_claude_code_mode() -> String { "continue".to_string() }
fn default_claude_code_timeout() -> u64 { 300000 }

impl Default for AssistantClaudeCodeConfig {
    fn default() -> Self {
        Self {
            default_mode: default_claude_code_mode(),
            timeout: default_claude_code_timeout(),
        }
    }
}

/// 系统提示词模式
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum SystemPromptMode {
    /// 追加模式
    #[default]
    Append,
    /// 替换模式
    Replace,
}

/// 系统提示词配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPromptConfig {
    /// 是否启用自定义系统提示词
    #[serde(default)]
    pub enabled: bool,

    /// 模式：append=追加到默认后, replace=完全替换
    #[serde(default)]
    pub mode: SystemPromptMode,

    /// 用户自定义提示词内容
    #[serde(default)]
    pub custom_prompt: String,
}

impl Default for SystemPromptConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            mode: SystemPromptMode::default(),
            custom_prompt: String::new(),
        }
    }
}

/// AI 助手配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConfig {
    /// 是否启用助手模块
    #[serde(default)]
    pub enabled: bool,

    /// LLM 配置
    #[serde(default)]
    pub llm: AssistantLLMConfig,

    /// 系统提示词配置
    #[serde(default)]
    pub system_prompt: SystemPromptConfig,

    /// Claude Code 调用配置
    #[serde(default)]
    pub claude_code: AssistantClaudeCodeConfig,
}

impl Default for AssistantConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            llm: AssistantLLMConfig::default(),
            system_prompt: SystemPromptConfig::default(),
            claude_code: AssistantClaudeCodeConfig::default(),
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

    /// QQ Bot 集成配置
    #[serde(default)]
    pub qqbot: QQBotConfig,

    /// Feishu 集成配置
    #[serde(default)]
    pub feishu: FeishuConfig,

    /// 窗口设置
    #[serde(default)]
    pub window: WindowSettings,

    /// 语音输入配置
    #[serde(default)]
    pub speech: SpeechConfig,

    /// 语音输出配置 (TTS)
    #[serde(default)]
    pub tts: TTSConfig,

    /// AI 助手配置
    #[serde(default)]
    pub assistant: AssistantConfig,

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
            work_dir: None,
            session_dir: None,
            git_bin_path: None,
            floating_window: FloatingWindowConfig::default(),
            baidu_translate: None,
            qqbot: QQBotConfig::default(),
            feishu: FeishuConfig::default(),
            window: WindowSettings::default(),
            speech: SpeechConfig::default(),
            tts: TTSConfig::default(),
            assistant: AssistantConfig::default(),
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

    /// 工作目录
    pub work_dir: Option<String>,

    /// 配置是否有效
    pub config_valid: bool,
}
