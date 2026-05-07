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
}

impl PluginOriginMetadata {
    pub fn is_empty(&self) -> bool {
        self.repository.is_none() && self.homepage.is_none() && self.update_url.is_none()
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
