//! Plugin 数据模型
//!
//! 用于 Claude CLI 插件管理的数据结构

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// 插件列表结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListResult {
    pub installed: Vec<InstalledPlugin>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<Vec<AvailablePlugin>>,
}

/// 插件发现结果
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryResult {
    pub plugins: Vec<DiscoveredPluginManifest>,
    pub errors: Vec<PluginDiscoveryError>,
}

/// Polaris 本地插件安装位置
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallLocations {
    pub user_path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub discovery_paths: Vec<String>,
}

/// 插件发现错误
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginDiscoveryError {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestValidationResult {
    pub valid: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
    pub errors: Vec<PluginDiscoveryError>,
}

/// 已发现插件 manifest
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredPluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub builtin: bool,
    pub enabled_by_default: bool,
    #[serde(default)]
    pub contributes: PluginManifestContributes,
    #[serde(default)]
    pub permissions: PluginManifestPermissions,
    #[serde(default, skip_serializing_if = "PluginOriginMetadata::is_empty")]
    pub origin: PluginOriginMetadata,
    pub source: PluginManifestSource,
    pub install_path: String,
}

/// 插件来源链接元数据
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginOriginMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
}

impl PluginOriginMetadata {
    pub fn is_empty(&self) -> bool {
        self.repository.is_none()
            && self.homepage.is_none()
            && self.update_url.is_none()
            && self.download_url.is_none()
    }
}

/// 插件来源
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestSource {
    pub kind: PluginManifestSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
}

/// 插件来源类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PluginManifestSourceKind {
    User,
    Project,
}

/// 插件 manifest contributes
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestContributes {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub views: Vec<PluginViewContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mcp_servers: Vec<PluginMcpServerManifestContribution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub services: Vec<PluginServiceManifestContribution>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub panel: Option<PluginPanelContribution>,
    /// 插件声明的引擎
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub engines: Vec<PluginEngineManifestContribution>,
    /// 插件声明的聊天卡片
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub chat_cards: Vec<PluginChatCardManifestContribution>,
    /// 插件声明的工具能力覆盖（替换内置 MCP server 或硬编码工具）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_providers: Vec<PluginToolProviderManifestContribution>,
    /// 插件声明的样式贡献（CSS 注入）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub styles: Vec<PluginStyleManifestContribution>,
    /// 插件配置项 schema（参照 VSCode contributes.configuration）
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub config_schema: Vec<PluginConfigFieldSchemaManifest>,
}

/// 插件配置项 schema（manifest.contributes.configSchema）
///
/// 纯数据描述，可跨 IPC 序列化。设置页据此自动渲染表单。
/// 插件通过 plugin_get_config / plugin_set_config 读写（受 appConfigRead/Write 权限约束）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigFieldSchemaManifest {
    /// 字段 key（插件命名空间内唯一）
    pub key: String,
    /// 人可读标签
    pub label: String,
    /// 字段类型
    #[serde(rename = "type")]
    pub field_type: String,
    /// 默认值
    #[serde(default)]
    pub default: serde_json::Value,
    /// type=select 时的选项
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<PluginConfigSelectOption>,
    /// 是否多行文本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multiline: Option<bool>,
    /// placeholder
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placeholder: Option<String>,
    /// 帮助文本
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// 是否敏感（读取时脱敏）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sensitive: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigSelectOption {
    pub label: String,
    pub value: serde_json::Value,
}

/// 插件样式贡献（manifest.contributes.styles）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginStyleManifestContribution {
    pub id: String,
    pub css: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 插件工具能力覆盖声明
///
/// 声明一个插件要接管哪个内置能力（如 shell / filesystem / compaction 等），
/// 由对应的 mcpServerId 提供实现。MCP 配置解析时，插件声明的 Provider 会
/// 替换同 capability 的内置实现。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginToolProviderManifestContribution {
    /// 能力标识（如 "shell" / "filesystem" / "compaction" / "subagent"）
    pub capability: String,
    /// 提供该能力实现的 MCP server id，必须属于本插件的 mcpServers 声明
    pub mcp_server_id: String,
    /// 覆盖描述（UI 展示用）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// 插件面板贡献
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPanelContribution {
    pub entry: String,
    /// 是否支持全屏模式（隐藏其他面板，自适应填充整个工作区）
    #[serde(default)]
    pub supports_fullscreen: bool,
}

/// 插件 UI contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginViewContribution {
    pub id: String,
    pub area: String,
    pub panel_type: String,
    pub icon: String,
    pub label_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_default: Option<String>,
    pub order: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub badge: Option<String>,
}

/// 插件 MCP server contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerManifestContribution {
    pub id: String,
    pub transport: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args_template: Vec<String>,
}

/// 插件服务 contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginServiceManifestContribution {
    pub id: String,
    #[serde(rename = "type")]
    pub service_type: String,
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args_template: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_check_timeout: Option<u64>,
    #[serde(default = "default_true")]
    pub auto_start: bool,
    #[serde(default = "default_true")]
    pub restart_on_failure: bool,
    #[serde(default = "default_max_restarts")]
    pub max_restarts: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_true() -> bool {
    true
}

