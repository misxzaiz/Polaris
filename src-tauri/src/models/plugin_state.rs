use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub enabled: bool,
    pub ui_enabled: bool,
    pub mcp_enabled: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_servers: BTreeMap<String, PluginMcpServerState>,
    /// per-tool 注入开关（P3 工具注入管理面）：tool_name → enabled。
    /// 缺省空 = 全放行（向后兼容，spec §6「缺省全放行」）；显式 false 才挡。
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub mcp_tool_gates: BTreeMap<String, bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMcpServerState {
    pub enabled: bool,
}

pub type PluginStateMap = BTreeMap<String, PluginState>;
