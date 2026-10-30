use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::models::plugin::PluginDevLinkMetadata;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub enabled: bool,
    pub ui_enabled: bool,
    pub mcp_enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, PluginMcpServerState>,
    /// per-tool 注入门（P3 工具注入管理面）：tool_name → enabled。
    /// 缺省空 = 全放行（向后兼容，spec §6「缺省全放行」）；显式 false 才挡。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_tool_gates: BTreeMap<String, bool>,
    /// dev-link 直连信息（needs/001）：Some 即 dev 插件——更新检查/应用更新短路，
    /// 卸载只删链接本体、零触碰源码目录。本字段是 dev 身份的唯一权威。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_link: Option<PluginDevLinkMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerState {
    pub enabled: bool,
}

pub type PluginStateMap = BTreeMap<String, PluginState>;
