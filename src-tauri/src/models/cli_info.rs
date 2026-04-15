//! CLI 信息数据模型
//!
//! 用于 CLI 动态查询（agents、auth status 等）的数据结构

use serde::{Deserialize, Serialize};

/// CLI Agent 信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAgentInfo {
    /// Agent ID (如 "general-purpose", "pua:cto-p10")
    pub id: String,
    /// Agent 显示名称
    pub name: String,
    /// Agent 来源 ("builtin" | "plugin")
    pub source: String,
    /// 默认模型 (None 表示 inherit)
    pub default_model: Option<String>,
}

/// CLI 认证状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAuthStatus {
    /// 是否已登录
    pub logged_in: bool,
    /// 认证方式 (如 "oauth_token", "api_key")
    pub auth_method: String,
    /// API 提供商 (如 "firstParty", "bedrock", "vertex")
    pub api_provider: String,
}

/// CLI 动态信息汇总
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliDynamicInfo {
    /// Agent 列表
    pub agents: Vec<CliAgentInfo>,
    /// 认证状态
    pub auth_status: Option<CliAuthStatus>,
    /// CLI 版本
    pub version: Option<String>,
}
