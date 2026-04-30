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

/// OpenAI Codex 引擎配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCodeConfig {
    /// Codex CLI 命令路径
    pub cli_path: String,
}

impl Default for CodexCodeConfig {
    fn default() -> Self {
        Self {
            cli_path: "codex".to_string(),
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
    /// OpenAI Codex 引擎
    Codex,
}


impl EngineId {
    /// 转换为字符串
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    /// 从字符串解析
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude-code" => Some(Self::ClaudeCode),
            "codex" | "openai-codex" | "openai_codex" => Some(Self::Codex),
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
    pub fn parse(s: &str) -> Option<Self> {
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

/// 模型 Profile — 描述一个第三方 Anthropic 兼容端点配置
///
/// 通过 --settings 临时文件 + 环境变量覆盖，让 Claude Code CLI
/// 将请求路由到用户配置的第三方 Anthropic 协议兼容代理端点，
/// 从而使用非官方模型。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    /// 唯一 ID
    pub id: String,
    /// 人可读名称，如 "DeepSeek V4 Pro"
    pub name: String,
    /// Anthropic 协议兼容的 API 端点 URL
    pub base_url: String,
    /// API 密钥
    pub api_key: String,
    /// 目标模型名称（发给代理端点的模型标识）
    pub model: String,
    /// 是否为当前激活 Profile
    #[serde(default)]
    pub active: bool,
    /// 可选：Profile 描述
    #[serde(default)]
    pub description: Option<String>,
    /// 创建时间 (ISO 8601)
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后更新时间 (ISO 8601)
    #[serde(default)]
    pub updated_at: Option<String>,
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

/// 唤醒词配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeWordConfig {
    /// 是否启用唤醒词模式
    #[serde(default)]
    pub enabled: bool,

    /// 唤醒词列表
    #[serde(default)]
    pub words: Vec<String>,
}

/// 语音提醒配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceNotificationConfig {
    /// 是否启用语音提醒（总开关）
    #[serde(default = "default_notif_enabled")]
    pub enabled: bool,

    /// 发送确认：消息发送后播报
    #[serde(default = "default_notif_send_confirm")]
    pub send_confirm: bool,

    /// 发送确认文本
    #[serde(default = "default_notif_send_confirm_text")]
    pub send_confirm_text: String,

    /// 唤醒回应：唤醒词匹配后播报
    #[serde(default = "default_notif_wake_response")]
    pub wake_response: bool,

    /// 唤醒回应语列表（随机选一个）
    #[serde(default = "default_notif_wake_response_texts")]
    pub wake_response_texts: Vec<String>,

    /// 错误提醒：出错时播报
    #[serde(default = "default_notif_error_alert")]
    pub error_alert: bool,

    /// 错误提醒文本
    #[serde(default = "default_notif_error_alert_text")]
    pub error_alert_text: String,

    /// 后台回复完成通知
    #[serde(default = "default_notif_background_notify")]
    pub background_notify: bool,

    /// 后台完成通知文本
    #[serde(default = "default_notif_background_notify_text")]
    pub background_notify_text: String,
}

fn default_notif_enabled() -> bool { true }
fn default_notif_send_confirm() -> bool { true }
fn default_notif_send_confirm_text() -> String { "已发送".to_string() }
fn default_notif_wake_response() -> bool { true }
fn default_notif_wake_response_texts() -> Vec<String> {
    vec!["在的".to_string(), "我在".to_string(), "嗯嗯".to_string()]
}
fn default_notif_error_alert() -> bool { true }
fn default_notif_error_alert_text() -> String { "出错了".to_string() }
fn default_notif_background_notify() -> bool { true }
fn default_notif_background_notify_text() -> String { "后台任务完成了".to_string() }

impl Default for VoiceNotificationConfig {
    fn default() -> Self {
        Self {
            enabled: default_notif_enabled(),
            send_confirm: default_notif_send_confirm(),
            send_confirm_text: default_notif_send_confirm_text(),
            wake_response: default_notif_wake_response(),
            wake_response_texts: default_notif_wake_response_texts(),
            error_alert: default_notif_error_alert(),
            error_alert_text: default_notif_error_alert_text(),
            background_notify: default_notif_background_notify(),
            background_notify_text: default_notif_background_notify_text(),
        }
    }
}

/// 语音命令条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCommandEntry {
    /// 命令类型 (send/clear/undo/interrupt)
    #[serde(rename = "type")]
    pub command_type: String,

    /// 显示名称
    pub label: String,

    /// 触发关键词列表
    pub keywords: Vec<String>,
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

/// Web 访问层配置（LAN HTTP/WS 服务）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebConfig {
    /// 是否启用 Web 服务（默认不启动）
    #[serde(default)]
    pub enabled: bool,

    /// 监听地址
    #[serde(default = "default_web_host")]
    pub host: String,

    /// 监听端口
    #[serde(default = "default_web_port")]
    pub port: u16,

    /// 认证 Token（None → 首次启动自动生成）
    #[serde(default)]
    pub token: Option<String>,
}

fn default_web_host() -> String { "0.0.0.0".to_string() }
fn default_web_port() -> u16 { 9800 }

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            host: default_web_host(),
            port: default_web_port(),
            token: None,
        }
    }
}

/// 应用配置（新版本）
///
/// 使用嵌套结构，支持多个 AI 引擎
/// 工作区条目（持久化到配置文件，跨桌面/Web 共享）
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    /// 唯一 ID
    pub id: String,
    /// 工作区名称
    pub name: String,
    /// 绝对路径
    pub path: String,
    /// 创建时间 ISO 8601
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后访问时间 ISO 8601
    #[serde(default)]
    pub last_accessed: Option<String>,
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

    /// OpenAI Codex 引擎配置
    #[serde(default)]
    pub codex_code: CodexCodeConfig,

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

    /// 唤醒词配置
    #[serde(default)]
    pub wake_word: Option<WakeWordConfig>,

    /// 语音提醒配置
    #[serde(default)]
    pub voice_notification: Option<VoiceNotificationConfig>,

    /// 语音命令配置（自定义关键词）
    #[serde(default)]
    pub voice_commands: Option<Vec<VoiceCommandEntry>>,

    /// Web 访问层配置
    #[serde(default)]
    pub web: WebConfig,

    /// 工作区列表（跨桌面/Web 共享，持久化到配置文件）
    #[serde(default)]
    pub workspaces: Vec<WorkspaceEntry>,

    /// 当前激活的工作区 ID
    #[serde(default)]
    pub current_workspace_id: Option<String>,

    /// 模型 Profile 列表（配置第三方 Anthropic 兼容端点）
    #[serde(default)]
    pub model_profiles: Vec<ModelProfile>,

    /// 当前激活的模型 Profile ID（为空时使用官方模型）
    #[serde(default)]
    pub active_model_profile_id: Option<String>,

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
            codex_code: CodexCodeConfig::default(),
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
            wake_word: None,
            voice_notification: None,
            voice_commands: None,
            web: WebConfig::default(),
            workspaces: Vec::new(),
            current_workspace_id: None,
            model_profiles: Vec::new(),
            active_model_profile_id: None,
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

    /// 获取 Codex CLI 命令路径
    pub fn get_codex_cmd(&self) -> String {
        self.codex_code.cli_path.clone()
    }

    /// 确保 default_engine 有效
    pub fn validate(&mut self) {
        if EngineId::parse(&self.default_engine).is_none() {
            self.default_engine = "claude-code".to_string();
        }
    }

    /// 获取当前引擎 ID
    pub fn get_engine_id(&self) -> EngineId {
        EngineId::parse(&self.default_engine)
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
