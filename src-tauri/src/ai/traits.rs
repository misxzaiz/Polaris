/*! AI 引擎 Trait 定义
 *
 * 定义所有 AI 引擎必须实现的统一接口。
 *
 * EngineId 是引擎标识的单一来源（Single Source of Truth）。
 * 其他模块通过 `pub use crate::ai::EngineId` 引用，严禁重复定义。
 *
 * ## 动态引擎支持
 *
 * EngineId 现为混合枚举：已知引擎（编译期确定） + Custom(String)（运行时发现）。
 * 插件引擎通过 `EngineId::Custom(id)` 注册，无需修改核心代码。
 * serde 序列化使用 `#[serde(untagged)]`，向后兼容旧格式。
 */

use crate::error::Result;
use crate::models::config::Config;
use crate::models::AIEvent;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;

/// 引擎 ID —— AI 引擎子系统的单一标识来源。
///
/// 混合枚举：已知引擎 + Custom(String) 支持插件注册的动态引擎。
///
/// ## 序列化格式
///
/// 自定义 Serialize/Deserialize，始终序列化为纯字符串（kebab-case）：
/// - 已知引擎：`"claude-code"` / `"codex"` / `"simple-ai"` / `"pi"`
/// - 动态引擎：`"omp"` 等任意字符串
///
/// ## 向后兼容
///
/// `parse()` 接受旧格式（"claude"、"openai_codex" 等），
/// 确保存量会话数据和旧版配置文件不受影响。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum EngineId {
    /// Claude Code 引擎（Anthropic 官方 CLI）
    ClaudeCode,
    /// OpenAI Codex CLI 引擎
    Codex,
    /// Simple AI 引擎（内置轻量助手，直连模型供应商 API）
    SimpleAI,
    /// Pi 引擎（earendil-works pi-coding-agent CLI）
    Pi,
    /// 插件注册的动态引擎（运行时发现）
    Custom(String),
}

impl Serialize for EngineId {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_serialized_string())
    }
}

impl<'de> Deserialize<'de> for EngineId {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let s = String::deserialize(deserializer)?;
        Ok(EngineId::parse_any(&s))
    }
}

impl Default for EngineId {
    fn default() -> Self {
        EngineId::ClaudeCode
    }
}

impl EngineId {
    /// 序列化到配置文件/API 的权威字符串表示（kebab-case）。
    pub fn as_serialized_str(&self) -> &str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
            Self::SimpleAI => "simple-ai",
            Self::Pi => "pi",
            Self::Custom(_) => "custom",
        }
    }

    /// 返回引擎 ID 作为字符串（用于序列化到 JSON 等）
    pub fn to_serialized_string(&self) -> String {
        self.as_str()
    }

    /// 从字符串解析已知引擎 ID。
    ///
    /// 仅识别已知引擎别名（claude/codex/pi/simple-ai），未知字符串返回 None。
    /// 想要接受动态（Custom）引擎的场景请使用 `parse_any`。
    /// 解析不区分大小写，兼容历史格式。
    pub fn parse(s: &str) -> Option<Self> {
        let lower = s.to_lowercase();
        Self::known().iter()
            .find(|e| e.aliases().contains(&lower.as_str()))
            .cloned()
    }

    /// 从字符串解析引擎 ID，未知字符串作为 Custom 引擎。
    ///
    /// 用于序列化反序列化及前端传入的引擎 ID（信任前端已通过 registry 校验）。
    pub fn parse_any(s: &str) -> Self {
        Self::parse(s).unwrap_or_else(|| {
            // 处理 Custom 内部携带的字符串（反序列化旧数据时避免二次包装）
            if let Some(inner) = s.strip_prefix("Custom(") {
                if let Some(rest) = inner.strip_suffix(')') {
                    return EngineId::Custom(rest.to_string());
                }
            }
            EngineId::Custom(s.to_string())
        })
    }

    /// 返回已知引擎数组（不含 Custom）
    pub fn known() -> &'static [EngineId] {
        &[
            EngineId::ClaudeCode,
            EngineId::Codex,
            EngineId::Pi,
            EngineId::SimpleAI,
        ]
    }

    /// 返回该引擎的所有命令别名（用于 IM 命令解析和配置兼容）。
    pub fn aliases(&self) -> Vec<&str> {
        match self {
            Self::ClaudeCode => vec!["claude", "claude-code", "claudecode"],
            Self::Codex => vec!["codex", "openai-codex", "openai_codex"],
            Self::Pi => vec!["pi", "pi-coding-agent", "piagent"],
            Self::SimpleAI => vec!["simple-ai", "simpleai", "simple_ai"],
            Self::Custom(id) => vec![id.as_str()],
        }
    }

    /// 返回引擎 ID 的规范字符串表示。
    pub fn as_str(&self) -> String {
        match self {
            Self::ClaudeCode => "claude-code".to_string(),
            Self::Codex => "codex".to_string(),
            Self::SimpleAI => "simple-ai".to_string(),
            Self::Pi => "pi".to_string(),
            Self::Custom(id) => id.clone(),
        }
    }

    /// 获取简短显示名称（用于日志和 UI 展示）
    pub fn display_name(&self) -> String {
        match self {
            Self::ClaudeCode => "Claude Code".to_string(),
            Self::Codex => "OpenAI Codex".to_string(),
            Self::SimpleAI => "Simple AI".to_string(),
            Self::Pi => "Pi".to_string(),
            Self::Custom(id) => id.clone(),
        }
    }

    /// 所有已知引擎 ID + 动态引擎 ID 的迭代器。
    pub fn all() -> Vec<EngineId> {
        Self::known().to_vec()
    }

    /// 判断是否为已知引擎（非 Custom）
    pub fn is_known(&self) -> bool {
        matches!(self, Self::ClaudeCode | Self::Codex | Self::Pi | Self::SimpleAI)
    }
}

