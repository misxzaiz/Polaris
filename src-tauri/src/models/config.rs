use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
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

/// Pi Code 引擎配置（earendil-works pi-coding-agent）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiCodeConfig {
    /// Pi CLI 命令路径
    #[serde(alias = "cli_path")]
    pub cli_path: String,
    /// 是否启用 Pi MCP 桥接（Pi Extension 桥接）。
    /// 开启后，Polaris 会把 MCP server 列表写入
    /// `~/.pi/agent/extensions/polaris-mcp-bridge/`，并通过显式 `--extension`
    /// 注入 Pi，让 Pi 通过 Extension 桥接消费 Polaris MCP 工具生态。
    /// 默认关闭：需用户显式确认。
    #[serde(default, alias = "enable_extensions")]
    pub enable_extensions: bool,
}

impl Default for PiCodeConfig {
    fn default() -> Self {
        Self {
            cli_path: "pi".to_string(),
            enable_extensions: false,
        }
    }
}

// EngineId 的定义统一在 crate::ai::EngineId（ai/traits.rs）。
// 此处仅做兼容性重导出，避免破坏现有引用路径。
//
// 约定：
// - 新代码请直接 `use crate::ai::EngineId`
// - 存量 `use crate::models::config::EngineId` 仍可编译，但应逐步迁移
//
// MEMORY: [[dual-engineid-sync]]
pub use crate::ai::EngineId;

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

/// Personal Hub 内部插件配置
///
/// 集成 personal-hub 的 Supabase 接入与字段级加密能力。
/// URL / anon key 公开，依赖 Supabase RLS 做行级隔离；
/// 加密密钥用于 links 表 description 字段的 AES 口令模式加解密。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonalHubConfig {
    /// Supabase 项目 URL，如 https://xxxx.supabase.co
    /// 留空时前端使用内置默认值（personal-hub 既有项目）。
    #[serde(default)]
    pub supabase_url: String,

    /// Supabase anon key（公开密钥，配合 RLS 使用）
    /// 留空时前端使用内置默认值。
    #[serde(default)]
    pub supabase_anon_key: String,

    /// 字段级加密密钥（口令字符串，crypto-js AES 口令模式派生）
    #[serde(default)]
    pub encryption_key: String,

    /// Supabase session token（前端登录后写入，供 MCP server 认证使用）
    /// 持久化存储，仅写入非空值；值为空时表示未登录/已登出。
    #[serde(default)]
    pub session_token: String,
}

/// Supabase 默认 URL（personal-hub 既有项目）
fn default_personal_hub_supabase_url() -> String {
    "https://nynpqrwsautudqblxoir.supabase.co".to_string()
}

/// Supabase 默认 anon key（personal-hub 既有项目）
fn default_personal_hub_supabase_anon_key() -> String {
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im55bnBxcndzYXV0dWRxYmx4b2lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjI3MDkzMDksImV4cCI6MjA3ODI4NTMwOX0.rz79QkbbSEQPsrSdbYYFL-nuV_MwdAWhf4-gQ0j_fz4".to_string()
}

impl Default for PersonalHubConfig {
    fn default() -> Self {
        Self {
            supabase_url: default_personal_hub_supabase_url(),
            supabase_anon_key: default_personal_hub_supabase_anon_key(),
            encryption_key: String::new(),
            session_token: String::new(),
        }
    }
}

