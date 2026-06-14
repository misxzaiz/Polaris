/*! AI 引擎 Trait 定义
 *
 * 定义所有 AI 引擎必须实现的统一接口。
 *
 * EngineId 是引擎标识的单一来源（Single Source of Truth）。
 * 其他模块通过 `pub use crate::ai::EngineId` 引用，严禁重复定义。
 */

use crate::error::Result;
use crate::models::config::Config;
use crate::models::AIEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// 引擎 ID —— AI 引擎子系统的单一标识来源。
///
/// ## 序列化格式
///
/// `#[serde(rename_all = "kebab-case")]` 确保与前端及配置文件中的
/// kebab-case 字符串一致：
/// - `ClaudeCode` → `"claude-code"`
/// - `Codex`      → `"codex"`
/// - `SimpleAI`   → `"simple-ai"` （显式 rename，防止 kebab-case 将
///   "AI" 拆为 "a-i"）
/// - `MimoCode`   → `"mimo-code"`
///
/// ## 向后兼容
///
/// `parse()` 接受旧格式（"claude"、"openai_codex" 等），
/// 确保存量会话数据和旧版配置文件不受影响。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum EngineId {
    /// Claude Code 引擎（Anthropic 官方 CLI）
    #[default]
    ClaudeCode,
    /// OpenAI Codex CLI 引擎
    Codex,
    /// Simple AI 引擎（内置轻量助手，直连模型供应商 API）
    #[serde(rename = "simple-ai")]
    SimpleAI,
    /// Mimo Code 引擎（mimocode CLI）
    MimoCode,
}

impl EngineId {
    /// 从字符串解析引擎 ID。
    ///
    /// 解析不区分大小写，兼容历史格式：
    /// - `"claude" | "claude-code" | "claudecode"` → `ClaudeCode`
    /// - `"codex" | "openai-codex" | "openai_codex"` → `Codex`
    /// - `"simple-ai" | "simpleai" | "simple_ai"` → `SimpleAI`
    /// - `"mimo" | "mimo-code" | "mimocode"` → `MimoCode`
    pub fn parse(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        match lower.as_str() {
            "claude" | "claude-code" | "claudecode" => Some(Self::ClaudeCode),
            "codex" | "openai-codex" | "openai_codex" => Some(Self::Codex),
            "simple-ai" | "simpleai" | "simple_ai" => Some(Self::SimpleAI),
            "mimo" | "mimo-code" | "mimocode" => Some(Self::MimoCode),
            _ => None,
        }
    }

    /// 返回引擎 ID 的规范字符串表示（kebab-case）。
    ///
    /// 此方法是序列化到配置文件、数据库和 API 响应的权威格式。
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::SimpleAI => "simple-ai",
            Self::MimoCode => "mimo-code",
        }
    }

    /// 获取简短显示名称（用于日志和 UI 展示）
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "OpenAI Codex",
            Self::SimpleAI => "Simple AI",
            Self::MimoCode => "Mimo Code",
        }
    }

    /// 所有已知引擎 ID 的迭代器
    pub fn all() -> &'static [EngineId] {
        &[
            EngineId::ClaudeCode,
            EngineId::Codex,
            EngineId::SimpleAI,
            EngineId::MimoCode,
        ]
    }
}

impl std::fmt::Display for EngineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
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
    /// 禁用的工具列表（通过 --disallowedTools 传递）
    pub disallowed_tools: Vec<String>,
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
            disallowed_tools: Vec::new(),
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

    /// 设置禁用的工具列表
    pub fn with_disallowed_tools(mut self, tools: Vec<String>) -> Self {
        self.disallowed_tools = tools;
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

    /// 获取引擎元数据。
    ///
    /// 每个引擎实现通过此方法对外暴露版本号、分发方式、能力矩阵、
    /// 环境变量映射等静态信息。EngineRegistry 和前端设置页面通过此
    /// 方法发现引擎能力，无需预置中央注册表。
    fn metadata(&self) -> EngineMetadata {
        EngineMetadata {
            id: self.id(),
            name: self.name().into(),
            description: if self.description().is_empty() {
                None
            } else {
                Some(self.description().into())
            },
            distribution: EngineDistribution::CustomPath {
                path: String::new(),
                available: self.is_available(),
            },
            capabilities: EngineCapabilities::default(),
            env_keys: EnvKeyMapping::default(),
            supports_model_provider: false,
        }
    }

    /// 获取引擎版本号。
    ///
    /// 引擎应执行 `{cli} --version` 获取实际版本；内置引擎返回 crate 版本。
    fn version(&self) -> Option<String> {
        None
    }

    /// 检查引擎是否可用
    fn is_available(&self) -> bool;

    /// 获取不可用原因
    fn unavailable_reason(&self) -> Option<String> {
        None
    }

    // ... rest of existing methods ...
    fn start_session(&mut self, message: &str, options: SessionOptions) -> Result<String>;

    fn continue_session(
        &mut self,
        session_id: &str,
        message: &str,
        options: SessionOptions,
    ) -> Result<()>;

    fn interrupt(&mut self, session_id: &str) -> Result<()>;

    fn send_input(&mut self, _session_id: &str, _input: &str) -> Result<bool> {
        Ok(false)
    }

    fn active_session_count(&self) -> usize {
        0
    }

    fn has_active_session(&self, _session_id: &str) -> bool {
        false
    }

    fn update_config(&mut self, _new_config: Config) {}
}