impl std::fmt::Display for EngineId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.as_str())
    }
}

/// 插件引擎配置 —— 描述一个通过插件注册的动态 AI 引擎。
/// MCP 消费策略 —— 插件引擎如何桥接 MCP 工具到子进程。
///
/// 不同引擎家族对 MCP 的消费方式不同，由插件 manifest 声明：
/// - `McpServers`（默认）：直接注入 mcp_servers 列表（SimpleAI 风格，in-process 消费）。
///   适用于引擎自身会通过 stdio 与 MCP server 通信的场景。
/// - `PiExtension`：Pi Extension 桥接风格。
///   写 JS Extension 文件 + `--extension` 注入，子进程通过 `pi.registerTool()` 注册工具。
///   适用于 OMP/Pi 等兼容 Pi Extension API 的 CLI。
/// - `McpConfigPath`：配置文件路径风格。
///   写 MCP 配置文件（JSON）+ `--mcp-config <path>` 注入，Claude Code 风格。
/// - `None`：引擎不支持 MCP 工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum McpConsumptionStrategy {
    /// 直接注入 mcp_servers 列表（SimpleAI 风格，in-process 消费）
    #[default]
    McpServers,
    /// Pi Extension 桥接：写 JS Extension + --extension
    PiExtension,
    /// 配置文件路径：写 JSON + --mcp-config
    McpConfigPath,
    /// 不消费 MCP
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineConfig {
    /// 引擎 ID（如 "omp"）
    pub id: String,
    /// 显示名称（如 "Oh My Pi"）
    pub name: String,
    /// 引擎描述
    pub description: String,
    /// CLI 命令或路径
    pub cli: EngineCliConfig,
    /// RPC 协议类型
    #[serde(default)]
    pub protocol: RpcProtocol,
    /// 引擎能力
    #[serde(default)]
    pub capabilities: PluginEngineCapabilities,
    /// Session ID CLI 标志风格（默认 Pi 风格）
    #[serde(default, rename = "sessionFlags")]
    pub session_flags: SessionFlags,
    /// Provider 注册声明（声明式：CLI 如何注册自定义 provider 端点）
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "providerConfig")]
    pub provider_config: Option<ProviderConfigDeclaration>,
    /// 可通过 npm 全局安装/卸载的包名（如 "@earendil-works/pi-coding-agent"）。
    /// 声明后 AI 引擎设置页自动显示一键安装/卸载按钮。
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "npmPackage")]
    pub npm_package: Option<String>,
    /// 安装页面 URL（如 "https://omp.sh/install"）。
    /// 适用于非 npm 分发的引擎，AI 引擎设置页显示「打开安装页面」按钮。
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "installUrl")]
    pub install_url: Option<String>,
    /// MCP 消费策略（默认 McpServers，向后兼容）
    #[serde(default, rename = "mcpConsumption")]
    pub mcp_consumption: McpConsumptionStrategy,
    /// 是否启用 MCP 桥接。当 false 时，即使 mcp_consumption 为 PiExtension，
    /// 也不写入桥接文件、不注入 --extension。
    /// 默认 true：后端行为不变，由前端根据插件 mcpEnabled 状态控制。
    #[serde(default, rename = "mcpEnabled")]
    pub mcp_enabled: bool,
    /// 适配器进程声明（存在时走 PluginProcessEngine，否则走 PluginEngineRunner）
    /// 插件引擎通过适配器进程与 Polaris 通信，实现"加引擎不改核心"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adapter: Option<PluginEngineAdapterDecl>,
    /// 插件安装路径（前端注册时注入，用于解析适配器入口等相对路径）
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "installPath")]
    pub install_path: Option<String>,
}