/// 模型 Profile — 描述一个第三方模型端点配置
///
/// Claude Code 通过 --settings 临时文件 + 环境变量覆盖路由到 Anthropic 兼容端点。
/// Codex CLI 通过 model_provider 配置路由到 Responses API 兼容端点。
///
/// 当 `wire_api` 为 `"openai-chat-completions"` 时，Polaris 内嵌代理会透明地
/// 将 Claude CLI 的 Anthropic Messages 请求转换为 OpenAI Chat Completions
/// 格式发送给上游端点，再将响应转换回 Anthropic 格式返回给 CLI。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    /// 唯一 ID
    pub id: String,
    /// 人可读名称，如 "DeepSeek V4 Pro"
    pub name: String,
    /// API 端点 URL
    pub base_url: String,
    /// API 密钥
    pub api_key: String,
    /// 目标模型名称（发给代理端点的模型标识）
    pub model: String,
    /// 该供应商可选模型列表；为空时回退到 model
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_options: Option<Vec<String>>,
    /// 是否为当前激活 Profile
    #[serde(default)]
    pub active: bool,
    /// Wire API 协议格式。
    /// - `None` 或 `"anthropic-messages"`：端点兼容 Anthropic Messages API（默认）
    /// - `"openai-chat-completions"`：端点兼容 OpenAI Chat Completions API，
    ///   Polaris 内嵌代理负责格式转换
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wire_api: Option<String>,
    /// 适用的引擎（多选）。
    /// - `None` 或空数组：适用于所有引擎
    /// - 非空数组：仅适用于列出的引擎
    /// - 引擎标识：`"claude"` / `"codex"` / `"simple-ai"`
    ///
    /// 历史兼容：旧数据使用 `target_engine: Option<String>` 单值字段，
    /// 由 `resolve_target_engines()` 做回退迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_engines: Option<Vec<String>>,
    /// 历史兼容字段（仅用于反序列化旧数据，不再写入）。
    /// 由 `resolve_target_engines()` 做回退迁移。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_engine: Option<String>,
    /// 供应商分类。
    /// - `"official"`：官方直连（Anthropic / OpenAI）
    /// - `"cn_official"`：国内官方直连
    /// - `"aggregator"`：API 聚合/转售平台
    /// - `"third_party"`：第三方供应商
    /// - `"custom"`：用户自定义端点
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    /// 可选：Profile 描述
    #[serde(default)]
    pub description: Option<String>,
    /// 上次从端点拉取的模型列表（仅前端 UI 缓存用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fetched_models: Option<Vec<String>>,
    /// 认证方式：auth_token（默认）/ api_key / custom_env / none。
    /// None 时按 "auth_token" 处理，兼容旧数据。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_type: Option<String>,
    /// authType='custom_env' 时使用的环境变量名
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_env_name: Option<String>,
    /// 自定义请求头（连接测试与代理转发时附加）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_headers: Option<std::collections::HashMap<String, String>>,
    /// 注入 CLI 子进程的额外环境变量
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_env: Option<std::collections::HashMap<String, String>>,
    /// 单次响应输出 token 上限（max_tokens）。
    /// - None：OpenAI Chat 协议不发该字段（用供应商默认）；Anthropic/Responses 协议回退 8192（必填/建议填）。
    /// - Some(v)：三协议均显式携带。仅 SimpleAI 引擎请求路径生效。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u64>,
    /// 上下文窗口（token），驱动 SimpleAI 压缩触发阈值（window × 0.75）。
/// None → custom_env `SIMPLE_AI_CONTEXT_WINDOW`（向后兼容）→ 默认 180_000。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window: Option<u64>,
    /// 创建时间 (ISO 8601)
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后更新时间 (ISO 8601)
    #[serde(default)]
    pub updated_at: Option<String>,
}

impl ModelProfile {
    /// 解析适用引擎列表，兼容旧数据。
    ///
    /// 优先级：
    /// 1. `target_engines` 非空 → 直接返回
    /// 2. 旧字段 `target_engine`：
    ///    - `"both"` / `"all"` / `None` → 返回空 Vec（全选）
    ///    - 单值 → 返回包含该值的 Vec
    /// 3. 无旧字段 → 返回空 Vec（全选）
    pub fn resolve_target_engines(&self) -> Vec<String> {
        if let Some(ref engines) = self.target_engines {
            if !engines.is_empty() {
                return engines.clone();
            }
        }
        match self.target_engine.as_deref() {
            None | Some("both") | Some("all") => vec![],
            Some(engine) => vec![engine.to_string()],
        }
    }

    /// 判断 Profile 是否适用于指定引擎。
    /// 空列表 = 全选 = 适用于所有引擎。
    pub fn is_for_engine(&self, engine: &str) -> bool {
        let engines = self.resolve_target_engines();
        engines.is_empty() || engines.contains(&engine.to_string())
    }
}

// ============================================================================
// 供应商分组与 failover/轮询
// ============================================================================

/// 供应商分组路由策略
///
/// - `Failover`：主备切换。按 `priority` 升序，主 Profile 失败自动切备；
///   同 priority 内轮询。最贴合"超时自动切换"诉求。
/// - `RoundRobin`：纯轮询。每次新会话轮转 Profile，会话内锁定（会话亲和）。
/// - `Weighted`：加权随机。按 `weight` 选择，可结合成本/速率。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RouteStrategy {
    Failover,
    RoundRobin,
    Weighted,
}