// ============================================================================
// 引擎元数据 —— 替代 codeg 式的中央 registry，通过 trait 方法分发
// ============================================================================

/// 引擎元数据 —— 描述一个 AI 引擎的静态属性。
///
/// 与 codeg 的 `AcpAgentMeta` + 中央 `get_agent_meta()` 不同，
/// Polaris 通过 `AIEngine::metadata()` trait 方法分发元数据，
/// 新增引擎时无需修改中央注册表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineMetadata {
    pub id: EngineId,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub distribution: EngineDistribution,
    pub capabilities: EngineCapabilities,
    pub env_keys: EnvKeyMapping,
    /// 是否支持通过 model_provider 切换 API 端点
    pub supports_model_provider: bool,
}

/// 引擎分发方式。
///
/// 简化版：合并 codeg 的 Npx/Binary/Uvx 为可执行分发，
/// 另设 Builtin 表示无需外部 CLI 的内置引擎。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum EngineDistribution {
    /// 通过包管理器运行（npx / uvx）
    PackageRunner {
        /// 包规格，如 "@anthropic/claude-code@1.0.0"
        package: String,
        /// 入口命令
        cmd: String,
        /// 启动参数
        args: Vec<String>,
        /// 最小运行时版本要求
        runtime_min_version: Option<String>,
    },
    /// 平台二进制文件（自动下载）
    Binary {
        version: String,
        /// 命令名（PATH 中可执行文件）
        cmd: String,
        /// 启动参数
        args: Vec<String>,
        /// 各平台下载 URL
        platforms: Vec<PlatformBinary>,
    },
    /// 内置引擎（无需外部 CLI）
    Builtin,
    /// 用户自定义路径
    CustomPath {
        /// CLI 路径
        path: String,
        /// 路径是否有效
        available: bool,
    },
}

/// 平台二进制下载信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformBinary {
    /// 平台标识（"windows-x86_64" / "darwin-aarch64" / "linux-x86_64"）
    pub platform: String,
    /// 下载 URL
    pub url: String,
}

/// 引擎能力标志位。
///
/// 使用位掩码而非独立 bool 字段，便于扩展和序列化。
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    /// 是否支持工具调用（bash / 文件操作 等）
    pub tools: bool,
    /// 是否支持图片输入（多模态）
    pub image_input: bool,
    /// 是否支持流式输出
    pub streaming: bool,
    /// 是否支持中断正在运行的会话
    pub interrupt: bool,
    /// 是否支持续接历史会话
    pub resume: bool,
    /// 是否支持 stdin 交互输入
    pub stdin_input: bool,
    /// 是否支持 fork 会话
    pub fork_session: bool,
}

/// 环境变量 key 映射。
///
/// 每个引擎的认证/端点配置使用不同的环境变量名。
/// 此映射指导 model_provider 的级联写入逻辑，
/// 确保凭证注入到正确的环境变量。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvKeyMapping {
    /// API 端点 URL 变量名（如 "ANTHROPIC_BASE_URL"）
    pub base_url: &'static str,
    /// API 密钥变量名（如 "ANTHROPIC_AUTH_TOKEN"）
    pub api_key: &'static str,
    /// 模型变量名（如 "ANTHROPIC_MODEL"）
    pub model: &'static str,
}

impl Default for EnvKeyMapping {
    fn default() -> Self {
        Self {
            base_url: "OPENAI_BASE_URL",
            api_key: "OPENAI_API_KEY",
            model: "OPENAI_MODEL",
        }
    }
}