/// 适配器进程声明 —— 描述插件引擎适配器进程的入口与协议。
///
/// 加新引擎只需在插件包中声明适配器进程，Polaris 核心通过 `PluginProcessEngine`
/// 自动适配，无需修改核心代码。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineAdapterDecl {
    /// 适配器入口（相对插件 installPath 的可执行文件路径）
    pub entry: String,
    /// 运行 runtime（"node" / "python3" / "deno" / 空=直接可执行）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// 协议版本（当前为 "engine-v1"）
    pub protocol: String,
}

/// Provider 注册声明（声明式 provider 注册）
///
/// 不同 Pi fork / CLI 注册自定义 provider 端点的方式不同：
/// - Pi: 写 `~/.pi/agent/models.json`，`api="openai-chat-completions"`，用 `--provider`/`--model` 选择
/// - omp: 写 `~/.omp/agent/models.yml`，`api="openai-completions"`，用 `--provider`/`--model` 选择
///
/// 由插件 manifest 声明，PluginEngine 据此写配置文件并传 CLI 参数。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfigDeclaration {
    /// 配置文件路径（相对 CLI 配置根目录，如 "agent/models.yml"）
    pub config_file: String,
    /// 配置文件格式
    #[serde(default)]
    pub format: ProviderConfigFormat,
    /// 写入 provider 条目的 API 协议枚举值（如 "openai-completions"）
    pub api_value: String,
    /// 选择 provider 的 CLI 参数名（如 "--provider"），缺省则不传
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_arg: Option<String>,
    /// 传递 model 名的 CLI 参数名（如 "--model"），缺省则不传
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_arg: Option<String>,
    /// CLI 配置根目录的环境变量名（缺省则按 CLI id 推断 ~/.<id>/）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir_env: Option<String>,
}

/// Provider 配置文件格式
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderConfigFormat {
    /// YAML 格式（omp 用 models.yml）
    Yaml,
    /// JSON 格式（Pi 用 models.json）
    Json,
}

impl Default for ProviderConfigFormat {
    fn default() -> Self {
        Self::Yaml
    }
}

/// CLI 入口配置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCliConfig {
    /// 命令（如 "omp"）
    pub command: String,
    /// 启动参数
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    /// 安装指引
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_guide: Option<String>,
}

/// RPC 协议类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RpcProtocol {
    /// Pi 兼容的 --mode rpc JSONL 协议
    PiRpc,
    /// 标准 stdio JSON-RPC 协议
    JsonRpc,
    /// 简单命令执行
    Command,
}

impl Default for RpcProtocol {
    fn default() -> Self {
        Self::PiRpc
    }
}

/// Session ID CLI 标志风格
///
/// 不同 CLI 对 session 管理的命令行标志不同：
/// - Pi: `--session-id <id>` (新会话), `--session <id>` (恢复)
/// - omp: 无 session-id 标志 (新会话), `--resume <id>` (恢复)
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionFlags {
    /// Pi 风格：--session-id / --session
    Pi,
    /// omp 风格：无 session-id / --resume
    Omp,
}

impl Default for SessionFlags {
    fn default() -> Self {
        Self::Pi
    }
}

/// 插件引擎能力标志
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineCapabilities {
    /// 是否支持工具调用
    #[serde(default = "default_true")]
    pub tools: bool,
    /// 是否支持流式输出
    #[serde(default = "default_true")]
    pub streaming: bool,
    /// 是否支持中断
    #[serde(default = "default_true")]
    pub interrupt: bool,
    /// 是否支持恢复会话
    #[serde(default = "default_true")]
    pub resume: bool,
}