impl Default for RouteStrategy {
    fn default() -> Self {
        Self::Failover
    }
}

/// 触发 failover 的错误模式
///
/// 用于判定 `start_session` 后的异步错误是否应切换到组内下一个 Profile。
/// 只有"首字前失败"（尚未向用户输出 assistant token）才允许透明切换。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum FailoverPattern {
    /// HTTP 状态码命中（如 401/403/429/5xx）。
    /// `code = 500` 代表整个 5xx 段（500-599）。
    HttpStatus { code: u16 },
    /// 首字超时：CLI 进程已起，但在 `first_token_timeout_secs` 内未输出首段 token。
    FirstTokenTimeout,
    /// 连接被拒：spawn 后立即崩溃（如 CLI 路径错、代理起不来）。
    ConnectionRefused,
    /// stderr 关键词匹配（兜底，不同供应商错误格式不统一）。
    StderrContains { pattern: String },
}

impl FailoverPattern {
    /// 默认 failover 触发模式集（空 `failover_on` 时使用）。
    pub fn defaults() -> Vec<Self> {
        vec![
            Self::HttpStatus { code: 401 },
            Self::HttpStatus { code: 403 },
            Self::HttpStatus { code: 429 },
            Self::HttpStatus { code: 500 }, // 5xx 全段
            Self::FirstTokenTimeout,
            Self::ConnectionRefused,
        ]
    }
}

/// 分组成员：一个 Profile 在分组中的路由元数据
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupMember {
    /// 关联的 ModelProfile ID
    pub profile_id: String,
    /// Failover 策略：数字小优先；同 priority 内轮询
    #[serde(default = "default_group_priority")]
    pub priority: u32,
    /// Weighted 策略：权重值
    #[serde(default = "default_group_weight")]
    pub weight: u32,
}

fn default_group_priority() -> u32 {
    0
}
fn default_group_weight() -> u32 {
    1
}

/// 供应商分组
///
/// 将多个 ModelProfile 组成一个高可用/负载均衡分组。新会话首请求按策略
/// 选择 Profile；请求失败（符合 `failover_on` 模式）时自动切换到组内下一个
/// 可用 Profile，对用户透明（前提是尚未输出首段 token）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderGroup {
    /// 唯一 ID
    pub id: String,
    /// 人可读名称
    pub name: String,
    /// 路由策略
    #[serde(default)]
    pub strategy: RouteStrategy,
    /// 成员列表（Failover 策略下按 priority 升序处理）
    pub members: Vec<GroupMember>,
    /// 触发 failover 的错误模式。空 = 使用 `FailoverPattern::defaults()`
    #[serde(default)]
    pub failover_on: Vec<FailoverPattern>,
    /// spawn 后首字超时秒数。None = 不做首字超时检测
    #[serde(default)]
    pub first_token_timeout_secs: Option<u64>,
    /// 最多 failover 次数（防全死循环），默认 3
    #[serde(default = "default_max_failover")]
    pub max_failover_attempts: u32,
    /// 是否启用（false = 跳过此组，回退单 Profile）
    #[serde(default = "default_group_active")]
    pub active: bool,
}

fn default_max_failover() -> u32 {
    3
}
fn default_group_active() -> bool {
    true
}

impl ProviderGroup {
    /// 解析实际生效的 failover 模式（空则用默认）
    pub fn effective_patterns(&self) -> Vec<FailoverPattern> {
        if self.failover_on.is_empty() {
            FailoverPattern::defaults()
        } else {
            self.failover_on.clone()
        }
    }