fn default_max_restarts() -> u32 {
    3
}

/// 插件引擎 contribution
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineManifestContribution {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub cli: PluginEngineCliContribution,
    /// 可通过 npm 全局安装的包名（如 "@earendil-works/pi-coding-agent"）。
    /// 声明后 AI 引擎设置页自动显示一键安装/卸载按钮。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npm_package: Option<String>,
    /// 安装页面 URL（如 "https://omp.sh/install"）。
    /// 适用于非 npm 分发的引擎，AI 引擎设置页显示「打开安装页面」按钮。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol: Option<String>,
    /// Session ID CLI 标志风格（"pi" / "omp"），缺省时前端按 "pi" 处理
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_flags: Option<String>,
    /// Provider 注册声明（声明式：CLI 如何注册自定义 provider 端点）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_config: Option<PluginEngineProviderConfigManifest>,
    /// MCP 消费策略（"mcp-servers" / "pi-extension" / "mcp-config-path" / "none"），
    /// 缺省时前端按 "mcp-servers" 处理
    #[serde(skip_serializing_if = "Option::is_none", rename = "mcpConsumption")]
    pub mcp_consumption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<PluginEngineCapabilitiesContribution>,
}

/// 插件引擎 provider 注册声明（manifest 层，字符串形式透传给后端 PluginEngineConfig）
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineProviderConfigManifest {
    /// 配置文件路径（相对 CLI 配置根目录，如 "agent/models.yml"）
    pub config_file: String,
    /// 配置文件格式（"yaml" / "json"）
    #[serde(default)]
    pub format: String,
    /// 写入 provider 条目的 API 协议枚举值（如 "openai-completions"）
    pub api_value: String,
    /// 选择 provider 的 CLI 参数名（如 "--provider"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_arg: Option<String>,
    /// 传递 model 名的 CLI 参数名（如 "--model"）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_arg: Option<String>,
    /// CLI 配置根目录的环境变量名
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config_dir_env: Option<String>,
}

/// 插件引擎 CLI 配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineCliContribution {
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_guide: Option<String>,
}

/// 插件引擎能力
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginEngineCapabilitiesContribution {
    #[serde(default)]
    pub tools: bool,
    #[serde(default)]
    pub streaming: bool,
    #[serde(default)]
    pub interrupt: bool,
    #[serde(default)]
    pub resume: bool,
}

/// 插件聊天卡片 contribution
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginChatCardManifestContribution {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entry: Option<String>,
    pub mcp_server_id: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
}

/// 插件权限声明
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestPermissions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_read: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_config_read: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_config_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ai_tool_access: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginManifestFile {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    #[serde(default)]
    pub enabled_by_default: bool,
    #[serde(default)]
    pub contributes: PluginManifestContributes,
    #[serde(default)]
    pub permissions: PluginManifestPermissions,
    #[serde(default)]
    pub origin: PluginOriginMetadata,
}

impl PluginManifestFile {
    pub(crate) fn into_discovered(
        self,
        source: PluginManifestSource,
        install_path: PathBuf,
    ) -> DiscoveredPluginManifest {
        DiscoveredPluginManifest {
            id: self.id,
            name: self.name,
            version: self.version,
            description: self.description,
            builtin: false,
            enabled_by_default: self.enabled_by_default,
            contributes: self.contributes,
            permissions: self.permissions,
            origin: self.origin,
            source,
            install_path: install_path.to_string_lossy().to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateCheckResult {
    pub plugin_id: String,
    pub current_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_version: Option<String>,
    pub update_available: bool,
    pub checked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 已安装插件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPlugin {
    /// 插件 ID (如 figma@claude-plugins-official)
    pub id: String,
    /// 版本号
    pub version: String,
    /// 安装范围 (user, project, local)
    pub scope: String,
    /// 是否启用
    pub enabled: bool,
    /// 安装路径
    pub install_path: String,
    /// 安装时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_at: Option<String>,
    /// 最后更新时间
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<String>,
    /// MCP 服务器配置
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcp_servers: Option<HashMap<String, McpServerConfig>>,
}

/// 可用插件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailablePlugin {
    /// 插件 ID
    pub plugin_id: String,
    /// 插件名称
    pub name: String,
    /// 描述
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// 市场名称
    pub marketplace_name: String,
    /// 来源信息
    pub source: serde_json::Value,
    /// 安装数量
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_count: Option<i32>,
}

/// MCP 服务器配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    /// 服务器类型 (http, stdio)
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub server_type: Option<String>,
    /// HTTP URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// stdio 命令
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// 命令参数
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
}

/// 市场信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marketplace {
    /// 市场名称
    pub name: String,
    /// 来源类型 (github, url)
    pub source: String,
    /// GitHub 仓库
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// 安装位置
    pub install_location: String,
}

/// 插件操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginOperationResult {
    /// 是否成功
    pub success: bool,
    /// 成功消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// 错误消息
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 安装范围
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PluginScope {
    User,
    Project,
    Local,
}

impl PluginScope {
    pub fn as_str(&self) -> &'static str {
        match self {
            PluginScope::User => "user",
            PluginScope::Project => "project",
            PluginScope::Local => "local",
        }
    }
}