fn default_true() -> bool { true }

impl Default for PluginEngineCapabilities {
    fn default() -> Self {
        Self {
            tools: true,
            streaming: true,
            interrupt: true,
            resume: true,
        }
    }
}

/// 会话选项
#[derive(Clone)]
pub struct SessionOptions {
    /// 工作目录
    pub work_dir: Option<String>,
    /// 系统提示词（用户自定义，会覆盖默认部分）
    pub system_prompt: Option<String>,
    /// 追加到默认系统提示词的内容（工作区信息等，始终追加）
    pub append_system_prompt: Option<String>,
    /// Claude Code MCP 配置文件路径
    pub mcp_config_path: Option<String>,
    /// SimpleAI 直接消费的 MCP server 列表（Phase 4b；CLI 引擎忽略，仍走 mcp_config_path）
    pub mcp_servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer>,
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

    /// Pi 引擎专用：写入 `~/.pi/agent/models.json` 的 provider 配置。
    /// 非 None 时，PiEngine 会在启动前写入/更新 models.json，
    /// 并通过 `--provider <name>` 让 pi 使用该端点。
    pub pi_provider_config: Option<PiProviderConfig>,

    /// Pi 引擎专用：已剥离 CLI 私有后缀（如 `[1m]`）的纯模型名。
    /// 非 None 时 PiEngine 用此值替代 `model` 字段传给 `--model`。
    pub pi_model: Option<String>,
}

/// Pi 引擎通过 `~/.pi/agent/models.json` 注册自定义 provider 的配置。
#[derive(Debug, Clone, Default)]
pub struct PiProviderConfig {
    /// 在 models.json 中使用的 provider 标识名（需唯一，通常用 Profile 名 + id）
    pub name: String,
    /// 端点 URL（如 `http://120.79.164.155:9850/v1`）
    pub base_url: String,
    /// 用于 `--api-key` 的 API key
    pub api_key: String,
    /// pi 的 API 类型（`openai-completions` / `anthropic-messages` / 等）
    pub api: String,
    /// 上下文窗口（用于注册模型元数据）
    pub context_window: u64,
    /// 最大输出 token（用于注册模型元数据）
    pub max_tokens: u32,
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
            mcp_servers: Vec::new(),
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
            pi_provider_config: None,
            pi_model: None,
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

    /// 设置 SimpleAI 直接消费的 MCP server 列表（Phase 4b）
    pub fn with_mcp_servers(
        mut self,
        servers: Vec<crate::services::mcp_config_service::ResolvedExternalMcpServer>,
    ) -> Self {
        self.mcp_servers = servers;
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

    /// 设置 Pi provider 配置（写入 models.json）
    pub fn with_pi_provider_config(mut self, config: PiProviderConfig) -> Self {
        self.pi_provider_config = Some(config);
        self
    }

    /// 设置 Pi 纯模型名（已剥离 CLI 私有后缀）
    pub fn with_pi_model(mut self, model: impl Into<String>) -> Self {
        self.pi_model = Some(model.into());
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
            install_guide: None,
            npm_package: None,
            install_url: None,
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

    /// 启动前的预检查/重准备工作（可选）。
    ///
    /// 在 `engine_registry` 锁临界区**之外**调用，用于执行可能耗时的引擎就绪
    /// 准备（如依赖目录桥接、缓存预热）。默认空实现；需要预准备的引擎覆写。
    ///
    /// 幂等：实现方应保证多次调用安全，首次执行后后续调用快速返回。
    fn prepare_preflight(&self) -> Result<()> {
        Ok(())
    }

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

    /// 清理引擎资源（动态分发，用于 Box<dyn AIEngine> 场景）
    fn cleanup_dyn(&mut self) -> Option<Box<dyn FnOnce() + Send>> {
        None
    }
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
    /// 安装指引（插件引擎 CLI 安装说明）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_guide: Option<String>,
    /// 可通过 npm 全局安装的包名（如 "@earendil-works/pi-coding-agent"）。
    /// 声明后 AI 引擎设置页自动显示一键安装/卸载按钮。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_package: Option<String>,
    /// 安装页面 URL（如 "https://omp.sh/install"）。
    /// 适用于非 npm 分发的引擎，AI 引擎设置页显示「打开安装页面」按钮。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
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