    /// 按 strategy 返回成员的处理顺序（Failover：priority 升序；其他：原序）
    pub fn ordered_members(&self) -> Vec<&GroupMember> {
        let mut refs: Vec<&GroupMember> = self.members.iter().collect();
        if matches!(self.strategy, RouteStrategy::Failover) {
            refs.sort_by_key(|m| m.priority);
        }
        refs
    }
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

/// DingTalk (钉钉) 实例配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkInstanceConfig {
    /// 实例 ID
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 是否启用
    #[serde(default = "default_instance_enabled")]
    pub enabled: bool,
    /// 应用 Key (App Key)
    #[serde(default)]
    pub app_key: String,
    /// 应用密钥 (App Secret)
    #[serde(default)]
    pub app_secret: String,
    /// 企业机器人 Webhook URL（用于发送回复）
    #[serde(default)]
    pub webhook_url: String,
    /// 消息显示模式
    #[serde(default)]
    pub display_mode: IntegrationDisplayMode,
    /// 启动时自动连接
    #[serde(default = "default_auto_connect")]
    pub auto_connect: bool,
    /// 创建时间 (ISO 8601)
    #[serde(default)]
    pub created_at: Option<String>,
    /// 最后活跃时间 (ISO 8601)
    #[serde(default)]
    pub last_active: Option<String>,
    /// 默认工作目录（新会话自动使用）
    #[serde(default)]
    pub work_dir: Option<String>,
}

impl Default for DingTalkInstanceConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: "DingTalk Bot".to_string(),
            enabled: true,
            app_key: String::new(),
            app_secret: String::new(),
            webhook_url: String::new(),
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            created_at: None,
            last_active: None,
            work_dir: None,
        }
    }
}

/// DingTalk 单个实例运行时配置（用于适配器）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkRuntimeConfig {
    /// 是否启用
    #[serde(default)]
    pub enabled: bool,
    /// 应用 Key (App Key)
    #[serde(default)]
    pub app_id: String,
    /// 应用密钥 (App Secret)
    #[serde(default)]
    pub app_secret: String,
    /// 企业机器人 Webhook URL（用于发送回复）
    #[serde(default)]
    pub webhook_url: String,
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

impl Default for DingTalkRuntimeConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            app_id: String::new(),
            app_secret: String::new(),
            webhook_url: String::new(),
            display_mode: IntegrationDisplayMode::default(),
            auto_connect: true,
            work_dir: None,
        }
    }
}

impl From<&DingTalkInstanceConfig> for DingTalkRuntimeConfig {
    fn from(instance: &DingTalkInstanceConfig) -> Self {
        Self {
            enabled: instance.enabled,
            app_id: instance.app_key.clone(),
            app_secret: instance.app_secret.clone(),
            webhook_url: instance.webhook_url.clone(),
            display_mode: instance.display_mode.clone(),
            auto_connect: instance.auto_connect,
            work_dir: instance.work_dir.clone(),
        }
    }
}

/// DingTalk 集成配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DingTalkConfig {
    /// 是否启用钉钉集成（全局开关）
    #[serde(default)]
    pub enabled: bool,
    /// 钉钉实例列表
    #[serde(default)]
    pub instances: Vec<DingTalkInstanceConfig>,
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

/// 对话显示密度
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatDisplayDensity {
    Compact,
    Comfortable,
    Spacious,
}

impl Default for ChatDisplayDensity {
    fn default() -> Self {
        Self::Comfortable
    }
}

/// 对话字体族
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ChatDisplayFontFamily {
    System,
    Serif,
    Mono,
}

impl Default for ChatDisplayFontFamily {
    fn default() -> Self {
        Self::System
    }
}

/// AI 对话窗口显示设置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatDisplaySettings {
    /// 正文字号 (px)
    #[serde(default = "default_chat_font_size")]
    pub font_size: u8,
    /// 正文行高
    #[serde(default = "default_chat_line_height")]
    pub line_height: f32,
    /// Markdown 段落间距 (px)
    #[serde(default = "default_chat_paragraph_spacing")]
    pub paragraph_spacing: u8,
    /// 消息垂直密度
    #[serde(default)]
    pub message_spacing: ChatDisplayDensity,
    /// AI 正文最大宽度 (ch)
    #[serde(default = "default_chat_content_width")]
    pub content_width: u8,
    /// 代码字号 (px)
    #[serde(default = "default_chat_code_font_size")]
    pub code_font_size: u8,
    /// 输入框字号 (px)，为空时跟随正文字号
    #[serde(default)]
    pub input_font_size: Option<u8>,
    /// 对话字体族
    #[serde(default)]
    pub font_family: ChatDisplayFontFamily,
}

fn default_chat_font_size() -> u8 { 14 }
fn default_chat_line_height() -> f32 { 1.55 }
fn default_chat_paragraph_spacing() -> u8 { 4 }
fn default_chat_content_width() -> u8 { 78 }
fn default_chat_code_font_size() -> u8 { 13 }

