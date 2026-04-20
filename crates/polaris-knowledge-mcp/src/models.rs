//! Knowledge index and module data structures.

use serde::{Deserialize, Serialize};

/// Knowledge index structure (mirrors .polaris/knowledge/index.json)
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct KnowledgeIndex {
    pub version: String,
    pub modules: Vec<ModuleEntry>,
}

/// Module entry in the knowledge index.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ModuleEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub scope: Vec<String>,
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub dependents: Vec<String>,
    pub file: String,
    pub complexity: String,
    #[serde(rename = "changeFrequency")]
    pub change_frequency: String,
}
