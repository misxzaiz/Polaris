use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    pub enabled: bool,
    pub ui_enabled: bool,
    pub mcp_enabled: bool,
}

pub type PluginStateMap = BTreeMap<String, PluginState>;