impl Default for ChatDisplaySettings {
    fn default() -> Self {
        Self {
            font_size: default_chat_font_size(),
            line_height: default_chat_line_height(),
            paragraph_spacing: default_chat_paragraph_spacing(),
            message_spacing: ChatDisplayDensity::default(),
            content_width: default_chat_content_width(),
            code_font_size: default_chat_code_font_size(),
            input_font_size: None,
            font_family: ChatDisplayFontFamily::default(),
        }
    }
}

impl ChatDisplaySettings {
    pub fn validate(&mut self) {
        self.font_size = self.font_size.clamp(12, 20);
        self.line_height = self.line_height.clamp(1.35, 1.8);
        self.paragraph_spacing = self.paragraph_spacing.clamp(0, 12);
        self.content_width = self.content_width.clamp(60, 90);
        self.code_font_size = self.code_font_size.clamp(11, 18);
        self.input_font_size = self.input_font_size.map(|size| size.clamp(12, 20));
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

    /// 听写快捷键触发模式 (默认 "toggle")
    #[serde(default = "default_speech_dictation_mode")]
    pub dictation_mode: String,

    /// 是否启用 Ctrl/Cmd+D 听写快捷键 (默认 true)
    #[serde(default = "default_speech_dictation_shortcut_enabled")]
    pub dictation_shortcut_enabled: bool,
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
fn default_speech_dictation_mode() -> String { "toggle".to_string() }
fn default_speech_dictation_shortcut_enabled() -> bool { true }

impl Default for SpeechConfig {
    fn default() -> Self {
        Self {
            enabled: default_speech_enabled(),
            language: default_speech_language(),
            dictation_mode: default_speech_dictation_mode(),
            dictation_shortcut_enabled: default_speech_dictation_shortcut_enabled(),
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
    /// 是否启用 Web 服务（默认启动，可在设置中关闭）
    #[serde(default = "default_web_enabled")]
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
fn default_web_port() -> u16 { 9830 }
fn default_web_enabled() -> bool { true }

impl Default for WebConfig {
    fn default() -> Self {
        Self {
            enabled: default_web_enabled(),
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

/// 终端脚本配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalScriptItem {
    /// 唯一 ID
    pub id: String,
    /// 显示名称
    pub name: String,
    /// 实际执行命令
    pub command: String,
    /// 工作目录
    #[serde(default)]
    pub cwd: Option<String>,
    /// 环境变量
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    /// 标签
    #[serde(default)]
    pub tags: Vec<String>,
    /// 来源，如 package.json 或 user
    #[serde(default)]
    pub source: String,
    /// 来源文件
    #[serde(default)]
    pub source_path: Option<String>,
    /// 是否启用
    #[serde(default = "default_terminal_script_enabled")]
    pub enabled: bool,
    /// 是否自动执行
    #[serde(default)]
    pub auto_run: bool,
    /// 自动执行时机：app_start / workspace_open / terminal_open
    #[serde(default)]
    pub auto_run_trigger: Option<String>,
    /// 自动执行前是否需要确认
    #[serde(default)]
    pub confirm_before_auto_run: bool,
}

fn default_terminal_script_enabled() -> bool {
    true
}

/// 工作区终端脚本配置
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTerminalScripts {
    /// 用户保存或覆盖的脚本
    #[serde(default)]
    pub scripts: Vec<TerminalScriptItem>,
    /// 已隐藏的项目发现脚本 ID
    #[serde(default)]
    pub hidden_discovered_script_ids: Vec<String>,
}

/// 交互配置（AskUserQuestion 等同回合交互能力）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionConfig {
    /// 是否允许 AI 在对话中通过 polaris-ask MCP 弹出问题卡片。
    /// 关闭后将不向 CLI 注入 polaris-ask server，AI 不再能主动提问。
    #[serde(default = "default_interaction_ask_enabled")]
    pub ask_mcp_enabled: bool,
}

impl Default for InteractionConfig {
    fn default() -> Self {
        Self {
            ask_mcp_enabled: true,
        }
    }
}

fn default_interaction_ask_enabled() -> bool {
    true
}

/// 派发队员预设：用户预定义"角色 → 引擎/供应商/模型/职责提示词"组合，
/// AI 派发时按角色名引用（dispatch_task 的 role 参数），成本与安全由用户掌控。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DispatchPreset {
    /// 唯一 ID
    pub id: String,
    /// 角色名（如"测试员"），dispatch_task role 参数按此匹配
    pub name: String,
    /// 引擎 ID（如 "claude-code"）
    pub engine_id: String,
    /// 模型 Profile ID（第三方端点）；None = 官方端点
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_profile_id: Option<String>,
    /// 具体模型名；None = 引擎/Profile 默认
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// 角色职责系统提示词（追加注入派发会话）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub append_system_prompt: Option<String>,
    /// 权限模式；None = 继承默认
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
}

/// 派发任务配置（dispatch_task MCP 行为）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchConfig {
    /// 派发策略："auto"（默认，直接执行）| "ask"（每次派发弹确认）
    #[serde(default = "default_dispatch_policy")]
    pub policy: String,
    /// 派发任务完成后是否把结果摘要注入来源会话的下一回合（一次性系统提示）
    #[serde(default = "default_dispatch_auto_inject")]
    pub auto_inject_reports: bool,
    /// 队员预设列表
    #[serde(default)]
    pub presets: Vec<DispatchPreset>,
}

impl Default for DispatchConfig {
    fn default() -> Self {
        Self {
            policy: default_dispatch_policy(),
            auto_inject_reports: default_dispatch_auto_inject(),
            presets: Vec::new(),
        }
    }
}

fn default_dispatch_policy() -> String {
    "auto".to_string()
}

fn default_dispatch_auto_inject() -> bool {
    true
}

/// Spider-Man 沉浸主题配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpiderManThemeConfig {
    /// 背景图片 URL（空字符串 = 使用预设）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_image: Option<String>,
    /// 背景图片透明度 (0-1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_opacity: Option<f64>,
    /// 面板背景透明度 (0-1)，控制侧栏/聊天面板的透明程度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_opacity: Option<f64>,
    /// 面板磨砂强度 (px)，0=关闭磨砂效果
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub panel_blur: Option<f64>,
    /// 蛛网纹理强度 (0-1)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_texture_opacity: Option<f64>,
    /// 背景缩放模式
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_size: Option<String>,
    /// 背景水平偏移 (0-100)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_position_x: Option<f64>,
    /// 背景垂直偏移 (0-100)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_position_y: Option<f64>,
    /// 面具头像 URL
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    /// 内容卡片透明度 (0-1)，控制消息气泡/卡片/输入框的内容容器半透明程度
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub surface_opacity: Option<f64>,
    /// 蓝色强调强度 (0-1)，0=无蓝色，1=最大蓝色
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blue_accent: Option<f64>,
    /// 聊天工具面板透明度 (0-1)，控制工具调用块/派发卡片等背景
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chat_tool_opacity: Option<f64>,
    /// 悬停态背景透明度 (0-1)，控制按钮/列表项等静态背景区域
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hover_opacity: Option<f64>,
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

    /// 辅助任务引擎（标题生成 / 润色等低频辅助任务的专用引擎）。
    /// None 或空 = 跟随 default_engine。
    /// 用于将辅助任务路由到更便宜的引擎以降本。
    #[serde(default)]
    pub auxiliary_engine: Option<String>,

    /// 界面语言
    #[serde(default)]
    pub language: Option<String>,

    /// 界面主题（"dark" | "light" | "spiderman"）
    #[serde(default)]
    pub theme: Option<String>,

    /// 当前激活的主题 ID（UUID 格式，替换旧 theme 字段）
    #[serde(default)]
    pub active_theme_id: Option<String>,

    /// Claude Code 引擎配置
    #[serde(default)]
    pub claude_code: ClaudeCodeConfig,

    /// OpenAI Codex 引擎配置
    #[serde(default)]
    pub codex_code: CodexCodeConfig,

    /// Pi Code 引擎配置（earendil-works pi-coding-agent）
    #[serde(default)]
    pub pi_code: PiCodeConfig,

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

    /// Personal Hub 内部插件配置
    #[serde(default)]
    pub personal_hub: PersonalHubConfig,

    /// QQ Bot 集成配置
    #[serde(default)]
    pub qqbot: QQBotConfig,

    /// Feishu 集成配置
    #[serde(default)]
    pub feishu: FeishuConfig,

    /// DingTalk 集成配置
    #[serde(default)]
    pub dingtalk: DingTalkConfig,

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

    /// 交互配置（AskUserQuestion 等）
    #[serde(default)]
    pub interaction: InteractionConfig,

    /// 派发任务配置（dispatch_task MCP 策略/结果注入/队员预设）
    #[serde(default)]
    pub dispatch: DispatchConfig,

    /// Spider-Man 沉浸主题配置
    #[serde(default)]
    pub spiderman_theme: Option<SpiderManThemeConfig>,

    /// AI 对话窗口显示设置
    #[serde(default)]
    pub chat_display: ChatDisplaySettings,

    /// 工作区列表（跨桌面/Web 共享，持久化到配置文件）
    #[serde(default)]
    pub workspaces: Vec<WorkspaceEntry>,

    /// 当前激活的工作区 ID
    #[serde(default)]
    pub current_workspace_id: Option<String>,

    /// 工作区终端脚本配置，key 为工作区绝对路径
    #[serde(default)]
    pub terminal_scripts: BTreeMap<String, WorkspaceTerminalScripts>,

    /// 模型 Profile 列表（配置第三方模型端点）
    #[serde(default)]
    pub model_profiles: Vec<ModelProfile>,

    /// 当前激活的模型 Profile ID（为空时使用官方模型）
    #[serde(default)]
    pub active_model_profile_id: Option<String>,

    /// 供应商分组（failover/轮询）。
    ///
    /// 当 `active_provider_group_id` 指向一个存在且 active 的分组时，走分组路由
    /// （在新会话首请求时按策略选 Profile，失败自动切换到组内下一个 Profile）；
    /// 否则回退到 `active_model_profile_id` 单选路径（向后兼容）。
    #[serde(default)]
    pub provider_groups: Vec<ProviderGroup>,

    /// 当前激活的供应商分组 ID。
    /// None 或指向不存在的分组 → 不启用分组，走单 Profile 旧路径。
    #[serde(default)]
    pub active_provider_group_id: Option<String>,

    /// Skill 读取路径列表。支持绝对路径；相对路径由前端按当前工作区解析。
    #[serde(default)]
    pub skill_paths: Vec<String>,

    /// 性能与资源管理：各资源密集型功能的开关。
    /// 所有字段默认关闭（false），用户按需开启。
    /// 详见 docs/performance-features-default-off-plan.md。
    #[serde(default = "default_performance_features")]
    pub performance: PerformanceFeatures,

    // === 旧字段，保持向后兼容 ===
    /// @deprecated 请使用 claude_code.cli_path
    #[serde(default)]
    pub claude_cmd: Option<String>,
}

// ============================================================================
// PerformanceFeatures — 资源密集型功能开关
//
// 设计原则：
// - 所有字段默认 false（默认关闭），用户手动开启
// - 开关变更通过 config-changed 事件热切换，无需重启
// - 关闭时各功能应优雅降级（如 LSP 索引关闭后走 regex_fallback）
// ============================================================================
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PerformanceFeatures {
    /// 文件系统监听（默认关闭）。
    /// 开启后监听工作区文件变化，自动刷新文件树。
    /// 关闭后需用户手动触发刷新。
    #[serde(default)]
    pub file_watcher: bool,

    /// LSP 智能索引（默认关闭）。
    /// 开启后使用 tree-sitter 构建 AST 索引 + SQLite 持久化，
    /// 提供精准的 Java 代码跳转和引用查找。
    /// 关闭后降级为正则匹配（regex_fallback），精度降低但零开销。
    #[serde(default)]
    pub lsp_index: bool,

    /// 调度器守护进程（默认关闭）。
    /// 开启后后台轮询定时任务，到期自动触发执行。
    /// 关闭后定时任务不会自动执行（需手动触发）。
    #[serde(default)]
    pub scheduler_daemon: bool,

    /// 编辑器语法高亮（默认关闭）。
    /// 开启后代码块使用 highlight.js 着色。
    /// 关闭后代码块以等宽字体原样展示。
    #[serde(default)]
    pub syntax_highlighting: bool,

    /// Mermaid 图表渲染（默认关闭）。
    /// 开启后自动将 mermaid 代码块渲染为图表。
    /// 关闭后 mermaid 代码块以普通代码样式展示。
    #[serde(default)]
    pub mermaid_diagrams: bool,

    /// KaTeX 数学公式渲染（默认关闭）。
    /// 开启后自动渲染 LaTeX 数学公式。
    /// 关闭后 LaTeX 语法原样展示。
    #[serde(default)]
    pub katex_math: bool,

    /// 代码编辑器语言包预加载（默认关闭）。
    /// 开启后预加载所有编程语言的高亮/自动补全支持。
    /// 关闭后按需加载（打开文件时按扩展名 dynamic import）。
    #[serde(default)]
    pub code_editor_languages: bool,

    /// 插件服务自动启动（默认关闭）。
    /// 开启后应用启动时自动拉起所有已启用插件的后台服务。
    /// 关闭后首次使用插件功能时才按需启动。
    #[serde(default)]
    pub plugin_auto_start: bool,
}

fn default_performance_features() -> PerformanceFeatures {
    PerformanceFeatures {
        file_watcher: false,
        lsp_index: false,
        scheduler_daemon: false,
        syntax_highlighting: false,
        mermaid_diagrams: false,
        katex_math: false,
        code_editor_languages: false,
        plugin_auto_start: false,
    }
}

fn default_default_engine() -> String {
    "claude-code".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            default_engine: default_default_engine(),
            auxiliary_engine: None,
            language: None,
            theme: None,
            active_theme_id: None,
            claude_code: ClaudeCodeConfig::default(),
            codex_code: CodexCodeConfig::default(),
            pi_code: PiCodeConfig::default(),
            work_dir: None,
            session_dir: None,
            git_bin_path: None,
            floating_window: FloatingWindowConfig::default(),
            baidu_translate: None,
            personal_hub: PersonalHubConfig::default(),
            qqbot: QQBotConfig::default(),
            feishu: FeishuConfig::default(),
            dingtalk: DingTalkConfig::default(),
            window: WindowSettings::default(),
            speech: SpeechConfig::default(),
            tts: TTSConfig::default(),
            wake_word: None,
            voice_notification: None,
            voice_commands: None,
            web: WebConfig::default(),
            interaction: InteractionConfig::default(),
            dispatch: DispatchConfig::default(),
            spiderman_theme: None,
            chat_display: ChatDisplaySettings::default(),
            workspaces: Vec::new(),
            current_workspace_id: None,
            terminal_scripts: BTreeMap::new(),
            model_profiles: Vec::new(),
            active_model_profile_id: None,
            provider_groups: Vec::new(),
            active_provider_group_id: None,
            skill_paths: Vec::new(),
            performance: default_performance_features(),
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

    /// 获取 Pi CLI 命令路径
    pub fn get_pi_cmd(&self) -> String {
        self.pi_code.cli_path.clone()
    }

    /// 确保 default_engine 与显示设置有效
    pub fn validate(&mut self) {
        if self.default_engine.trim().is_empty() {
            self.default_engine = "claude-code".to_string();
        }
        // 校验 auxiliary_engine：None/空合法（=跟随默认）；非法字符串清空为 None
        if let Some(ref ae) = self.auxiliary_engine {
            if ae.trim().is_empty() {
                self.auxiliary_engine = None;
            }
        }
        self.chat_display.validate();
    }

    /// 获取当前引擎 ID
    pub fn get_engine_id(&self) -> EngineId {
        EngineId::parse_any(&self.default_engine)
    }

    /// 设置默认引擎
    pub fn set_engine_id(&mut self, engine_id: EngineId) {
        self.default_engine = engine_id.as_str().to_string();
    }

    /// 获取辅助任务引擎 ID（标题生成 / 润色等）。
    /// None 或非法 → 返回 None，调用方降级到 `get_engine_id()`。
    pub fn get_auxiliary_engine_id(&self) -> Option<EngineId> {
        self.auxiliary_engine
            .as_ref()
            .and_then(|s| {
                if s.trim().is_empty() {
                    None
                } else {
                    Some(EngineId::parse_any(s))
                }
            })
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

    /// Codex CLI 是否可用
    #[serde(default)]
    pub codex_available: bool,

    /// Codex 版本
    #[serde(default)]
    pub codex_version: Option<String>,

    /// Pi CLI 是否可用
    #[serde(default)]
    pub pi_available: bool,

    /// Pi 版本
    #[serde(default)]
    pub pi_version: Option<String>,

    /// 工作目录
    pub work_dir: Option<String>,

    /// 配置是否有效
    pub config_valid: bool,
}
